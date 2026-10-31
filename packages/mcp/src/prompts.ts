// Prompts (our playbook): write_post, pick_clips, weekly_review. They load the user's data through
// @app/services and return one user message with the rules, so every AI produces the same results.

import { completable } from '@modelcontextprotocol/sdk/server/completable.js'
import { McpError, ErrorCode, type GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isAppError } from '@app/core/errors'
import { PLATFORM_RULES, type PlatformRules, type TextUnit } from '@app/core/platforms'
import { formatMs } from '@app/core/time'
import { PLATFORM_LABELS, PlatformSchema, type Platform } from '@app/core/types'
import { IdSchema, MAX_CLIP_RANGES } from '@app/core/validation'
import { isClipSource, type VoiceProfileView, type VoiceSample } from '@app/services'
import type { McpContext } from './context'
import { GENERIC_ERROR, modelMessage } from './errors'
import { pageSegments, pickClipsRules, WEEKLY_REVIEW_STEPS, weeklyReviewText } from './playbook'
import { excerpt } from './results'

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function userMessage(description: string, text: string): GetPromptResult {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] }
}

/** Prompt errors are JSON-RPC errors (-32602 for bad arguments / unknown ids). */
function promptError(error: unknown, ctx: McpContext, prompt: string): McpError {
  if (error instanceof McpError) return error
  if (isAppError(error)) {
    const invalid = error.code === 'validation' || error.code === 'not_found' || error.code === 'bad_request'
    return new McpError(invalid ? ErrorCode.InvalidParams : ErrorCode.InternalError, modelMessage(error))
  }
  ctx.log?.error('mcp prompt crashed', { prompt, err: error instanceof Error ? error : String(error) })
  return new McpError(ErrorCode.InternalError, GENERIC_ERROR)
}

function parseId(value: string | undefined, name: string): string {
  const parsed = IdSchema.safeParse(value)
  if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, `${name} must be an id (UUID), e.g. a brandId from list_accounts.`)
  return parsed.data
}

/**
 * The brand a prompt is for: an id, a brand name (what the prompt form's completion offers;
 * case-insensitive), or nothing when the user has exactly one active brand.
 */
async function resolveBrandId(ctx: McpContext, value: string | undefined): Promise<string> {
  const raw = (value ?? '').trim()
  const asId = IdSchema.safeParse(raw)
  if (asId.success) return asId.data
  const brands = await ctx.services.brands.list(ctx.userId, { status: 'active' })
  if (raw === '') {
    if (brands.length === 1 && brands[0]) return brands[0].id
    if (brands.length === 0) throw new McpError(ErrorCode.InvalidParams, 'There is no active brand yet. Create one in the web app first.')
    throw new McpError(ErrorCode.InvalidParams, `Choose a brand: ${brands.map((b) => `"${b.name}"`).join(', ')}.`)
  }
  const matches = brands.filter((b) => b.name.toLowerCase() === raw.toLowerCase())
  if (matches.length === 1 && matches[0]) return matches[0].id
  throw new McpError(ErrorCode.InvalidParams, `No single active brand is called "${raw.slice(0, 60)}". Brands: ${brands.map((b) => `"${b.name}"`).join(', ') || 'none'}.`)
}

/** The source video a prompt is for: an id, or nothing for the newest source video. */
async function resolveSourceId(ctx: McpContext, value: string | undefined): Promise<string> {
  const raw = (value ?? '').trim()
  if (raw !== '') return parseId(raw, 'media_id')
  const page = await ctx.services.media.list(ctx.userId, { kind: 'video', status: 'ready', limit: 50 })
  const newest = page.items.find((m) => isClipSource(m))
  if (!newest) throw new McpError(ErrorCode.InvalidParams, 'There is no source video yet. Upload one on the Media page of the web app first.')
  return newest.id
}

/**
 * An optional, completable prompt argument. The SDK (1.32) looks for the completer on the inner
 * schema when it registers the prompt but on the outer one when it answers completion/complete,
 * so both carry it.
 */
function optionalCompletable(description: string, complete: (value: string) => Promise<string[]>) {
  const cb = async (value: string | undefined) => complete((value ?? '').trim().toLowerCase())
  return completable(completable(z.string(), cb).optional().describe(description), cb)
}

