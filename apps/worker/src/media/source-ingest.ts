// source_ingest: gets a pending video/audio into storage and measures it.
//   drive link → re-check the link (core checkSourceUrl: Google Drive / Dropbox / OneDrive only, never
//                YouTube) → direct-download URL → download (every redirect hop re-checked, 10 GB cap,
//                timeouts) → stored at the row's source key
//   upload     → copied from storage; clip sources are promoted to their immutable source key
//                (users/{u}/sources/{mediaId}.ext; the presigned upload URL can no longer replace it)
// then ffprobe (allowed container, a video stream for videos, ≤ 4 h) and sha256, and
// services.media.markIngested, which marks the media ready, reserves the clipping time once per
// source, nulls the drive link and queues transcription. Refusals mark the media failed with a
// safe message (services release any reservation); temporary problems retry, and the last attempt
// marks the media failed too.

import { join } from 'node:path'
import { checkSourceUrl, redactUrl } from '@app/core/links'
import { SOURCE_LIMITS } from '@app/core/plans'
import { isClipSource, type IngestFacts } from '@app/services'
import { parseKey, sourceKey, storageErrorReason } from '@app/storage'
import { JobAbortedError, safeErrorMessage, throwIfAborted } from '../errors'
import { payloadOf } from '../posting/payload'
import type { Handler, WorkerContext } from '../types'
import { DRIVE_MESSAGES, IngestRefusal, directDownloadUrl, downloadDriveFile } from './drive'
import { hashFile, withTempDir } from './files'
import { isFinalAttempt, resolveMediaOptions, type MediaHandlerOptions, type ResolvedMediaOptions } from './options'
import { MediaToolError } from './process'
import { probe, type ProbeResult } from './probe'
import { UNSUPPORTED_SOURCE } from './source'

export const INGEST_MESSAGES = {
  unreadable: 'We could not read this file. Make sure it is a video and try again.',
  noVideo: 'This file has no video track. Upload a video file.',
  noAudio: 'This file has no audio track.',
  noDuration: 'Could not read the length of this file.',
  tooLong: 'Videos may be at most 4 hours long.',
  tooLarge: DRIVE_MESSAGES.tooLarge,
  missingUpload: 'The uploaded file was not found. Upload it again.',
  linkGone: 'The link is no longer available. Paste it again.',
  notProcessed: 'Only videos and audio files are processed.',
  gaveUp: 'We could not process this file after several tries. Upload it again or share a new link.',
} as const

export interface IngestOutcome {
  mediaId: string
  status: 'ready' | 'failed' | 'pending' | 'deleted'
  skipped?: boolean
  error?: string
  durationMs?: number
  transcribe?: boolean
}

interface Fetched {
  bytes: number
  sha256: string
}

async function fetchDriveLink(ctx: WorkerContext, o: ResolvedMediaOptions, sourceUrl: string, file: string): Promise<Fetched> {
  const check = checkSourceUrl(sourceUrl)
  if (!check.ok) {
    ctx.logger.info('drive link refused at ingest', { reason: check.reason, url: redactUrl(sourceUrl) })
    throw new IngestRefusal(check.message)
  }
  const url = directDownloadUrl(check.provider, check.url)
  const result = await downloadDriveFile(url, file, {
    fetch: o.fetch,
    provider: check.provider,
    signal: ctx.signal,
    maxBytes: Math.min(o.download.maxBytes, SOURCE_LIMITS.maxBytes),
    timeoutMs: o.download.timeoutMs,
    idleTimeoutMs: o.download.idleTimeoutMs,
  })
  ctx.logger.info('drive file downloaded', { provider: check.provider, host: check.host, bytes: result.bytes })
  return { bytes: result.bytes, sha256: result.sha256 }
}

async function probeSource(ctx: WorkerContext, o: ResolvedMediaOptions, file: string): Promise<ProbeResult> {
  try {
    return await probe(file, { ffprobePath: ctx.config.FFPROBE_PATH, signal: ctx.signal, timeoutMs: o.timeouts.probeMs })
  } catch (error) {
    if (error instanceof MediaToolError && error.reason === 'exit') throw new IngestRefusal(INGEST_MESSAGES.unreadable)
    throw error
  }
}

