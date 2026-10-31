// Template renders (render_carousel, render_video) and code videos (render_code_video). Slides are
// HTML (templates.ts) rendered to JPEG (carousels) / PNG (video frames) with Chromium; template
// videos turn those cards into an MP4 slideshow with crossfades; code videos are the AI's HTML
// animation captured frame by frame (code-video.ts). Outputs go to users/{u}/renders/{id}.{ext}
// (ids derived from the job id, so a retried job overwrites instead of duplicating), become media
// rows through services.renders.recordOutputs, and a DRAFT is created for the brand's connected
// platforms that accept them (createRenderDraft). With autoPublish in the job, the draft then goes
// through the brand's Auto-post rule (services.autoPost.requestForDraft): posted only when the user
// turned Auto-post on; otherwise it waits for approval. The job result is
// { mediaIds, draftId, platforms, autoPost? }.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { uuidV5 } from '@app/core/crypto'
import type { Platform } from '@app/core/types'
import { RENDER_SIZES, type AutoPublish, type RenderCarouselInput, type RenderCodeVideoInput, type RenderVideoInput } from '@app/core/validation'
import type { MediaView } from '@app/services'
import { renderKey } from '@app/storage'
import { PermanentJobError, safeErrorMessage, throwIfAborted } from '../errors'
import { payloadOf } from '../posting/payload'
import type { Handler, WorkerContext } from '../types'
import { createRenderDraft, type RenderDraftResult } from './adapters'
import { CODE_VIDEO_MESSAGES } from './code-video'
import { fileInput, slideshowPlan, type MediaInput } from './ffmpeg'
import { fileSize, jpegSize, withTempDir } from './files'
import { isRetryableMediaError, resolveMediaOptions, type MediaHandlerOptions, type ResolvedMediaOptions } from './options'
import { MediaToolError, runTool } from './process'
import { probe } from './probe'
import type { SlidePage } from './renderer'
import { carouselSlideHtml, resolveTheme, videoSlideHtml, type InlineImage } from './templates'

export const RENDER_MESSAGES = {
  imageMissing: 'A slide image is no longer available.',
  audioMissing: 'The background audio is no longer available.',
  audioUnreadable: 'The background audio could not be read.',
  badOutput: 'The render did not come out right.',
} as const

const MAX_INLINE_IMAGE_BYTES = 25_000_000
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** What the Auto-post rule decided for the job's draft (autoPublish jobs only). */
export interface AutoPostOutcome {
  outcome: string
  autoPosted: boolean
  message: string
  postIds: string[]
}

export interface RenderOutcome {
  mediaIds: string[]
  draftId: string | null
  platforms: string[]
  draftReason?: string
  /** Why the draft was refused (safe message), when draftReason is draft_refused. */
  draftMessage?: string
  durationMs?: number
  autoPost?: AutoPostOutcome
}

/**
 * Applies the brand's Auto-post rule to the draft a job made (autoPublish). Idempotent in services
 * (a retried job gets the same decision). Refusals are part of the result, never a job failure;
 * only temporary errors are rethrown (the job retries and reuses its draft).
 */
export async function applyAutoPublish(ctx: WorkerContext, userId: string, draftId: string | null, autoPublish: AutoPublish | undefined): Promise<AutoPostOutcome | undefined> {
  if (!autoPublish) return undefined
  if (!draftId) return { outcome: 'no_draft', autoPosted: false, message: 'No draft was made (no connected account takes this media), so nothing was posted.', postIds: [] }
  try {
    const r = await ctx.services.autoPost.requestForDraft(userId, draftId, autoPublish, { via: 'worker' })
    ctx.logger.info('auto-post decided', { draftId, outcome: r.outcome })
    return { outcome: r.outcome, autoPosted: r.autoPosted, message: r.message, postIds: r.posts.map((p) => p.id) }
  } catch (error) {
    if (isRetryableMediaError(error)) throw error
    ctx.logger.warn('auto-post refused', { draftId, error: safeErrorMessage(error) })
    return { outcome: 'error', autoPosted: false, message: safeErrorMessage(error), postIds: [] }
  }
}