/** Prompt-form completion: the user's active brand names starting with what was typed. */
function brandArg(ctx: McpContext) {
  return optionalCompletable('The brand: its name or id (from list_accounts). Optional when there is one brand.', async (typed) => {
    const brands = await ctx.services.brands.list(ctx.userId, { status: 'active' }).catch(() => [])
    return brands.map((b) => b.name).filter((n) => n.toLowerCase().startsWith(typed)).slice(0, 20)
  })
}

/** Prompt-form completion: the ids of the user's newest source videos. */
function sourceArg(ctx: McpContext) {
  return optionalCompletable('The source video id (from get_transcript without arguments). Default: the newest source video.', async (typed) => {
    const page = await ctx.services.media.list(ctx.userId, { kind: 'video', status: 'ready', limit: 50 }).catch(() => ({ items: [] }))
    return page.items.filter((m) => isClipSource(m) && m.id.startsWith(typed)).map((m) => m.id).slice(0, 20)
  })
}

function parsePlatforms(value: string | undefined): Platform[] | null {
  if (value === undefined || value.trim() === '') return null
  const out: Platform[] = []
  for (const raw of value.split(/[\s,]+/).filter(Boolean)) {
    const parsed = PlatformSchema.safeParse(raw.toLowerCase())
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown platform "${raw.slice(0, 30)}". Use: ${Object.keys(PLATFORM_LABELS).join(', ')}.`)
    }
    if (!out.includes(parsed.data)) out.push(parsed.data)
  }
  return out
}

const UNIT: Record<TextUnit, string> = {
  utf16: 'characters',
  graphemes: 'characters',
  utf8_bytes: 'bytes (UTF-8; emoji and accents count more)',
  x_weighted: 'weighted characters (links count 23, emoji 2)',
}

const n = (x: number) => x.toLocaleString('en-US')

/** One line of platform rules from core PLATFORM_RULES. */
export function platformRulesText(rules: PlatformRules): string {
  const parts: string[] = []
  parts.push(`text ≤ ${rules.text.map((t) => `${n(t.max)} ${UNIT[t.unit]}`).join(' and ≤ ')}`)
  if (rules.title) parts.push(`title ${rules.title.required ? 'required' : 'optional'}, ≤ ${n(rules.title.max)} characters`)
  if (!rules.textOnly) parts.push('needs a video or images')
  if (rules.video) parts.push(`video ${formatSec(rules.video.minMs)}–${formatSec(rules.video.maxMs)}`)
  if (rules.image) parts.push(`${rules.image.min}–${rules.image.max} images`)
  if (!rules.linksAllowed) parts.push('NO links (they are stripped)')
  else if (rules.maxLinks !== null) parts.push(`≤ ${rules.maxLinks} links`)
  if (rules.maxHashtags !== null) parts.push(`≤ ${rules.maxHashtags} hashtags`)
  if (rules.maxMentions !== null) parts.push(`≤ ${rules.maxMentions} mentions`)
  parts.push(`≤ ${rules.capPer24h} posts per account per 24 h`)
  return `- ${PLATFORM_LABELS[rules.platform]}: ${parts.join('; ')}.`
}

function formatSec(ms: number): string {
  if (ms >= 3_600_000) return `${ms / 3_600_000} h`
  if (ms >= 60_000) return `${ms / 60_000} min`
  return `${ms / 1000} s`
}

function voiceText(voice: VoiceProfileView | null, samples: readonly VoiceSample[]): string {
  const lines: string[] = []
  if (!voice) {
    lines.push('No voice profile saved yet. Write in a clear, friendly, specific style, and offer to build a profile (save_voice_profile) from the user\'s answers or imported posts (import_past_posts).')
  } else {
    const p = voice.profile
    lines.push(`Voice profile (version ${voice.version}, ${voice.source}):`)
    if (p.tone) lines.push(`- Tone: ${p.tone}`)
    if (p.audience) lines.push(`- Audience: ${p.audience}`)
    if (p.vocabulary.length > 0) lines.push(`- Vocabulary: ${p.vocabulary.join('; ')}`)
    if (p.do.length > 0) lines.push(`- Do: ${p.do.join('; ')}`)
    if (p.dont.length > 0) lines.push(`- Don't: ${p.dont.join('; ')}`)
    lines.push(`- Emoji: ${p.emoji_policy}. Hashtags: ${p.hashtag_policy}.`)
    for (const s of p.sample_posts.slice(0, 10)) lines.push(`- Sample${s.platform ? ` (${PLATFORM_LABELS[s.platform]})` : ''}: """${s.text}"""`)
  }
  if (samples.length > 0) {
    lines.push('Best-performing past posts (match their voice, not their exact words):')
    for (const s of samples) lines.push(`- ${PLATFORM_LABELS[s.platform]}: """${excerpt(s.text, 600)}"""`)
  }
  return lines.join('\n')
}

