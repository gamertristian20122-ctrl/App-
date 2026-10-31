// Shared plumbing for the HTTP engines: input validation, opening the audio file lazily as a Blob,
// fetch with timeouts and cancellation, and HTTP-status → error mapping.

import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { isAppError } from '@app/core/errors'
import type { HealthCheckResult, TranscriptResult } from '@app/core/ports'
import { safeEngineMessage, transcriptionError } from './errors'

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface TranscribeInput {
  /** Local path of the audio (or video) file. */
  filePath: string
  /** ISO 639-1 code ("en", "en-US", "en_us"); omit to auto-detect. */
  language?: string
  /** Cancels the request (worker shutdown, job cancel). */
  signal?: AbortSignal
}

const InputSchema = z.object({
  filePath: z.string().min(1).max(4096).refine((p) => !p.includes('\0'), 'Invalid path.'),
  language: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/, 'Language must be an ISO 639 code such as "en" or "en-US".')
    .optional(),
})

export interface CheckedInput {
  filePath: string
  /** Lower-cased, "-" replaced by "_" ("en_us"). */
  language?: string
  signal?: AbortSignal
}

export function checkInput(input: TranscribeInput, engine: string): CheckedInput {
  const parsed = InputSchema.safeParse({ filePath: input?.filePath, language: input?.language })
  if (!parsed.success) {
    throw transcriptionError('input_invalid', parsed.error.issues[0]?.message ?? 'Invalid transcription input.', { engine })
  }
  const out: CheckedInput = { filePath: parsed.data.filePath }
  if (parsed.data.language) out.language = parsed.data.language.replace('-', '_')
  if (input.signal) out.signal = input.signal
  return out
}

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
  '.mkv': 'video/x-matroska',
  '.flac': 'audio/flac',
}

export function audioContentType(filePath: string): string {
  return AUDIO_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export interface AudioFile {
  blob: Blob
  name: string
  bytes: number
  contentType: string
}

/** Checks the file and opens it as a lazily-read Blob (nothing is loaded into memory). */
export async function openAudioFile(filePath: string, maxBytes: number, engine: string): Promise<AudioFile> {
  let size: number
  try {
    const s = await stat(filePath)
    if (!s.isFile()) throw new Error('not a file')
    size = s.size
  } catch {
    throw transcriptionError('input_invalid', 'The audio file to transcribe was not found.', { engine })
  }
  if (size === 0) throw transcriptionError('input_invalid', 'The audio file to transcribe is empty.', { engine })
  if (size > maxBytes) {
    throw transcriptionError('engine_rejected', `The audio file is too large for ${engine} (${size} bytes).`, { engine })
  }
  const contentType = audioContentType(filePath)
  const blob = (await openAsBlob(filePath, { type: contentType })) as unknown as Blob
  return { blob, name: basename(filePath), bytes: size, contentType }
}

export function throwIfAborted(signal: AbortSignal | undefined, engine: string): void {
  if (signal?.aborted) throw transcriptionError('aborted', 'Transcription was cancelled.', { engine })
}

/**
 * fetch with a per-request timeout and the caller's AbortSignal. Network errors become
 * engine_unavailable, the timeout becomes timeout, a caller abort becomes aborted.
 */
export async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal; engine: string },
): Promise<Response> {
  const { timeoutMs, signal, engine } = options
  throwIfAborted(signal, engine)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
  try {
    return await fetchFn(url, { ...init, signal: combined })
  } catch (err) {
    if (signal?.aborted) throw transcriptionError('aborted', 'Transcription was cancelled.', { engine })
    if (timeout.aborted) {
      throw transcriptionError('timeout', `${engineLabel(engine)} did not answer in time.`, { engine })
    }
    if (isAppError(err)) throw err
    throw transcriptionError('engine_unavailable', `${engineLabel(engine)} could not be reached.`, {
      engine,
      cause: new Error(err instanceof Error ? err.name : 'Error'),
    })
  }
}

export function engineLabel(engine: string): string {
  return engine === 'assemblyai' ? 'AssemblyAI' : engine === 'whisper' ? 'The Whisper server' : engine
}

/** Reads a response body as JSON; null when it is not JSON. */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** The human-readable error inside common error bodies ({error:{message}}, {error}, {detail}, {message}, text). */
export function errorText(body: unknown): unknown {
  if (typeof body === 'string') return body
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  const err = b.error
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return (err as Record<string, unknown>).message
  }
  if (typeof err === 'string') return err
  if (typeof b.detail === 'string') return b.detail
  if (Array.isArray(b.detail)) return 'The request was rejected.'
  if (typeof b.message === 'string') return b.message
  return undefined
}

export function retryAfterSec(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return Math.min(3600, Math.ceil(n))
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.min(3600, Math.max(0, Math.ceil((at - Date.now()) / 1000)))
}

/** Maps a non-2xx response to an AppError. */
export async function httpError(res: Response, engine: string, secrets: readonly (string | undefined)[]): Promise<Error> {
  const body = await readJson(res)
  const detail = safeEngineMessage(errorText(body), secrets)
  const label = engineLabel(engine)
  const status = res.status
  if (status === 401 || status === 403) {
    return transcriptionError('engine_auth', `${label} refused our credentials.`, { engine, status })
  }
  if (status === 429) {
    const retry = retryAfterSec(res)
    return transcriptionError('rate_limited', `${label} is busy. Please try again shortly.`, {
      engine,
      status,
      ...(retry === undefined ? {} : { retryAfterSec: retry }),
    })
  }
  if (status === 413) return transcriptionError('engine_rejected', `${label} refused the file: it is too large.`, { engine, status })
  if (status >= 400 && status < 500) {
    return transcriptionError('engine_rejected', `${label} rejected the request${detail ? `: ${detail}` : '.'}`, { engine, status })
  }
  return transcriptionError('engine_unavailable', `${label} is temporarily unavailable (HTTP ${status}).`, { engine, status })
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** A Transcriber that can also say which engine produced the result (the fallback chain does). */
export interface DetailedTranscriber {
  transcribeDetailed(input: TranscribeInput): Promise<DetailedTranscription>
}

export interface TranscriptionAttempt {
  engine: string
  ok: boolean
  /** Present on failure: AppError code, details.reason and the safe message. */
  code?: string
  reason?: string
  message?: string
  ms: number
}

export interface DetailedTranscription {
  /** 'whisper' | 'assemblyai' | 'fake' (TRANSCRIPT_ENGINES), the value for transcripts.engine. */
  engine: string
  result: TranscriptResult
  attempts: TranscriptionAttempt[]
}

/** How long a health check waits for an engine. */
export const HEALTH_CHECK_TIMEOUT_MS = 8_000

/**
 * One GET for a health check: the HTTP status, or null when the server could not be reached
 * (network error or timeout). Never throws; the response body is discarded unread.
 */
export async function probeStatus(fetchFn: FetchLike, url: string, headers: Record<string, string>, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<number | null> {
  try {
    const res = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    await res.body?.cancel().catch(() => {})
    return res.status
  } catch {
    return null
  }
}

export type { HealthCheckResult }
