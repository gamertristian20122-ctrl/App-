// url_import: fetches a finished video or image an AI sent as an https link (upload_media
// sourceUrl) into storage and measures it, through the same download path as drive links
// (drive.ts downloadToFile: every redirect hop re-checked, a byte cap, overall and idle timeouts)
// with the link policy for imports (core checkImportUrl: https, public host names, never YouTube /
// TikTok / Instagram / other video sites) and an HTTP client that only connects to public IP
// addresses (safe-fetch.ts). Only video/* (or image/*) responses are accepted, then ffprobe (videos)
// or the image header (images) must agree. services.media.markIngested marks it ready (post media:
// no clipping time, no transcript) and nulls the link; drafts waiting for Auto-post on this file are
// decided in that same call. Refusals mark the media failed with a safe message.

import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { IMPORT_URL_MESSAGES, checkImportUrl, redactUrl } from '@app/core/links'
import { SOURCE_LIMITS } from '@app/core/plans'
import { ALLOWED_MIME, MAX_AI_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from '@app/core/validation'
import type { IngestFacts } from '@app/services'
import { JobAbortedError, safeErrorMessage, throwIfAborted } from '../errors'
import { payloadOf } from '../posting/payload'
import type { Handler } from '../types'
import { IngestRefusal, downloadToFile } from './drive'
import { hashFile, jpegSize, pngSize, withTempDir } from './files'
import { isFinalAttempt, resolveMediaOptions, type MediaHandlerOptions } from './options'
import { MediaToolError } from './process'
import { probe } from './probe'
import type { IngestOutcome } from './source-ingest'

const SEND_FILE = 'Send the file itself with upload_media instead.'

export const URL_IMPORT_MESSAGES = {
  notAvailable: `We could not download this link: it may be private, expired or deleted. ${SEND_FILE}`,
  notAFile: `This link does not point to a file we can download. ${SEND_FILE}`,
  tooManyRedirects: `The link redirected too many times. ${SEND_FILE}`,
  badRedirect: `The link redirected somewhere we do not download from. ${SEND_FILE}`,
  tooLarge: 'Files sent by an AI may be at most 5 GB.',
  empty: 'The downloaded file is empty.',
  notVideo: `The link did not return a video (it answered with another kind of content). Link to the video file itself. ${SEND_FILE}`,
  notImage: `The link did not return an image (it answered with another kind of content). Link to the image file itself. ${SEND_FILE}`,
  unreadable: 'We could not read this file. Make sure it is an MP4, MOV or WebM video.',
  noVideo: 'This file has no video track.',
  tooLong: 'Videos may be at most 4 hours long.',
  badImage: 'This file is not a JPEG, PNG, WebP or GIF image.',
  linkGone: `The link is no longer available. ${SEND_FILE}`,
  gaveUp: `We could not download this link after several tries. ${SEND_FILE}`,
} as const

function imageType(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (head.length >= 6 && (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
  return null
}

export function createUrlImport(options: MediaHandlerOptions = {}): Handler {
  const o = resolveMediaOptions(options)
  return async (job, ctx): Promise<IngestOutcome> => {
    const { userId, mediaId } = payloadOf('url_import', job)
    const { services, storage } = ctx
    const media = await services.media.getForWorker(userId, mediaId)
    if (media.status !== 'pending') return { mediaId, status: media.status === 'ready' ? 'ready' : media.status === 'deleted' ? 'deleted' : 'failed', skipped: true }

    const refuse = async (message: string): Promise<IngestOutcome> => {
      await services.media.markFailed(userId, mediaId, new Error(message))
      ctx.logger.info('url import refused', { mediaId, reason: message.slice(0, 120) })
      return { mediaId, status: 'failed', error: message }
    }
    if (media.origin !== 'url_import' || (media.kind !== 'video' && media.kind !== 'image')) return refuse(URL_IMPORT_MESSAGES.notAFile)
    if (!media.sourceUrl) return refuse(URL_IMPORT_MESSAGES.linkGone)
    const kind = media.kind

    try {
      return await withTempDir(ctx.tmpDir, 'import', async (dir): Promise<IngestOutcome> => {
        const file = join(dir, 'import.media')
        const first = checkImportUrl(media.sourceUrl as string)
        if (!first.ok) throw new IngestRefusal(first.message)
        const downloaded = await downloadToFile(first.url, file, {
          fetch: o.importFetch,
          signal: ctx.signal,
          maxBytes: Math.min(o.download.maxBytes, MAX_UPLOAD_BYTES[kind], MAX_AI_UPLOAD_BYTES),
          timeoutMs: o.download.timeoutMs,
          idleTimeoutMs: o.download.idleTimeoutMs,
          checkHop(url) {
            const check = checkImportUrl(url)
            return check.ok ? null : check.message
          },
          checkContentType: (type) => (type && type.startsWith(`${kind}/`) ? null : kind === 'video' ? URL_IMPORT_MESSAGES.notVideo : URL_IMPORT_MESSAGES.notImage),
          refusalFor: (error) => ((error as { code?: unknown } | null)?.code === 'EPRIVATEADDRESS' ? IMPORT_URL_MESSAGES.private_host : null),
          messages: {
            notAFile: URL_IMPORT_MESSAGES.notAFile,
            tooManyRedirects: URL_IMPORT_MESSAGES.tooManyRedirects,
            badRedirect: URL_IMPORT_MESSAGES.badRedirect,
            notAvailable: URL_IMPORT_MESSAGES.notAvailable,
            tooLarge: URL_IMPORT_MESSAGES.tooLarge,
            empty: URL_IMPORT_MESSAGES.empty,
          },
        })
        ctx.logger.info('url import downloaded', { mediaId, host: first.host, url: redactUrl(first.url), bytes: downloaded.bytes })
        throwIfAborted(ctx.signal)

        let facts: IngestFacts
        let mimeType: string
        if (kind === 'video') {
          let probed
          try {
            probed = await probe(file, { ffprobePath: ctx.config.FFPROBE_PATH, signal: ctx.signal, timeoutMs: o.timeouts.probeMs })
          } catch (error) {
            if (error instanceof MediaToolError && error.reason === 'exit') throw new IngestRefusal(URL_IMPORT_MESSAGES.unreadable)
            throw error
          }
          if (!probed.demuxer || !probed.mimeType || !(ALLOWED_MIME.video as readonly string[]).includes(probed.mimeType)) throw new IngestRefusal(URL_IMPORT_MESSAGES.unreadable)
          if (!probed.video) throw new IngestRefusal(URL_IMPORT_MESSAGES.noVideo)
          if (probed.durationMs === null || probed.durationMs <= 0) throw new IngestRefusal(URL_IMPORT_MESSAGES.unreadable)
          if (probed.durationMs > SOURCE_LIMITS.maxDurationMs) throw new IngestRefusal(URL_IMPORT_MESSAGES.tooLong)
          mimeType = probed.mimeType
          facts = { durationMs: probed.durationMs, width: probed.video.displayWidth, height: probed.video.displayHeight }
        } else {
          const handle = await open(file, 'r')
          const head = Buffer.alloc(16)
          try {
            await handle.read(head, 0, 16, 0)
          } finally {
            await handle.close()
          }
          const type = imageType(head)
          if (!type) throw new IngestRefusal(URL_IMPORT_MESSAGES.badImage)
          mimeType = type
          const size = type === 'image/jpeg' ? await jpegSize(file) : type === 'image/png' ? await pngSize(file) : null
          facts = size ? { width: size.width, height: size.height } : {}
        }
        throwIfAborted(ctx.signal)

        const { sha256, bytes } = await hashFile(file, ctx.signal)
        await storage.putFile(media.storageKey, file, mimeType)
        const result = await services.media.markIngested(userId, mediaId, { ...facts, bytes, sha256, mimeType })
        if (result.error) {
          ctx.logger.info('url import refused by services', { mediaId, reason: result.error.slice(0, 120) })
          return { mediaId, status: 'failed', error: result.error }
        }
        ctx.logger.info('url import ready', { mediaId, kind, bytes })
        return { mediaId, status: 'ready', ...(facts.durationMs ? { durationMs: facts.durationMs } : {}), transcribe: false }
      })
    } catch (error) {
      // after an abort (lease lost / shutdown) nothing is failed: the job is retried
      if (error instanceof JobAbortedError || ctx.signal?.aborted) throw error instanceof JobAbortedError ? error : new JobAbortedError()
      if (error instanceof IngestRefusal) return refuse(error.message)
      if (isFinalAttempt(job)) {
        await services.media.markFailed(userId, mediaId, new Error(URL_IMPORT_MESSAGES.gaveUp)).catch((e: unknown) => {
          ctx.logger.error('could not mark the media failed', { mediaId, error: safeErrorMessage(e) })
        })
      }
      throw error
    }
  }
}