/**
 * The brand's writing brief for the model (list_accounts with a brandId): the voice profile, the
 * best imported posts, and the rules of its connected platforms. The model cannot load the
 * write_post prompt itself, so this is how the voice reaches every create_draft.
 */
export async function brandWritingBrief(ctx: McpContext, brand: { id: string; name: string }, connected: readonly Platform[]) {
  const [voice, samples] = await Promise.all([
    ctx.services.voice.get(ctx.userId, brand.id),
    ctx.services.voice.importedSamples(ctx.userId, brand.id, { limit: 5 }),
  ])
  const text = [
    `## Writing for "${brand.name}": read this before every create_draft`,
    voiceText(voice, samples),
    ...(connected.length > 0 ? ['Platform rules (hard limits; stay well under them):', ...connected.map((p) => platformRulesText(PLATFORM_RULES[p]))] : []),
    'Write one variant per platform (hook first, one idea, a clear call to action), use only facts the user gave you, and follow the voice above.',
    voice
      ? 'save_voice_profile replaces the whole profile: to change one rule, send the full profile above with your change (structuredContent.voiceProfile.profile).'
      : 'To save a voice profile, call save_voice_profile with the full profile.',
  ].join('\n')
  return { text, voiceProfile: voice ? { version: voice.version, source: voice.source, profile: voice.profile } : null }
}

// ---------------------------------------------------------------------------------------------
// write_post
// ---------------------------------------------------------------------------------------------

export function writePostArgs(ctx: McpContext) {
  return {
    brand_id: brandArg(ctx),
    topic: z.string().describe('What the post is about (and any facts, links or offers to include).'),
    platforms: z.string().optional().describe('Comma-separated platforms, e.g. "instagram, linkedin, x". Default: the brand\'s connected accounts.'),
  }
}

export async function writePostPrompt(ctx: McpContext, args: { brand_id?: string | undefined; topic: string; platforms?: string | undefined }): Promise<GetPromptResult> {
  try {
    const brandId = await resolveBrandId(ctx, args.brand_id)
    const topic = args.topic.trim().slice(0, 4_000)
    if (!topic) throw new McpError(ErrorCode.InvalidParams, 'topic must not be empty.')
    const requested = parsePlatforms(args.platforms)
    const { services, userId } = ctx
    const brand = await services.brands.get(userId, brandId)
    const [voice, samples, accounts] = await Promise.all([
      services.voice.get(userId, brand.id),
      services.voice.importedSamples(userId, brand.id, { limit: 8 }),
      services.accounts.list(userId, { brandId: brand.id }),
    ])
    const connected = accounts.filter((a) => a.status === 'active').map((a) => a.platform)
    const platforms = requested ?? (connected.length > 0 ? connected : (['instagram', 'linkedin', 'x'] as Platform[]))
    const missing = platforms.filter((p) => !connected.includes(p))

    const text = [
      `Write a social media post for the brand "${brand.name}" (brandId ${brand.id}, time zone ${brand.timezone}) about:`,
      `"""${topic}"""`,
      '',
      `Platforms: ${platforms.map((p) => PLATFORM_LABELS[p]).join(', ')}.`,
      missing.length > 0
        ? `Not connected yet: ${missing.map((p) => PLATFORM_LABELS[p]).join(', ')} (the user can connect them with connect_account before approving).`
        : '',
      '',
      '## The brand voice',
      voiceText(voice, samples),
      '',
      '## Platform rules (hard limits; stay well under them)',
      ...platforms.map((p) => platformRulesText(PLATFORM_RULES[p])),
      '',
      '## House rules',
      '1. Write one variant per platform, adapted to its format: a strong hook in the first line, one idea, a clear call to action. Do not just paste the same text everywhere.',
      '2. Use only facts the user gave you or that you can verify. Never invent numbers, quotes, testimonials, prices or offers.',
      '3. Follow the voice profile: its tone, vocabulary, do/don\'t rules, emoji and hashtag policy.',
      '4. Show the user the variants and ask for changes before saving if anything is unclear.',
      `5. Draft first: save everything as ONE draft with create_draft { brandId: "${brand.id}", variants: [{ platform, text, title?, mediaIds? }] }. Media must already exist (uploaded in the web app, rendered with render_carousel/render_video, or clips).`,
      '6. Never publish or schedule on your own. Call approve_draft with the draftId so the user can approve, edit or reject it in the approval card, and wait for their decision.',
      '7. Only after the user approved: ask when to publish and call schedule_post { draftId, at } (ISO 8601 with offset, in the brand time zone unless the user says otherwise).',
      '8. If a tool returns an error, fix exactly what it says (e.g. shorten the text by the number of characters it reports) and try again.',
    ]
      .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
      .join('\n')
    return userMessage(`Write a post for ${brand.name} in its voice`, text)
  } catch (error) {
    throw promptError(error, ctx, 'write_post')
  }
}