export function createSourceIngest(options: MediaHandlerOptions = {}): Handler {
  const o = resolveMediaOptions(options)
  return async (job, ctx): Promise<IngestOutcome> => {
    const { userId, mediaId } = payloadOf('source_ingest', job)
    const { services, storage } = ctx
    const media = await services.media.getForWorker(userId, mediaId)
    if (media.status !== 'pending') return { mediaId, status: media.status === 'ready' ? 'ready' : media.status === 'deleted' ? 'deleted' : 'failed', skipped: true }

    const refuse = async (message: string): Promise<IngestOutcome> => {
      await services.media.markFailed(userId, mediaId, new Error(message))
      ctx.logger.info('source refused', { mediaId, reason: message.slice(0, 120) })
      return { mediaId, status: 'failed', error: message }
    }
    if (media.kind !== 'video' && media.kind !== 'audio') return refuse(INGEST_MESSAGES.notProcessed)

    try {
      return await withTempDir(ctx.tmpDir, 'ingest', async (dir): Promise<IngestOutcome> => {
        const file = join(dir, 'source.media')
        let fetched: Fetched
        let storedKey = media.storageKey
        if (media.origin === 'drive_link') {
          if (media.sourceUrl) {
            fetched = await fetchDriveLink(ctx, o, media.sourceUrl, file)
          } else if (await storage.head(media.storageKey)) {
            // an earlier attempt stored the file (the link is cleared only once ingested)
            await storage.getToFile(media.storageKey, file)
            fetched = await hashFile(file, ctx.signal)
          } else {
            throw new IngestRefusal(INGEST_MESSAGES.linkGone)
          }
        } else if (media.origin === 'upload') {
          try {
            await storage.getToFile(media.storageKey, file)
          } catch (error) {
            if (storageErrorReason(error) === 'not_found') throw new IngestRefusal(INGEST_MESSAGES.missingUpload)
            throw error
          }
          fetched = await hashFile(file, ctx.signal)
        } else {
          throw new IngestRefusal(INGEST_MESSAGES.notProcessed)
        }
        throwIfAborted(ctx.signal)

        if (fetched.bytes > SOURCE_LIMITS.maxBytes) throw new IngestRefusal(INGEST_MESSAGES.tooLarge)
        const probed = await probeSource(ctx, o, file)
        if (!probed.demuxer) throw new IngestRefusal(UNSUPPORTED_SOURCE)
        if (media.kind === 'video' && !probed.video) throw new IngestRefusal(INGEST_MESSAGES.noVideo)
        if (media.kind === 'audio' && !probed.audio) throw new IngestRefusal(INGEST_MESSAGES.noAudio)
        if (probed.durationMs === null || probed.durationMs <= 0) throw new IngestRefusal(INGEST_MESSAGES.noDuration)
        if (probed.durationMs > SOURCE_LIMITS.maxDurationMs) throw new IngestRefusal(INGEST_MESSAGES.tooLong)
        throwIfAborted(ctx.signal)

        const fallbackType = media.kind === 'video' ? 'video/mp4' : 'audio/mpeg'
        if (media.origin === 'drive_link') {
          if (media.sourceUrl) await storage.putFile(media.storageKey, file, probed.mimeType ?? fallbackType)
        } else if (isClipSource(media)) {
          const target = sourceKey(userId, media.id, parseKey(media.storageKey)?.ext ?? 'mp4')
          if (target !== media.storageKey) {
            await storage.putFile(target, file, media.mimeType ?? probed.mimeType ?? fallbackType)
            if (await services.media.promoteSource(userId, media.id, media.storageKey, target)) {
              storedKey = target
              await storage.delete(media.storageKey).catch((error: unknown) => {
                ctx.logger.warn('could not delete the upload after promoting it', { mediaId, error: safeErrorMessage(error) })
              })
            } else {
              await storage.delete(target).catch(() => undefined)
              const now = await services.media.getForWorker(userId, mediaId)
              if (now.status !== 'pending') return { mediaId, status: now.status === 'ready' ? 'ready' : now.status === 'deleted' ? 'deleted' : 'failed', skipped: true }
              throw new Error('The media row changed while it was being ingested.')
            }
          }
        }

        const facts: IngestFacts = {
          bytes: fetched.bytes,
          durationMs: probed.durationMs,
          sha256: fetched.sha256,
          ...(probed.video && media.kind === 'video' ? { width: probed.video.displayWidth, height: probed.video.displayHeight } : {}),
          ...(media.mimeType ? {} : { mimeType: probed.mimeType ?? fallbackType }),
        }
        const result = await services.media.markIngested(userId, mediaId, facts)
        if (result.error) {
          ctx.logger.info('source refused by services', { mediaId, reason: result.error.slice(0, 120) })
          return { mediaId, status: 'failed', error: result.error }
        }
        ctx.logger.info('source ingested', { mediaId, durationMs: probed.durationMs, bytes: fetched.bytes, key: storedKey === media.storageKey ? 'kept' : 'promoted' })
        return { mediaId, status: 'ready', durationMs: probed.durationMs, transcribe: result.transcribe }
      })
    } catch (error) {
      // after an abort (lease lost / shutdown) nothing is failed or refunded: the job is retried
      if (error instanceof JobAbortedError || ctx.signal?.aborted) throw error instanceof JobAbortedError ? error : new JobAbortedError()
      if (error instanceof IngestRefusal) return refuse(error.message)
      if (isFinalAttempt(job)) {
        await services.media.markFailed(userId, mediaId, new Error(INGEST_MESSAGES.gaveUp)).catch((e: unknown) => {
          ctx.logger.error('could not mark the media failed', { mediaId, error: safeErrorMessage(e) })
        })
      }
      throw error
    }
  }
}