/** Loads one of the user's ready images as a data-URI payload (inside the job's temp dir). */
async function loadImage(ctx: WorkerContext, userId: string, mediaId: string, dir: string, n: number): Promise<InlineImage> {
  const media = await ctx.services.media.getForWorker(userId, mediaId).catch(() => null)
  const mimeType = (media?.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!media || media.kind !== 'image' || media.status !== 'ready' || !INLINE_TYPES.has(mimeType)) throw new PermanentJobError(RENDER_MESSAGES.imageMissing)
  const path = join(dir, `image-${n}.bin`)
  await ctx.storage.getToFile(media.storageKey, path)
  if ((await fileSize(path)) > MAX_INLINE_IMAGE_BYTES) throw new PermanentJobError(RENDER_MESSAGES.imageMissing)
  return { mimeType, base64: (await readFile(path)).toString('base64') }
}

function outputId(jobId: string, what: string): string {
  return uuidV5(`render:${jobId}:${what}`)
}

/**
 * Post text from slide text: keeps the line breaks between heading and body (collapsing them ran
 * "Heading Body" together into one sentence), tidies other whitespace, at most `max` characters.
 */
function summary(text: string, max: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return [...lines.join('\n')].slice(0, max).join('').trim()
}

async function draftFor(
  ctx: WorkerContext,
  userId: string,
  brandId: string,
  media: MediaView[],
  kind: 'photos' | 'video',
  firstText: string,
  label: string,
  options: { text?: string; title?: string; platforms?: readonly Platform[] | undefined } = {},
): Promise<RenderDraftResult> {
  const text = options.text ?? summary(firstText, 300)
  try {
    return await createRenderDraft(ctx, userId, {
      brandId,
      media,
      kind,
      text,
      title: options.title ?? (summary(firstText.split('\n')[0] ?? '', 100) || label),
      notes: text ? `${label}: ${summary(text, 300).replace(/\s+/g, ' ')}` : label,
      platforms: options.platforms,
    })
  } catch (error) {
    // the media are recorded; a refused draft (brand archived, account on hold...) must not lose them
    if (isRetryableMediaError(error)) throw error
    ctx.logger.warn('render draft refused', { error: safeErrorMessage(error) })
    return { draftId: null, platforms: [], reused: false, reason: 'draft_refused', message: safeErrorMessage(error) }
  }
}

// ---------------------------------------------------------------------------------------------
// carousel_render
// ---------------------------------------------------------------------------------------------

export function createCarouselRender(options: MediaHandlerOptions = {}): Handler {
  const o = resolveMediaOptions(options)
  return async (job, ctx): Promise<RenderOutcome> => {
    const { userId, brandId, input } = payloadOf('carousel_render', job)
    const carousel: RenderCarouselInput = input
    const size = RENDER_SIZES[carousel.aspect] ?? { width: 1080, height: 1350 }
    const theme = resolveTheme(carousel.theme)
    return withTempDir(ctx.tmpDir, 'carousel', async (dir) => {
      const total = carousel.slides.length
      const pages: SlidePage[] = carousel.slides.map((slide, index) => ({
        outPath: join(dir, `slide-${String(index).padStart(3, '0')}.jpg`),
        format: 'jpeg' as const,
        html: async () => {
          const image = slide.imageMediaId ? await loadImage(ctx, userId, slide.imageMediaId, dir, index) : null
          return carouselSlideHtml(slide, { template: carousel.template, theme, size, index, total, image })
        },
      }))
      await o.renderer(ctx).render(pages, size, ctx.signal)
      throwIfAborted(ctx.signal)

      const outputs = []
      for (const [index, p] of pages.entries()) {
        const actual = await jpegSize(p.outPath)
        if (!actual || actual.width !== size.width || actual.height !== size.height) throw new PermanentJobError(RENDER_MESSAGES.badOutput)
        const storageKey = renderKey(userId, outputId(job.id, `slide:${index}`), 'jpg')
        await ctx.storage.putFile(storageKey, p.outPath, 'image/jpeg')
        outputs.push({ storageKey, kind: 'image' as const, mimeType: 'image/jpeg', bytes: await fileSize(p.outPath), width: size.width, height: size.height })
      }
      const media = await ctx.services.renders.recordOutputs(userId, { brandId, outputs })
      const first = carousel.slides[0]
      const firstText = [first?.heading, first?.body].filter(Boolean).join('\n')
      const draft = await draftFor(ctx, userId, brandId, media, 'photos', firstText, 'Carousel', { platforms: carousel.autoPublish?.platforms })
      const autoPost = await applyAutoPublish(ctx, userId, draft.draftId, carousel.autoPublish)
      ctx.logger.info('carousel rendered', { slides: total, draftId: draft.draftId, platforms: draft.platforms })
      return {
        mediaIds: media.map((m) => m.id),
        draftId: draft.draftId,
        platforms: draft.platforms,
        ...(draft.reason ? { draftReason: draft.reason } : {}),
        ...(draft.message ? { draftMessage: draft.message } : {}),
        ...(autoPost ? { autoPost } : {}),
      }
    })
  }
}

