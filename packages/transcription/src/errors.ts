// Transcription errors. Every Transcriber throws AppError (from @app/core) with a stable details.reason
// and details.engine so the worker and the fallback chain can decide without parsing messages:
//
//   reason               AppError code   fallback?  meaning
//   input_invalid        validation      no         the local file is missing/empty, or the language code is bad
//   aborted              unavailable     no         the caller cancelled (AbortSignal)
//   engine_auth          unavailable     yes        the engine refused our key (ops problem, never the user's)
//   rate_limited         rate_limited    yes        429; details.retryAfterSec when the engine says
//   engine_rejected      bad_request     yes        the engine refused this request (4xx, file too large…)
//   engine_failed        bad_request     yes        the engine processed the file and failed (e.g. no audio)
//   engine_unavailable   unavailable     yes        network error or 5xx
//   malformed_response   unavailable     yes        the response did not match the expected shape (zod)
//   timeout              unavailable     yes        no result within the time limit
//   all_failed           (last error's)  —          the fallback chain ran out of engines; details.attempts
//
// Messages are end-user safe: URLs stripped, secret-looking strings scrubbed, API keys removed verbatim.

import { AppError, isAppError, type ErrorCode } from '@app/core/errors'
import { scrubString } from '@app/core/log'

export const TRANSCRIPTION_ERROR_REASONS = [
  'input_invalid',
  'aborted',
  'engine_auth',
  'rate_limited',
  'engine_rejected',
  'engine_failed',
  'engine_unavailable',
  'malformed_response',
  'timeout',
  'all_failed',
] as const
export type TranscriptionErrorReason = (typeof TRANSCRIPTION_ERROR_REASONS)[number]

const CODE_BY_REASON: Readonly<Record<Exclude<TranscriptionErrorReason, 'all_failed'>, ErrorCode>> = {
  input_invalid: 'validation',
  aborted: 'unavailable',
  engine_auth: 'unavailable',
  rate_limited: 'rate_limited',
  engine_rejected: 'bad_request',
  engine_failed: 'bad_request',
  engine_unavailable: 'unavailable',
  malformed_response: 'unavailable',
  timeout: 'unavailable',
}

export interface TranscriptionErrorExtra {
  engine?: string
  status?: number
  retryAfterSec?: number
  cause?: unknown
}

export function transcriptionError(
  reason: Exclude<TranscriptionErrorReason, 'all_failed'>,
  message: string,
  extra: TranscriptionErrorExtra = {},
): AppError {
  const details: Record<string, unknown> = { reason }
  if (extra.engine !== undefined) details.engine = extra.engine
  if (extra.status !== undefined) details.status = extra.status
  if (extra.retryAfterSec !== undefined) details.retryAfterSec = extra.retryAfterSec
  return new AppError(CODE_BY_REASON[reason], message, details, extra.cause === undefined ? undefined : { cause: extra.cause })
}

export function transcriptionErrorReason(error: unknown): TranscriptionErrorReason | undefined {
  if (!isAppError(error)) return undefined
  const reason = error.details?.reason
  return typeof reason === 'string' && (TRANSCRIPTION_ERROR_REASONS as readonly string[]).includes(reason)
    ? (reason as TranscriptionErrorReason)
    : undefined
}

/** Whether a fallback engine might succeed where this error happened. */
export function shouldFallBack(error: unknown): boolean {
  const reason = transcriptionErrorReason(error)
  return reason !== 'input_invalid' && reason !== 'aborted'
}

/** Whether retrying the whole job later can succeed (worker backoff decision). */
export function isRetryableTranscriptionError(error: unknown): boolean {
  const reason = transcriptionErrorReason(error)
  if (reason === 'all_failed') {
    const attempts = (error as AppError).details?.attempts
    return Array.isArray(attempts) && attempts.some((a) => RETRYABLE.has((a as { reason?: string }).reason ?? ''))
  }
  return reason !== undefined && RETRYABLE.has(reason)
}

const RETRYABLE = new Set<string>(['engine_auth', 'rate_limited', 'engine_unavailable', 'malformed_response', 'timeout'])

const MAX_MESSAGE = 300

/**
 * Makes an engine's free-text error safe to show: removes the given secrets verbatim, scrubs
 * secret-looking substrings, strips URLs, drops control characters, collapses whitespace, truncates.
 */
export function safeEngineMessage(raw: unknown, secrets: readonly (string | undefined)[] = []): string | null {
  if (typeof raw !== 'string') return null
  let s = raw
  for (const secret of secrets) if (secret && secret.length >= 4) s = s.split(secret).join('[REDACTED]')
  s = scrubString(s)
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s
}
