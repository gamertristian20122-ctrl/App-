// Template renders (render_carousel, render_video) and code videos (render_code_video: an HTML
// animation the AI wrote, rendered frame by frame): validated input, media only by the user's own
// asset ids, a job for the media worker, and the worker's outputs stored as render media. The
// worker makes a draft (which needs approval, unless autoPublish was asked and the brand's
// Auto-post rule approves it: services/autopost.ts).

import { z } from 'zod'
import type { Actor, MediaKind } from '@app/core/types'
import { AppError } from '@app/core/errors'
import { createScheduleAtSchema, RenderCarouselInputSchema, RenderCodeVideoInputSchema, RenderVideoInputSchema, type AutoPublish } from '@app/core/validation'
import type { BoundRepos, MediaRow } from '@app/db'
import { isKeyOwnedBy, parseKey } from '@app/storage'
import { auditIn } from './audit'
import { fromZod, requireActiveBrand, requireBrand, requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { requireCanProcessMedia, userEntitlements } from './entitlements'
import { enqueueJob, jobView, type JobView } from './jobs'
import { mediaView, type MediaView } from './media'

const OutputSchema = z.strictObject({
  storageKey: z.string().min(1).max(512),
  kind: z.enum(['image', 'video']),
  mimeType: z.string().trim().toLowerCase().max(127),
  bytes: z.number().int().min(1).max(5_000_000_000),
  width: z.number().int().min(1).max(10_000).optional(),
  height: z.number().int().min(1).max(10_000).optional(),
  durationMs: z.number().int().min(1).max(600_000).optional(),
})

const OutputsSchema = z.strictObject({
  brandId: z.string(),
  outputs: z.array(OutputSchema).min(1).max(40),
})

async function requireOwnMedia(r: BoundRepos, userId: string, ids: readonly string[], kinds: readonly MediaKind[]): Promise<MediaRow[]> {
  const unique = [...new Set(ids)]
  const rows = await r.media.getMany(userId, unique)
  for (const mediaId of unique) {
    const m = rows.find((x) => x.id === mediaId)
    if (!m || m.status === 'deleted') throw validation('A referenced media item was not found.', { mediaId })
    if (m.status !== 'ready') throw validation('A referenced media item is still processing.', { mediaId })
    if (!kinds.includes(m.kind)) throw validation(`Media ${mediaId} must be ${kinds.join(' or ')}.`, { mediaId })
  }
  return rows
}

/** An autoPublish time must be ahead when the AI asks (the worker allows it to pass while rendering). */
export function checkAutoPublishTime(ctx: Ctx, autoPublish: AutoPublish | undefined): void {
  const when = autoPublish?.when
  if (when && when !== 'now' && when !== 'best') fromZod(createScheduleAtSchema(ctx.clock), when, 'autoPublish.when')
}

export function createRendersService(ctx: Ctx) {
  async function request(
    userId: string,
    type: 'carousel_render' | 'video_render' | 'code_video_render',
    brandId: string,
    input: z.output<typeof RenderCarouselInputSchema> | z.output<typeof RenderVideoInputSchema> | z.output<typeof RenderCodeVideoInputSchema>,
    mediaChecks: Array<{ ids: string[]; kinds: MediaKind[] }>,
    via: Actor,
  ): Promise<JobView> {
    checkAutoPublishTime(ctx, input.autoPublish)
    return ctx.tx(async (r) => {
      const user = await requireUser(r, userId)
      requireCanProcessMedia(userEntitlements(user, ctx.now()))
      const brand = await requireActiveBrand(r, userId, brandId)
      for (const check of mediaChecks) await requireOwnMedia(r, userId, check.ids, check.kinds)
      if (type === 'code_video_render') {
        // each code render holds a browser for minutes: a few at a time per user
        const active = (await r.jobs.listForUser(userId, { type, status: ['queued', 'running', 'failed'], limit: 50 })).length
        if (active >= ctx.config.maxActiveCodeRenders) {
          throw new AppError('limit_exceeded', `${active} code videos are still rendering. Wait until one is done (post_status with its jobId), then send the next.`, {
            limit: ctx.config.maxActiveCodeRenders,
            active,
          })
        }
      }
      const payload = { userId, brandId: brand.id, input }
      const { job } = await enqueueJob(r, { type, payload } as Parameters<typeof enqueueJob>[1])
      await auditIn(r, userId, {
        actor: via,
        action: `render.requested`,
        subjectType: 'job',
        subjectId: job.id,
        meta: { type, ...(input.autoPublish ? { autoPublish: true } : {}) },
      })
      return jobView(job)
    })
  }

  return withErrors({
    /** render_carousel: queues a carousel render (1–20 slides). Poll jobs.get for the media ids. */
    async requestCarousel(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<JobView> {
      const uid = userIdOf(userId)
      const data = fromZod(RenderCarouselInputSchema, input, 'Carousel')
      const images = data.slides.flatMap((s) => (s.imageMediaId ? [s.imageMediaId] : []))
      return request(uid, 'carousel_render', data.brandId, data, [{ ids: images, kinds: ['image'] }], options.via ?? 'mcp')
    },

    /** render_video: queues a template video render (≤ 180 s). Poll jobs.get for the media id. */
    async requestVideo(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<JobView> {
      const uid = userIdOf(userId)
      const data = fromZod(RenderVideoInputSchema, input, 'Video')
      const images = data.slides.flatMap((s) => (s.imageMediaId ? [s.imageMediaId] : []))
      const checks: Array<{ ids: string[]; kinds: MediaKind[] }> = [{ ids: images, kinds: ['image'] }]
      if (data.audioMediaId) checks.push({ ids: [data.audioMediaId], kinds: ['audio'] })
      return request(uid, 'video_render', data.brandId, data, checks, options.via ?? 'mcp')
    },

    /**
     * render_code_video: queues a frame-by-frame render of an HTML animation (≤ 300 KB, 1–60 s,
     * 24/30 fps). Gated like render_video (plan status: rendering paused while past due or on
     * hold), plus a few renders at a time per user. Poll jobs.get for the media and draft ids.
     */
    async requestCodeVideo(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<JobView> {
      const uid = userIdOf(userId)
      const data = fromZod(RenderCodeVideoInputSchema, input, 'Code video')
      const checks: Array<{ ids: string[]; kinds: MediaKind[] }> = data.audioMediaId ? [{ ids: [data.audioMediaId], kinds: ['audio'] }] : []
      return request(uid, 'code_video_render', data.brandId, data, checks, options.via ?? 'mcp')
    },

    /** Worker: media rows for what it rendered into `users/{userId}/renders/...`. */
    async recordOutputs(userId: string, input: unknown): Promise<MediaView[]> {
      const uid = userIdOf(userId)
      const data = fromZod(OutputsSchema, input, 'Render outputs')
      for (const o of data.outputs) {
        if (!isKeyOwnedBy(o.storageKey, uid) || parseKey(o.storageKey)?.area !== 'renders') {
          throw validation('Render outputs must be stored under the user’s renders/ prefix.')
        }
      }
      return ctx.tx(async (r) => {
        const brand = await requireBrand(r, uid, data.brandId)
        const out: MediaView[] = []
        for (const o of data.outputs) {
          const existing = await r.media.findByStorageKey(uid, o.storageKey)
          if (existing) {
            out.push(mediaView(existing))
            continue
          }
          const row = await r.media.create(uid, {
            brandId: brand.id,
            kind: o.kind,
            origin: 'render',
            status: 'ready',
            storageKey: o.storageKey,
            mimeType: o.mimeType,
            bytes: o.bytes,
            width: o.width ?? null,
            height: o.height ?? null,
            durationMs: o.durationMs ?? null,
          })
          out.push(mediaView(row))
        }
        return out
      })
    },
  })
}

export type RendersService = ReturnType<typeof createRendersService>