// ---------------------------------------------------------------------------------------------
// video_render
// ---------------------------------------------------------------------------------------------

async function loadAudio(ctx: WorkerContext, o: ResolvedMediaOptions, userId: string, mediaId: string, dir: string): Promise<MediaInput> {
  const media = await ctx.services.media.getForWorker(userId, mediaId).catch(() => null)
  if (!media || media.kind !== 'audio' || media.status !== 'ready') throw new PermanentJobError(RENDER_MESSAGES.audioMissing)
  const path = join(dir, 'audio.media')
  await ctx.storage.getToFile(media.storageKey, path)
  const probed = await probe(path, { ffprobePath: ctx.config.FFPROBE_PATH, signal: ctx.signal, timeoutMs: o.timeouts.probeMs }).catch(() => null)
  if (!probed?.demuxer || !probed.audio) throw new PermanentJobError(RENDER_MESSAGES.audioUnreadable)
  return fileInput(path, probed.demuxer)
}

export function createVideoRender(options: MediaHandlerOptions = {}): Handler {
  const o = resolveMediaOptions(options)
  return async (job, ctx): Promise<RenderOutcome> => {
    const { userId, brandId, input } = payloadOf('video_render', job)
    const video: RenderVideoInput = input
    const size = RENDER_SIZES[video.aspect] ?? { width: 1080, height: 1920 }
    const theme = resolveTheme(video.theme)
    return withTempDir(ctx.tmpDir, 'video', async (dir) => {
      const names = video.slides.map((_, index) => `slide-${String(index).padStart(3, '0')}.png`)
      const pages: SlidePage[] = video.slides.map((slide, index) => ({
        outPath: join(dir, names[index] as string),
        html: async () => {
          const image = slide.imageMediaId ? await loadImage(ctx, userId, slide.imageMediaId, dir, index) : null
          return videoSlideHtml(slide, { template: video.template, theme, size, captions: video.captions, image })
        },
      }))
      await o.renderer(ctx).render(pages, size, ctx.signal)
      throwIfAborted(ctx.signal)

      const audio = video.audioMediaId ? await loadAudio(ctx, o, userId, video.audioMediaId, dir) : null
      const plan = slideshowPlan({
        slides: video.slides.map((slide, index) => ({ path: names[index] as string, durationMs: slide.durationMs })),
        width: size.width,
        height: size.height,
        fps: 30,
        audio,
        output: 'video.mp4',
      })
      for (const segment of plan.segments) {
        await runTool(ctx.config.FFMPEG_PATH, segment.args, { cwd: dir, signal: ctx.signal, timeoutMs: o.timeouts.segmentMs })
      }
      await writeFile(join(dir, plan.concatListFile), plan.concatList, { encoding: 'utf8', mode: 0o600 })
      await runTool(ctx.config.FFMPEG_PATH, plan.finalArgs, { cwd: dir, signal: ctx.signal, timeoutMs: o.timeouts.videoMs })
      throwIfAborted(ctx.signal)

      const outPath = join(dir, 'video.mp4')
      const out = await probe(outPath, { ffprobePath: ctx.config.FFPROBE_PATH, signal: ctx.signal, timeoutMs: o.timeouts.probeMs })
      const durationMs = out.durationMs ?? 0
      if (!out.video || out.video.width !== size.width || out.video.height !== size.height || !out.audio || Math.abs(durationMs - plan.totalMs) > 500) {
        throw new PermanentJobError(RENDER_MESSAGES.badOutput)
      }
      const storageKey = renderKey(userId, outputId(job.id, 'video'), 'mp4')
      await ctx.storage.putFile(storageKey, outPath, 'video/mp4')
      const media = await ctx.services.renders.recordOutputs(userId, {
        brandId,
        outputs: [{ storageKey, kind: 'video', mimeType: 'video/mp4', bytes: await fileSize(outPath), width: size.width, height: size.height, durationMs }],
      })
      const firstText = video.slides.find((s) => s.text)?.text ?? ''
      const draft = await draftFor(ctx, userId, brandId, media, 'video', firstText, 'Video', { platforms: video.autoPublish?.platforms })
      const autoPost = await applyAutoPublish(ctx, userId, draft.draftId, video.autoPublish)
      ctx.logger.info('template video rendered', { slides: video.slides.length, durationMs, draftId: draft.draftId, platforms: draft.platforms })
      return {
        mediaIds: media.map((m) => m.id),
        draftId: draft.draftId,
        platforms: draft.platforms,
        durationMs,
        ...(draft.reason ? { draftReason: draft.reason } : {}),
        ...(draft.message ? { draftMessage: draft.message } : {}),
        ...(autoPost ? { autoPost } : {}),
      }
    })
  }
}

