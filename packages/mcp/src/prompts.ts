// Prompts (our playbook): write_post, pick_clips, weekly_review. They load the user's data through
// @app/services and return one user message with the rules, so every AI produces the same results.

import { McpError, ErrorCode, type GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isAppError } from '@app/core/errors'
import { PLATFORM_RULES, type PlatformRules, type TextUnit } from '@app/core/platforms'
import { formatMs } from '@app/core/time'
import { PLATFORM_LABELS, PlatformSchema, type Platform } from '@app/core/types'
import { IdSchema, MAX_CLIP_RANGES } from '@app/core/validation'
import type { VoiceProfileView, VoiceSample, WeeklyReview } from '@app/services'
import type { McpContext } from './context'
import { GENERIC_ERROR } from './errors'
import { excerpt } from './results'
import { followersText, metricsText } from './tools/insights'

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
    return new McpError(invalid ? ErrorCode.InvalidParams : ErrorCode.InternalError, error.message)
  }
  ctx.log?.error('mcp prompt crashed', { prompt, err: error instanceof Error ? error : String(error) })
  return new McpError(ErrorCode.InternalError, GENERIC_ERROR)
}

function parseId(value: string | undefined, name: string): string {
  const parsed = IdSchema.safeParse(value)
  if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, `${name} must be an id (UUID), e.g. a brandId from list_accounts.`)
  return parsed.data
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

// ---------------------------------------------------------------------------------------------
// write_post
// ---------------------------------------------------------------------------------------------

export const WritePostArgs = {
  brand_id: z.string().describe('The brand id (from list_accounts).'),
  topic: z.string().describe('What the post is about (and any facts, links or offers to include).'),
  platforms: z.string().optional().describe('Comma-separated platforms, e.g. "instagram, linkedin, x". Default: the brand\'s connected accounts.'),
}

