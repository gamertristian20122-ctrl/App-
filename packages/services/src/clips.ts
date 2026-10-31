// Clips: make_clips validates ranges against the source's transcript/duration and queues one
// clip_render job per clip. The worker renders (9:16, burned-in captions) and calls
// completeRender, which stores the output and creates a draft for the brand's connected video
// platforms. Clips are drafts like everything else: they still need a human approval.

import { AppError } from '@app/core/errors'
import { PLATFORM_RULES, blockingIssues, validateVariant } from '@app/core/platforms'
import type { Actor, ClipStatus, Platform, TimedText } from '@app/core/types'
import { ClipStatusSchema } from '@app/core/types'
import { ClipRequestSchema, IdSchema, validateClipRanges } from '@app/core/validation'
import type { BoundRepos, ClipRow, DraftRow, MediaRow, VariantInput } from '@app/db'
import { clipKey } from '@app/storage'
import { z } from 'zod'
import { auditIn } from './audit'
import {
  conflict,
  errorMessage,
  fromZod,
  requireActiveBrand,
  requireClip,
  requireMedia,
  requireUser,
  userIdOf,
  validation,
  withErrors,
  type Ctx,
} from './context'
import { mediaFacts } from './drafts'
import { requireCanProcessMedia, userEntitlements } from './entitlements'
import { enqueueJob } from './jobs'
import { isClipSource } from './media'

/** Clip statuses that count toward the per-source limit. */
const ACTIVE_CLIP_STATUSES: ClipStatus[] = ['queued', 'rendering', 'ready']