// ---------------------------------------------------------------------------------------------
// code_video_render
// ---------------------------------------------------------------------------------------------

export interface CodeVideoOutcome extends RenderOutcome {
  frames: number
  usedSeek: boolean
  /** Network / file requests the page tried; all were blocked. */
  blockedRequests: number
}

export function createCodeVideoRender(options: MediaHandlerOptions = {}): Handler {
  const o = resolveMediaOptions(options)
  return async (job, ctx): Promise<CodeVideoOutcome> => {
    const { userId, brandId, input } = payloadOf('code_video_render', job)
    const spec: RenderCodeVideoInput = input
    const size = RENDER_SIZES[spec.aspect] ?? { width: 1080, height: 1920 }
    return withTempDir(ctx.tmpDir, 'code-video', async (dir) => {
      const audio = spec.audioMediaId ? await loadAudio(ctx, o, userId, spec.audioMediaId, dir) : null
      let rendered
      try {
        rendered = await o.codeVideo({
          html: spec.html,
          width: size.width,
          height: size.height,
          fps: spec.fps,
          durationMs: spec.durationMs,
          audio,
          output: 'video.mp4',
          cwd: dir,
          ffmpegPath: ctx.config.FFMPEG_PATH,
          executablePath: ctx.config.CHROMIUM_PATH ?? null,
          signal: ctx.signal,
          timeouts: o.codeVideoTimeouts,
        })
      } catch (error) {
        // ffmpeg refusing the frames is the page's fault, not something a retry fixes
        if (error instanceof MediaToolError && error.reason === 'exit') throw new PermanentJobError(CODE_VIDEO_MESSAGES.badOutput)
        throw error
      }
      throwIfAborted(ctx.signal)

      const outPath = join(dir, 'video.mp4')
      const out = await probe(outPath, { ffprobePath: ctx.config.FFPROBE_PATH, signal: ctx.signal, timeoutMs: o.timeouts.probeMs })
      const durationMs = out.durationMs ?? 0
      const expectedMs = (rendered.frames / spec.fps) * 1000
      if (!out.video || out.video.width !== size.width || out.video.height !== size.height || !out.audio || Math.abs(durationMs - expectedMs) > 1000 / spec.fps + 100) {
        throw new PermanentJobError(RENDER_MESSAGES.badOutput)
      }
      const storageKey = renderKey(userId, outputId(job.id, 'code-video'), 'mp4')
      await ctx.storage.putFile(storageKey, outPath, 'video/mp4')
      const media = await ctx.services.renders.recordOutputs(userId, {
        brandId,
        outputs: [{ storageKey, kind: 'video', mimeType: 'video/mp4', bytes: await fileSize(outPath), width: size.width, height: size.height, durationMs }],
      })
      const caption = spec.caption ?? ''
      const draft = await draftFor(ctx, userId, brandId, media, 'video', caption, 'Code video', {
        text: caption,
        title: spec.title ?? (summary(caption.split('\n')[0] ?? '', 100) || 'New video'),
        platforms: spec.autoPublish?.platforms,
      })
      const autoPost = await applyAutoPublish(ctx, userId, draft.draftId, spec.autoPublish)
      ctx.logger.info('code video rendered', {
        frames: rendered.frames,
        durationMs,
        usedSeek: rendered.usedSeek,
        blockedRequests: rendered.blockedRequests,
        pageErrors: rendered.pageErrors,
        draftId: draft.draftId,
      })
      return {
        mediaIds: media.map((m) => m.id),
        draftId: draft.draftId,
        platforms: draft.platforms,
        durationMs,
        frames: rendered.frames,
        usedSeek: rendered.usedSeek,
        blockedRequests: rendered.blockedRequests,
        ...(draft.reason ? { draftReason: draft.reason } : {}),
        ...(draft.message ? { draftMessage: draft.message } : {}),
        ...(autoPost ? { autoPost } : {}),
      }
    })
  }
}
