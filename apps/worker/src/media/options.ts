// Options shared by the media handlers (injectable for tests) and small helpers.

import type { JobRow } from '@app/core'
import { isAppError } from '@app/core/errors'
import { storageErrorReason } from '@app/storage'
import { isRetryableTranscriptionError, transcriptionErrorReason } from '@app/transcription'
import { JobAbortedError, PermanentJobError, RetryJobError } from '../errors'
import type { WorkerContext } from '../types'
import type { FetchLike } from './drive'
import { MediaToolError } from './process'
import { createChromiumRenderer, RendererUnavailableError, type SlideRenderer } from './renderer'

export interface MediaTimeouts {
  /** ffprobe. */
  probeMs: number
  /** Audio extraction for transcription (whole source, up to 4 h). */
  audioMs: number
  /** One clip render. */
  clipMs: number
  /** One slideshow segment (template video). */
  segmentMs: number
  /** The final template-video encode. */
  videoMs: number
}

export const DEFAULT_TIMEOUTS: Readonly<MediaTimeouts> = Object.freeze({
  probeMs: 2 * 60_000,
  audioMs: 90 * 60_000,
  clipMs: 30 * 60_000,
  segmentMs: 5 * 60_000,
  videoMs: 30 * 60_000,
})

export interface DownloadLimits {
  maxBytes: number
  /** Whole download. */
  timeoutMs: number
  /** No bytes for this long → retry later. */
  idleTimeoutMs: number
}

export interface MediaHandlerOptions {
  /** HTTP client for cloud-drive downloads (tests pass a mock). Default: global fetch. */
  fetch?: FetchLike
  /** HTML → PNG renderer. Default: playwright-core Chromium (CHROMIUM_PATH, then the bundled one). */
  renderer?: SlideRenderer
  /** Stream stored sources through presigned URLs. Default: when the storage is not local/memory. */
  streamSources?: boolean
  download?: Partial<DownloadLimits>
  timeouts?: Partial<MediaTimeouts>
}

export interface ResolvedMediaOptions {
  fetch: FetchLike
  renderer: (ctx: WorkerContext) => SlideRenderer
  streamSources: boolean | undefined
  download: DownloadLimits
  timeouts: MediaTimeouts
}

export function resolveMediaOptions(options: MediaHandlerOptions = {}): ResolvedMediaOptions {
  const given = options.renderer
  return {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    renderer: given ? () => given : (ctx) => createChromiumRenderer({ executablePath: ctx.config.CHROMIUM_PATH ?? null }),
    streamSources: options.streamSources,
    download: {
      maxBytes: options.download?.maxBytes ?? 10 * 1024 * 1024 * 1024,
      timeoutMs: options.download?.timeoutMs ?? 3 * 3_600_000,
      idleTimeoutMs: options.download?.idleTimeoutMs ?? 2 * 60_000,
    },
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts },
  }
}

/** This attempt is the job's last one (no retry follows a failure). */
export function isFinalAttempt(job: Pick<JobRow, 'attempts' | 'maxAttempts'>): boolean {
  return job.attempts >= job.maxAttempts
}

const RETRYABLE_CODES = new Set(['unavailable', 'rate_limited', 'internal'])

/**
 * Whether trying the same media job again later can help: tool crashes on a validated input,
 * refusals and invalid data cannot; missing tools, timeouts, storage/engine outages and unknown
 * (e.g. database) errors can.
 */
export function isRetryableMediaError(error: unknown): boolean {
  if (error instanceof JobAbortedError) return true
  if (error instanceof PermanentJobError) return false
  if (error instanceof RetryJobError || error instanceof RendererUnavailableError) return true
  if (error instanceof MediaToolError) return error.reason !== 'exit' && error.reason !== 'output_too_large'
  if (transcriptionErrorReason(error)) return isRetryableTranscriptionError(error)
  const storageReason = storageErrorReason(error)
  if (storageReason) return storageReason === 'storage_unavailable' || storageReason === 'storage_auth'
  if (isAppError(error)) return RETRYABLE_CODES.has(error.code)
  return true
}
