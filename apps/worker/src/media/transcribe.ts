// transcribe: 16 kHz mono audio from the stored source (ffmpeg) → the worker's transcriber chain
// (Whisper first, AssemblyAI as fallback; transcribeWithEngine reports which engine answered) →
// services.transcripts.save, which stores it and settles the clipping time. When it fails for good
// (non-retryable error, or the last attempt) services.transcripts.fail releases the reservation.

import { join } from 'node:path'
import { SOURCE_LIMITS } from '@app/core/plans'
import { isAppError } from '@app/core/errors'
import { isClipSource } from '@app/services'
import { transcribeWithEngine } from '@app/transcription'
import { JobAbortedError, PermanentJobError, safeErrorMessage, throwIfAborted } from '../errors'
import { payloadOf } from '../posting/payload'
import type { Handler } from '../types'
import { extractAudioArgs } from './ffmpeg'
import { withTempDir } from './files'
import { isFinalAttempt, isRetryableMediaError, resolveMediaOptions, type MediaHandlerOptions } from './options'
import { MediaToolError, runTool } from './process'
import { withStoredSource } from './source'

export const TRANSCRIBE_MESSAGES = {
  noAudio: 'This video has no sound, so it cannot be transcribed.',
  failed: 'Transcription failed.',
} as const

export interface TranscribeOutcome {
  mediaId: string
  status: 'ready' | 'skipped'
  reason?: string
  engine?: string
  words?: number
}

export function createTranscribe(options: MediaHandlerOptions = {}): Handler {
  const o = resolveMediaOptions(options)
  return async (job, ctx): Promise<TranscribeOutcome> => {
    const { userId, mediaId, language } = payloadOf('transcribe', job)
    const { services } = ctx
    const media = await services.media.getForWorker(userId, mediaId)
    const existing = await services.transcripts.getRow(userId, mediaId)
    if (existing) return { mediaId, status: 'skipped', reason: 'already_transcribed', engine: existing.engine }
    if (!isClipSource(media)) return { mediaId, status: 'skipped', reason: 'not_a_source' }
    if (media.status !== 'ready') {
      // deleted/failed sources were refunded by services (remove/markFailed, cleanup sweep)
      return { mediaId, status: 'skipped', reason: `media_${media.status}` }
    }

    try {
      return await withTempDir(ctx.tmpDir, 'transcribe', async (dir): Promise<TranscribeOutcome> => {
        const audioPath = join(dir, 'audio.mp3')
        await withStoredSource(ctx, media.storageKey, dir, { stream: o.streamSources, probeTimeoutMs: o.timeouts.probeMs }, async (input, probed) => {
          if (!probed.audio) throw new PermanentJobError(TRANSCRIBE_MESSAGES.noAudio)
          const known = media.durationMs ?? probed.durationMs ?? SOURCE_LIMITS.maxDurationMs
          const cap = Math.min(SOURCE_LIMITS.maxDurationMs, known + 1_000)
          await runTool(ctx.config.FFMPEG_PATH, extractAudioArgs({ input, maxDurationMs: cap, output: audioPath }), {
            cwd: dir,
            signal: ctx.signal,
            timeoutMs: o.timeouts.audioMs,
          })
        })
        throwIfAborted(ctx.signal)
        const detailed = await transcribeWithEngine(ctx.transcriber, {
          filePath: audioPath,
          ...(language ? { language } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        throwIfAborted(ctx.signal)
        const row = await services.transcripts.save(userId, mediaId, { engine: detailed.engine, result: detailed.result })
        ctx.logger.info('transcript saved', {
          mediaId,
          engine: detailed.engine,
          attempts: detailed.attempts.length,
          durationMs: row.durationMs,
          words: row.words.length,
        })
        return { mediaId, status: 'ready', engine: detailed.engine, words: row.words.length }
      })
    } catch (error) {
      // after an abort (lease lost / shutdown) nothing is failed or refunded: the job is retried
      if (error instanceof JobAbortedError || ctx.signal?.aborted) throw error instanceof JobAbortedError ? error : new JobAbortedError()
      if (isRetryableMediaError(error) && !isFinalAttempt(job)) throw error
      const message =
        error instanceof PermanentJobError
          ? error.message
          : error instanceof MediaToolError
            ? 'We could not read the audio of this video.'
            : safeErrorMessage(error, TRANSCRIBE_MESSAGES.failed)
      try {
        const { released } = await services.transcripts.fail(userId, mediaId, new Error(message))
        ctx.logger.warn('transcription failed; clipping time released', { mediaId, released, error: message.slice(0, 200) })
      } catch (failError) {
        // a transcript saved meanwhile (conflict) needs no refund
        if (!(isAppError(failError) && failError.code === 'conflict')) {
          ctx.logger.error('could not release the clipping time', { mediaId, error: safeErrorMessage(failError) })
          // let the runner retry (the next attempt releases it, or the cleanup sweep does)
          throw failError
        }
      }
      throw new PermanentJobError(message)
    }
  }
}