export async function writePostPrompt(ctx: McpContext, args: { brand_id: string; topic: string; platforms?: string | undefined }): Promise<GetPromptResult> {
  try {
    const brandId = parseId(args.brand_id, 'brand_id')
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

export const PickClipsArgs = {
  media_id: z.string().describe('The source video id (from get_transcript without arguments).'),
  count: z.string().optional().describe('How many clips to suggest (default 5, at most 20).'),
}

export async function pickClipsPrompt(ctx: McpContext, args: { media_id: string; count?: string | undefined }): Promise<GetPromptResult> {
  try {
    const mediaId = parseId(args.media_id, 'media_id')
    const count = Math.min(MAX_CLIP_RANGES, Math.max(1, Number.parseInt(args.count ?? '5', 10) || 5))
    const t = await ctx.services.transcripts.get(ctx.userId, { mediaId })
    const header = [
      `Pick the best ${count} short clips from video ${mediaId}${t.durationMs ? ` (${formatMs(t.durationMs)} long)` : ''} for TikTok, Reels and Shorts.`,
      '',
      '## What makes a good clip',
      '- Standalone: it makes sense to someone who has not seen the rest of the video. No "as I said", no unexplained "this/that/he", no references to slides or earlier parts.',
      '- Hook in the first 3 seconds: a surprising claim, a strong question, a bold opinion, a number, or the payoff stated up front. Start right on that sentence, not on filler ("so", "um", "yeah").',
      '- One complete thought with a payoff: it ends right after the point lands (punchline, answer, takeaway), not mid-sentence.',
      '- 20–90 seconds long (never under 3 s or over 180 s). Shorter is better when the thought is complete.',
      '- Prefer emotion, surprise, practical value, a story with a turn, or a contrarian take. Skip intros, outros, sponsor reads and housekeeping.',
      '- Clips must not overlap; spread them across the video.',
      '',
      '## How to cut',
      '1. Choose ranges from the segment timestamps below (milliseconds). For a precise cut, call get_transcript with { mediaId, startMs, endMs } around the moment to see word timings; start at the first word of the hook (minus ~150 ms) and end just after the last word of the payoff (plus ~300 ms).',
      `2. Show the user your picks (time range, a title of at most 100 characters, the hook line) and why each works. Let them drop or adjust any.`,
      `3. Then call make_clips { mediaId: "${mediaId}", ranges: [{ startMs, endMs, title, hook }], captionStyle?: "bold" | "minimal" | "karaoke" | "none" } with at most ${MAX_CLIP_RANGES} ranges.`,
      '4. Each rendered clip becomes a draft. The user approves it in the approval card (approve_draft) before anything is scheduled. Never schedule without approval.',
      '',
    ]
    if (t.status !== 'ready') {
      return userMessage('Pick clips (transcript not ready)', [...header, `The transcript is not available: ${t.status}. ${t.message ?? ''}`.trim(), 'Tell the user and try again later.'].join('\n'))
    }
    const segments = t.segments.map((s) => `[${s.s}–${s.e} ms | ${formatMs(s.s)}–${formatMs(s.e)}] ${s.t}`)
    const body = ['## Transcript segments', ...segments]
    if (t.message) body.push('', t.message)
    return userMessage(`Pick clips from video ${mediaId}`, [...header, ...body].join('\n'))
  } catch (error) {
    throw promptError(error, ctx, 'pick_clips')
  }
}

// ---------------------------------------------------------------------------------------------
// weekly_review
// ---------------------------------------------------------------------------------------------

export const WeeklyReviewArgs = {
  brand_id: z.string().describe('The brand id (from list_accounts).'),
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'n/a'
  return `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10}%`
}

export function weeklyReviewText(r: WeeklyReview): string {
  const lines: string[] = []
  const day = (d: Date) => d.toISOString().slice(0, 10)
  lines.push(`## Last 7 days (${day(r.current.from)} to ${day(r.current.to)}) vs the previous 7 days`)
  lines.push(`- Posts: ${r.current.posts} (previous ${r.previous.posts}, ${pct(r.change.posts)})`)
  lines.push(`- This week: ${metricsText(r.current.metrics)}`)
  lines.push(`- Previous week: ${metricsText(r.previous.metrics)}`)
  const changes = Object.entries(r.change)
    .filter(([k]) => k !== 'posts')
    .map(([k, v]) => `${k} ${pct(v)}`)
  if (changes.length > 0) lines.push(`- Change: ${changes.join(', ')}`)
  const byPlatform = Object.entries(r.current.byPlatform)
  if (byPlatform.length > 0) {
    lines.push('- By platform this week:')
    for (const [p, v] of byPlatform) if (v) lines.push(`  - ${PLATFORM_LABELS[p as Platform]}: ${v.posts} posts; ${metricsText(v.metrics)}`)
  }
  lines.push(`- Followers: ${followersText(r.followers)}`)
  const postLine = (p: WeeklyReview['topPosts'][number]) =>
    `  - ${PLATFORM_LABELS[p.platform]}, ${p.publishedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC: "${excerpt(p.excerpt, 120)}" (${metricsText(p.metrics)}, score ${Math.round(p.score)})`
  if (r.topPosts.length > 0) lines.push('- Top posts:', ...r.topPosts.map(postLine))
  if (r.bottomPosts.length > 0) lines.push('- Weakest posts:', ...r.bottomPosts.map(postLine))
  const days = r.cadence.byWeekday.map((c, i) => (c > 0 ? `${WEEKDAYS[i]} ${c}` : null)).filter(Boolean)
  const hours = r.cadence.byHour.map((c, h) => (c > 0 ? `${String(h).padStart(2, '0')}:00 ${c}` : null)).filter(Boolean)
  lines.push(`- Posting days (${r.brand.timezone}): ${days.length > 0 ? days.join(', ') : 'none'}; hours: ${hours.length > 0 ? hours.join(', ') : 'none'}`)
  lines.push(`- Pipeline: ${r.upcoming.scheduled} scheduled, ${r.upcoming.drafts} drafts waiting for approval`)
  lines.push(`- Voice profile: ${r.voiceProfileVersion === null ? 'none yet' : `version ${r.voiceProfileVersion}`}; imported past posts: ${r.importedPosts}`)
  return lines.join('\n')
}

export async function weeklyReviewPrompt(ctx: McpContext, args: { brand_id: string }): Promise<GetPromptResult> {
  try {
    const brandId = parseId(args.brand_id, 'brand_id')
    const review = await ctx.services.analytics.weeklyReview(ctx.userId, brandId)
    const text = [
      `Run the weekly review for the brand "${review.brand.name}" (brandId ${review.brand.id}). Data as of ${review.generatedAt.toISOString()}:`,
      '',
      weeklyReviewText(review),
      '',
      '## What to do',
      '1. Summarise in 3–5 bullets what worked and what did not, citing the numbers above (compare with the previous week). Say so when there is too little data to conclude anything.',
      '2. Propose exactly 3 concrete experiments for next week. For each: the hypothesis, the exact change (format, hook style, topic, posting day/time, platform, length), how many posts, and the metric that decides success.',
      '3. For each experiment, suggest 1–2 draft posts (per platform text) in the brand voice (load the write_post prompt or use the voice profile).',
      '4. Ask the user which experiments to run. Only then save the posts with create_draft and show each with approve_draft. Never schedule anything the user has not approved.',
      '5. If posts or analytics are missing, suggest import_past_posts or connecting accounts instead of guessing.',
    ].join('\n')
    return userMessage(`Weekly review for ${review.brand.name}`, text)
  } catch (error) {
    throw promptError(error, ctx, 'weekly_review')
  }
}

export const PROMPT_NAMES = ['write_post', 'pick_clips', 'weekly_review'] as const