const RenderOutputSchema = z.strictObject({
  bytes: z.number().int().min(1).max(10_000_000_000),
  durationMs: z.number().int().min(1).max(200_000),
  width: z.number().int().min(1).max(10_000).optional(),
  height: z.number().int().min(1).max(10_000).optional(),
  mimeType: z.string().trim().toLowerCase().max(127).default('video/mp4'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
})
export type RenderOutput = z.input<typeof RenderOutputSchema>

const ListClipsSchema = z.strictObject({
  sourceMediaId: IdSchema.optional(),
  brandId: IdSchema.optional(),
  status: ClipStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
})

export interface RenderJobInput {
  clip: ClipRow
  source: MediaRow
  /** Words inside the clip, with times relative to the clip start (ms). Empty without a transcript. */
  words: TimedText[]
  /** Where the worker must upload the rendered file. */
  outputKey: string
}

function clipText(clip: ClipRow): { text: string; title: string } {
  const title = (clip.title || clip.hook || 'New clip').slice(0, 100)
  const text = clip.hook || clip.title || ''
  return { text, title }
}

export function createClipsService(ctx: Ctx) {
  /** Variants for the brand's active accounts whose platform accepts this video. */
  async function draftVariantsIn(r: BoundRepos, userId: string, clip: ClipRow, output: MediaRow): Promise<VariantInput[]> {
    const accounts = await r.accounts.list(userId, { brandId: clip.brandId, status: 'active' })
    const { text, title } = clipText(clip)
    const variants: VariantInput[] = []
    for (const account of accounts) {
      const platform: Platform = account.platform
      const rules = PLATFORM_RULES[platform]
      if (!rules.video) continue
      const content = { text, title: rules.title ? title : null, mediaIds: [output.id], options: {} }
      const issues = validateVariant(platform, content, { media: [mediaFacts(output)] })
      if (blockingIssues(issues).length > 0) continue
      variants.push({ platform, text, title: content.title, mediaIds: [output.id], options: {}, hasLink: false })
    }
    return variants
  }

  return withErrors({
    /**
     * make_clips: validates the ranges (3–180 s each, inside the video, ≤ 20 per request, ≤ 60
     * active clips per source), creates the clip rows and queues a render job per clip. Needs the
     * source's transcript (the source is charged when it is transcribed; clips are then free).
     */
    async requestClips(userId: string, input: unknown, options: { brandId?: string; via?: Actor } = {}): Promise<ClipRow[]> {
      const uid = userIdOf(userId)
      const data = fromZod(ClipRequestSchema, input, 'Clip request')
      const max = ctx.config.maxClipsPerRequest
      if (data.ranges.length > max) throw validation(`Ask for at most ${max} clips at a time.`, { limit: max })
      return ctx.tx(async (r) => {
        const user = await requireUser(r, uid)
        requireCanProcessMedia(userEntitlements(user, ctx.now()))
        const source = await requireMedia(r, uid, data.mediaId)
        if (!isClipSource(source)) {
          throw validation('Only your own uploaded or linked videos (with the rights confirmation) can be clipped.')
        }
        if (source.status !== 'ready') throw conflict('The video is still processing. Try again in a few minutes.')
        const transcript = await r.transcripts.getByMedia(uid, source.id)
        if (!transcript) throw conflict('The transcript is not ready yet. Try again in a few minutes.')
        const durationMs = source.durationMs ?? transcript.durationMs
        const rangeIssues = validateClipRanges(data.ranges, durationMs)
        if (rangeIssues.length > 0) {
          const first = rangeIssues[0]
          throw validation(`Clip ${(first?.index ?? 0) + 1}: ${first?.message ?? 'invalid range.'}`, { ranges: rangeIssues })
        }

        let brandId = data.brandId ?? options.brandId ?? source.brandId
        if (!brandId) {
          const active = await r.brands.list(uid, { status: 'active' })
          if (active.length !== 1) throw validation('Choose the brand these clips are for.', { field: 'brandId' })
          brandId = active[0]?.id ?? null
        }
        const brand = await requireActiveBrand(r, uid, brandId)

        const seen = new Set<string>()
        const ranges = data.ranges.filter((range) => {
          const k = `${range.startMs}-${range.endMs}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        const existing = await r.clips.list(uid, { sourceMediaId: source.id, status: ACTIVE_CLIP_STATUSES, limit: 1000 })
        const limit = ctx.config.maxActiveClipsPerSource
        if (existing.length + ranges.length > limit) {
          throw new AppError('limit_exceeded', `A video can have at most ${limit} clips. Delete some clips first.`, {
            limit,
            used: existing.length,
            remaining: Math.max(0, limit - existing.length),
          })
        }
        const clips = await r.clips.createMany(
          uid,
          ranges.map((range) => ({
            brandId: brand.id,
            sourceMediaId: source.id,
            startMs: range.startMs,
            endMs: range.endMs,
            title: range.title || null,
            hook: range.hook || null,
            captionStyle: data.captionStyle,
          })),
        )
        for (const clip of clips) {
          await enqueueJob(r, { type: 'clip_render', payload: { userId: uid, clipId: clip.id }, idempotencyKey: `clip_render:${clip.id}` })
        }
        await auditIn(r, uid, {
          actor: options.via ?? 'mcp',
          action: 'clips.requested',
          subjectType: 'media',
          subjectId: source.id,
          meta: { count: clips.length, captionStyle: data.captionStyle },
        })
        return clips
      })
    },

    async list(userId: string, input: unknown = {}): Promise<ClipRow[]> {
      const uid = userIdOf(userId)
      const data = fromZod(ListClipsSchema, input ?? {}, 'Filter')
      return ctx.repos.clips.list(uid, {
        ...(data.sourceMediaId ? { sourceMediaId: data.sourceMediaId } : {}),
        ...(data.brandId ? { brandId: data.brandId } : {}),
        ...(data.status ? { status: data.status } : {}),
        limit: data.limit,
      })
    },

    async get(userId: string, clipId: string): Promise<ClipRow> {
      return requireClip(ctx.repos, userIdOf(userId), clipId)
    },

    // -------------------------------------------------------------------------------------------
    // Worker
    // -------------------------------------------------------------------------------------------

    /** clip_render job: what to render (marks the clip rendering). */
    async startRender(userId: string, clipId: string): Promise<RenderJobInput> {
      const uid = userIdOf(userId)
      return ctx.tx(async (r) => {
        const clip = await requireClip(r, uid, clipId)
        if (clip.status === 'ready') throw conflict('This clip is already rendered.')
        const source = await requireMedia(r, uid, clip.sourceMediaId)
        if (source.status !== 'ready') throw conflict('The source video is not available.')
        const transcript = await r.transcripts.getByMedia(uid, source.id)
        const words = (transcript?.words ?? [])
          .filter((w) => w.e > clip.startMs && w.s < clip.endMs)
          .map((w) => ({
            s: Math.max(0, w.s - clip.startMs),
            e: Math.min(clip.endMs, w.e) - clip.startMs,
            t: w.t,
          }))
        const row = clip.status === 'rendering' ? clip : ((await r.clips.update(uid, clip.id, { status: 'rendering', error: null })) ?? clip)
        return { clip: row, source, words, outputKey: clipKey(uid, clip.id) }
      })
    },

    /**
     * clip_render result: the file is in storage at clipKey(userId, clipId). Creates the output
     * media and a draft (variants for the brand's connected video platforms; no approval).
     */
    async completeRender(userId: string, clipId: string, output: RenderOutput): Promise<{ clip: ClipRow; draft: DraftRow | null }> {
      const uid = userIdOf(userId)
      const data = fromZod(RenderOutputSchema, output, 'Render result')
      return ctx.tx(async (r) => {
        const clip = await requireClip(r, uid, clipId)
        if (clip.status === 'ready' && clip.outputMediaId) {
          return { clip, draft: clip.draftId ? await r.drafts.get(uid, clip.draftId) : null }
        }
        const media = await r.media.create(uid, {
          brandId: clip.brandId,
          kind: 'video',
          origin: 'clip',
          status: 'ready',
          storageKey: clipKey(uid, clip.id),
          mimeType: data.mimeType,
          bytes: data.bytes,
          durationMs: data.durationMs,
          width: data.width ?? 1080,
          height: data.height ?? 1920,
          sha256: data.sha256 ?? null,
          parentMediaId: clip.sourceMediaId,
        })
        let draft: DraftRow | null = null
        const brand = await r.brands.get(uid, clip.brandId)
        if (brand && brand.status === 'active') {
          const { text } = clipText(clip)
          const created = await r.drafts.create(uid, {
            brandId: clip.brandId,
            createdVia: 'worker',
            sourceClipId: clip.id,
            notes: text ? `Clip: ${text}`.slice(0, 2_000) : null,
            variants: await draftVariantsIn(r, uid, clip, media),
          })
          draft = created.draft
        }
        const row =
          (await r.clips.update(uid, clip.id, { status: 'ready', outputMediaId: media.id, draftId: draft?.id ?? null, error: null })) ?? clip
        await auditIn(r, uid, {
          actor: 'worker',
          action: 'clip.ready',
          subjectType: 'clip',
          subjectId: clip.id,
          meta: { draftId: draft?.id ?? null, durationMs: data.durationMs },
        })
        return { clip: row, draft }
      })
    },

    /** clip_render failed for good. */
    async failRender(userId: string, clipId: string, error: unknown): Promise<ClipRow> {
      const uid = userIdOf(userId)
      return ctx.tx(async (r) => {
        const clip = await requireClip(r, uid, clipId)
        if (clip.status === 'ready') return clip
        const message = errorMessage(error, 'Rendering failed.')
        const row = (await r.clips.update(uid, clip.id, { status: 'failed', error: message })) ?? clip
        await auditIn(r, uid, { actor: 'worker', action: 'clip.failed', subjectType: 'clip', subjectId: clip.id, meta: { reason: message.slice(0, 300) } })
        return row
      })
    },
  })
}

export type ClipsService = ReturnType<typeof createClipsService>
