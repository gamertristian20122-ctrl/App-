// clip_render: services.clips.startRender → ffmpeg (frame-accurate cut, 1080×1920 reframe: center
// crop for landscape, blurred fill for portrait/square/narrow, burned-in ASS captions from the
// transcript words, H.264 + AAC, faststart) → output checked with ffprobe → storage (clip key) →
// services.clips.completeRender, which records the output media and creates a DRAFT with a variant
// per connected video platform of the brand (text = the clip's hook/title). Nothing is posted: a
// human approves the draft. A failure for good marks the clip failed.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAppError } from '@app/core/errors'
import { CAPTION_STYLES, type CaptionStyle } from '@app/core/validation'
import type { RenderJobInput } from '@app/services'
import { JobAbortedError, PermanentJobError, safeErrorMessage, throwIfAborted } from '../errors'
import { payloadOf } from '../posting/payload'
import type { Handler } from '../types'
import { buildAss } from './captions'
import { CLIP_HEIGHT, CLIP_WIDTH, chooseFraming, clipRenderArgs, outputFps } from './ffmpeg'
import { hashFile, withTempDir } from './files'
import { isFinalAttempt, isRetryableMediaError, resolveMediaOptions, type MediaHandlerOptions } from './options'
import { MediaToolError, runTool } from './process'
import { probe } from './probe'
import { withStoredSource } from './source'

export const CLIP_MESSAGES = {
  noVideo: 'The source has no video track.',
  pastEnd: 'The clip starts after the end of the video.',
  failed: 'We could not render this clip.',
  badOutput: 'The rendered clip did not come out right.',
} as const

export interface ClipOutcome {
  clipId: string
  status: 'ready'
  skipped?: boolean
  outputMediaId: string | null
  draftId: string | null
  durationMs?: number
  framing?: 'crop' | 'blur'
  captions?: boolean
}

function captionStyleOf(value: unknown): CaptionStyle {
  return (CAPTION_STYLES as readonly string[]).includes(value as string) ? (value as CaptionStyle) : 'bold'
}

export function createClipRender(options: MediaHandlerOptions = {}): Handler {
  const o = resolveMediaOptions(options)
  return async (job, ctx): Promise<ClipOutcome> => {
    const { userId, clipId } = payloadOf('clip_render', job)
    const { services } = ctx

    let plan: RenderJobInput
    try {
      plan = await services.clips.startRender(userId, clipId)
    } catch (error) {
      if (isAppError(error) && error.code === 'conflict') {
        const clip = await services.clips.get(userId, clipId)
        if (clip.status === 'ready') return { clipId, status: 'ready', skipped: true, outputMediaId: clip.outputMediaId, draftId: clip.draftId }
        await services.clips.failRender(userId, clipId, error)
        throw new PermanentJobError(safeErrorMessage(error, CLIP_MESSAGES.failed))
      }
      throw error
    }

    const { clip, source, words, outputKey } = plan
    const durationMs = clip.endMs - clip.startMs
    const style = captionStyleOf(clip.captionStyle)
    try {
      return await withTempDir(ctx.tmpDir, 'clip', async (dir): Promise<ClipOutcome> => {
        const output = join(dir, 'clip.mp4')
        let framing: 'crop' | 'blur' = 'crop'
        let captions = false
        await withStoredSource(ctx, source.storageKey, dir, { stream: o.streamSources, probeTimeoutMs: o.timeouts.probeMs }, async (input, probed) => {
          const video = probed.video
          if (!video) throw new PermanentJobError(CLIP_MESSAGES.noVideo)
          if (probed.durationMs !== null && clip.startMs >= probed.durationMs) throw new PermanentJobError(CLIP_MESSAGES.pastEnd)
          const ass = buildAss(words, { style, durationMs })
          captions = ass !== null
          if (ass) await writeFile(join(dir, 'captions.ass'), ass, { encoding: 'utf8', mode: 0o600 })
          framing = chooseFraming(video.displayWidth, video.displayHeight)
          const args = clipRenderArgs({
            input,
            startMs: clip.startMs,
            durationMs,
            hasAudio: probed.audio !== null,
            framing,
            fps: outputFps(video.fps),
            captionsFile: ass ? 'captions.ass' : null,
            output: 'clip.mp4',
          })
          await runTool(ctx.config.FFMPEG_PATH, args, { cwd: dir, signal: ctx.signal, timeoutMs: o.timeouts.clipMs })
        })
        throwIfAborted(ctx.signal)

        const out = await probe(output, { ffprobePath: ctx.config.FFPROBE_PATH, signal: ctx.signal, timeoutMs: o.timeouts.probeMs })
        const outDuration = out.durationMs ?? 0
        if (!out.video || out.video.width !== CLIP_WIDTH || out.video.height !== CLIP_HEIGHT || !out.audio || outDuration <= 0 || outDuration > durationMs + 1_000) {
          throw new PermanentJobError(CLIP_MESSAGES.badOutput)
        }
        const { sha256, bytes } = await hashFile(output, ctx.signal)
        await ctx.storage.putFile(outputKey, output, 'video/mp4')
        throwIfAborted(ctx.signal)
        const done = await services.clips.completeRender(userId, clipId, {
          bytes,
          durationMs: Math.min(outDuration, 200_000),
          width: CLIP_WIDTH,
          height: CLIP_HEIGHT,
          mimeType: 'video/mp4',
          sha256,
        })
        ctx.logger.info('clip rendered', { clipId, durationMs: outDuration, framing, captions, draftId: done.draft?.id ?? null })
        return {
          clipId,
          status: 'ready',
          outputMediaId: done.clip.outputMediaId,
          draftId: done.draft?.id ?? null,
          durationMs: outDuration,
          framing,
          captions,
        }
      })
    } catch (error) {
      // after an abort (lease lost / shutdown) nothing is failed or refunded: the job is retried
      if (error instanceof JobAbortedError || ctx.signal?.aborted) throw error instanceof JobAbortedError ? error : new JobAbortedError()
      if (isRetryableMediaError(error) && !isFinalAttempt(job)) throw error
      const message = error instanceof PermanentJobError ? error.message : error instanceof MediaToolError ? CLIP_MESSAGES.failed : safeErrorMessage(error, CLIP_MESSAGES.failed)
      if (error instanceof MediaToolError) {
        ctx.logger.warn('clip render failed', { clipId, tool: error.tool, reason: error.reason, exitCode: error.exitCode })
      }
      await services.clips.failRender(userId, clipId, new Error(message))
      throw new PermanentJobError(message)
    }
  }
}