// ---------------------------------------------------------------------------------------------
// pick_clips
// ---------------------------------------------------------------------------------------------

export function pickClipsArgs(ctx: McpContext) {
  return {
    media_id: sourceArg(ctx),
    count: z.string().optional().describe('How many clips to suggest (default 5, at most 20).'),
  }
}

export async function pickClipsPrompt(ctx: McpContext, args: { media_id?: string | undefined; count?: string | undefined }): Promise<GetPromptResult> {
  try {
    const mediaId = await resolveSourceId(ctx, args.media_id)
    const count = Math.min(MAX_CLIP_RANGES, Math.max(1, Number.parseInt(args.count ?? '5', 10) || 5))
    const t = await ctx.services.transcripts.get(ctx.userId, { mediaId })
    const header = [
      `Pick the best ${count} short clips from video ${mediaId}${t.durationMs ? ` (${formatMs(t.durationMs)} long)` : ''} for TikTok, Reels and Shorts.`,
      '',
      ...pickClipsRules(mediaId),
      '',
    ]
    if (t.status !== 'ready') {
      return userMessage('Pick clips (transcript not ready)', [...header, `The transcript is not available: ${t.status}. ${t.message ?? ''}`.trim(), 'Tell the user and try again later.'].join('\n'))
    }
    // a long transcript is paged like get_transcript (a 4-hour video would not fit any context)
    const page = pageSegments(t.segments)
    const body = ['## Transcript segments', ...page.lines]
    if (page.nextStartMs !== null) {
      body.push(
        '',
        `The transcript continues after ${formatMs(page.nextStartMs)}: call get_transcript { mediaId: "${mediaId}", startMs: ${page.nextStartMs} } to read the rest before choosing.`,
      )
    }
    return userMessage(`Pick clips from video ${mediaId}`, [...header, ...body].join('\n'))
  } catch (error) {
    throw promptError(error, ctx, 'pick_clips')
  }
}

// ---------------------------------------------------------------------------------------------
// weekly_review
// ---------------------------------------------------------------------------------------------

export function weeklyReviewArgs(ctx: McpContext) {
  return { brand_id: brandArg(ctx) }
}

export async function weeklyReviewPrompt(ctx: McpContext, args: { brand_id?: string | undefined }): Promise<GetPromptResult> {
  try {
    const brandId = await resolveBrandId(ctx, args.brand_id)
    const review = await ctx.services.analytics.weeklyReview(ctx.userId, brandId)
    const text = [
      `Run the weekly review for the brand "${review.brand.name}" (brandId ${review.brand.id}). Data as of ${review.generatedAt.toISOString()}:`,
      '',
      weeklyReviewText(review),
      '',
      ...WEEKLY_REVIEW_STEPS,
    ].join('\n')
    return userMessage(`Weekly review for ${review.brand.name}`, text)
  } catch (error) {
    throw promptError(error, ctx, 'weekly_review')
  }
}

export const PROMPT_NAMES = ['write_post', 'pick_clips', 'weekly_review'] as const

export { WEEKLY_REVIEW_STEPS, weeklyReviewText } from './playbook'
