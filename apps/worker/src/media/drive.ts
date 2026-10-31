// Cloud-drive downloads for clip sources (Google Drive, Dropbox, OneDrive only; never YouTube or
// any other video site). The share link is turned into the provider's direct-download URL, every
// redirect hop is re-checked against the provider's download hosts (core isAllowedDownloadHop), and
// the body is streamed to a temp file with a byte cap, an overall timeout and an idle timeout
// while its sha256 is computed. URLs are never logged unredacted (share links are capabilities).

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { MAX_REDIRECT_HOPS, SOURCE_URL_MESSAGES, isAllowedDownloadHop, type DriveProvider, type SourceUrlRefusal } from '@app/core/links'
import { JobAbortedError } from '../errors'

/** The source can never be ingested (refused link, private file, not a video...). The message is shown to the user. */
export class IngestRefusal extends Error {
  override readonly name = 'IngestRefusal'
}

/** A temporary download problem (network, 5xx, 429, timeout): the job retries. Message is user-safe. */
export class TransientDownloadError extends Error {
  override readonly name = 'TransientDownloadError'
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const SHARE_HINT = 'Share the file with "Anyone with the link" and paste the link to the file (not a folder).'

export const DRIVE_MESSAGES = {
  folder: `This is a link to a folder. ${SHARE_HINT}`,
  notAFile: `This link does not point to a file we can download. ${SHARE_HINT}`,
  googleDoc: 'This is a Google Docs, Sheets or Slides file, not a video. Share the video file itself.',
  private: `We could not download this file: it may be private or deleted. ${SHARE_HINT}`,
  webPage: `The link opened a web page instead of the file. ${SHARE_HINT}`,
  tooLarge: 'Files may be at most 10 GB.',
  tooManyRedirects: 'The link redirected too many times. Share the file again and paste the new link.',
  badRedirect: 'The download was redirected to a site we do not download from. Share the file from Google Drive, Dropbox or OneDrive directly.',
  empty: 'The downloaded file is empty.',
} as const

function redirectRefusal(reason: SourceUrlRefusal): string {
  return reason === 'video_site_forbidden' ? SOURCE_URL_MESSAGES.video_site_forbidden : DRIVE_MESSAGES.badRedirect
}

const ID_RE = /^[A-Za-z0-9_-]{10,200}$/
const KEY_RE = /^[A-Za-z0-9_-]{1,200}$/

function googleDriveUrl(url: URL): string {
  const path = url.pathname
  if (/\/(?:drive\/(?:u\/\d+\/)?folders|folderview|embeddedfolderview)\b/.test(path)) throw new IngestRefusal(DRIVE_MESSAGES.folder)
  if (/^\/(?:document|spreadsheets|presentation|forms|drawings)\//.test(path)) throw new IngestRefusal(DRIVE_MESSAGES.googleDoc)
  const fromPath = /\/file\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(path)?.[1]
  const id = fromPath ?? url.searchParams.get('id') ?? ''
  if (!ID_RE.test(id)) throw new IngestRefusal(DRIVE_MESSAGES.notAFile)
  const out = new URL('https://drive.usercontent.google.com/download')
  out.searchParams.set('id', id)
  out.searchParams.set('export', 'download')
  // confirm=t skips the "can't scan this file for viruses" page shown for large files
  out.searchParams.set('confirm', 't')
  const resourceKey = url.searchParams.get('resourcekey')
  if (resourceKey && KEY_RE.test(resourceKey)) out.searchParams.set('resourcekey', resourceKey)
  return out.toString()
}

function dropboxUrl(url: URL): string {
  if (url.hostname === 'dl.dropboxusercontent.com') return url.toString()
  if (/^\/(?:sh|scl\/fo)\//.test(url.pathname)) throw new IngestRefusal(DRIVE_MESSAGES.folder)
  if (!/^\/(?:s|scl\/fi)\//.test(url.pathname)) throw new IngestRefusal(DRIVE_MESSAGES.notAFile)
  const out = new URL(url.toString())
  out.hostname = 'www.dropbox.com'
  out.searchParams.delete('raw')
  out.searchParams.set('dl', '1')
  out.hash = ''
  return out.toString()
}

/** OneDrive "shares" API: u! + unpadded base64url of the share link → /root/content (a redirect to the file). */
function oneDriveUrl(url: URL): string {
  const encoded = Buffer.from(url.toString(), 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')
  return `https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content`
}

/**
 * The direct-download URL for a share link that already passed core checkSourceUrl (https,
 * allowlisted host). Folder links and Google Docs are refused with a clear message.
 */
export function directDownloadUrl(provider: DriveProvider, shareUrl: string): string {
  let url: URL
  try {
    url = new URL(shareUrl)
  } catch {
    throw new IngestRefusal(SOURCE_URL_MESSAGES.invalid_url)
  }
  switch (provider) {
    case 'google_drive':
      return googleDriveUrl(url)
    case 'dropbox':
      return dropboxUrl(url)
    case 'onedrive':
      return oneDriveUrl(url)
  }
}

export interface DownloadOptions {
  fetch: FetchLike
  provider: DriveProvider
  signal?: AbortSignal | undefined
  /** Byte cap (10 GB for sources). */
  maxBytes: number
  /** Whole download, headers to last byte. */
  timeoutMs: number
  /** No data for this long → give up (retried later). */
  idleTimeoutMs: number
}

export interface DownloadResult {
  bytes: number
  sha256: string
  contentType: string | null
}

const REQUEST_HEADERS = { accept: '*/*', 'user-agent': 'Mozilla/5.0 (compatible; MediaWorker/1.0)' }

/**
 * Downloads `url` to `path`, following at most MAX_REDIRECT_HOPS redirects, each to an allowed
 * download host of `provider`. Throws IngestRefusal (permanent, user message), TransientDownloadError
 * (retry) or JobAbortedError (the job's signal aborted).
 */
export async function downloadDriveFile(url: string, path: string, options: DownloadOptions): Promise<DownloadResult> {
  const controller = new AbortController()
  let why: 'job' | 'timeout' | 'idle' | null = null
  const stop = (reason: 'job' | 'timeout' | 'idle') => {
    if (why) return
    why = reason
    controller.abort()
  }
  const onJobAbort = () => stop('job')
  if (options.signal?.aborted) throw new JobAbortedError()
  options.signal?.addEventListener('abort', onJobAbort, { once: true })
  const overall = setTimeout(() => stop('timeout'), Math.max(1, options.timeoutMs))
  let idle: ReturnType<typeof setTimeout> | null = null
  const touch = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => stop('idle'), Math.max(1, options.idleTimeoutMs))
  }

  const interrupted = (error: unknown): Error => {
    if (why === 'job') return new JobAbortedError()
    if (why === 'timeout' || why === 'idle') return new TransientDownloadError('The download took too long. We will try again.')
    if (error instanceof IngestRefusal || error instanceof TransientDownloadError || error instanceof JobAbortedError) return error
    return new TransientDownloadError('The file host could not be reached. We will try again.')
  }

  try {
    let current = url
    for (let hop = 0; ; hop++) {
      const allowed = isAllowedDownloadHop(options.provider, current)
      if (!allowed.ok) throw new IngestRefusal(hop === 0 ? SOURCE_URL_MESSAGES[allowed.reason] : redirectRefusal(allowed.reason))
      touch()
      let res: Response
      try {
        res = await options.fetch(current, { redirect: 'manual', signal: controller.signal, headers: REQUEST_HEADERS })
      } catch (error) {
        throw interrupted(error)
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => undefined)
        if (!location) throw new IngestRefusal(DRIVE_MESSAGES.notAFile)
        if (hop >= MAX_REDIRECT_HOPS) throw new IngestRefusal(DRIVE_MESSAGES.tooManyRedirects)
        try {
          current = new URL(location, current).toString()
        } catch {
          throw new IngestRefusal(DRIVE_MESSAGES.badRedirect)
        }
        continue
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined)
        if (res.status === 429 || res.status >= 500) throw new TransientDownloadError('The file host is busy. We will try again.')
        throw new IngestRefusal(DRIVE_MESSAGES.private)
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() || null
      if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
        await res.body?.cancel().catch(() => undefined)
        throw new IngestRefusal(DRIVE_MESSAGES.webPage)
      }
      const declared = Number(res.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await res.body?.cancel().catch(() => undefined)
        throw new IngestRefusal(DRIVE_MESSAGES.tooLarge)
      }
      if (!res.body) throw new IngestRefusal(DRIVE_MESSAGES.empty)

      const hash = createHash('sha256')
      let bytes = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          bytes += chunk.length
          touch()
          if (bytes > options.maxBytes) return callback(new IngestRefusal(DRIVE_MESSAGES.tooLarge))
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      try {
        await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), meter, createWriteStream(path, { mode: 0o600 }), {
          signal: controller.signal,
        })
      } catch (error) {
        throw interrupted(error)
      }
      if (bytes === 0) throw new IngestRefusal(DRIVE_MESSAGES.empty)
      return { bytes, sha256: hash.digest('hex'), contentType }
    }
  } finally {
    clearTimeout(overall)
    if (idle) clearTimeout(idle)
    options.signal?.removeEventListener('abort', onJobAbort)
  }
}
