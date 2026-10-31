// Errors a handler can throw to steer the runner, and the runner's failure classification.

import { isAppError, scrubString } from '@app/core'
import { backoffMs } from '@app/core/time'
import { retryAfterSeconds } from '@app/posting'

/** The job can never succeed (bad payload, missing record): it goes straight to `dead`. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError'
}

/** Retry this job after `retryInMs` (instead of the default backoff). Still uses up an attempt. */
export class RetryJobError extends Error {
  override readonly name = 'RetryJobError'
  constructor(
    message: string,
    readonly retryInMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** Thrown by handlers that stop early because `ctx.signal` aborted (lease lost / shutdown). */
export class JobAbortedError extends Error {
  override readonly name = 'JobAbortedError'
  constructor(message = 'The job was interrupted.') {
    super(message)
  }
}

/** Throws JobAbortedError when the signal has aborted (call between steps of a long handler). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new JobAbortedError()
}

/** AppError codes that no retry can fix. */
const PERMANENT_CODES = new Set(['validation', 'bad_request', 'not_found', 'forbidden', 'unauthorized'])

export interface FailureDecision {
  permanent: boolean
  /** Delay before the retry (ignored when permanent). */
  retryInMs: number
  /** Scrubbed, bounded message for jobs.last_error and logs. */
  message: string
}

export interface BackoffPolicy {
  baseMs: number
  maxMs: number
  /** 0..1, fraction of the delay randomised (subtracted). */
  jitter: number
  random?: () => number
}

export const DEFAULT_BACKOFF: Readonly<BackoffPolicy> = Object.freeze({ baseMs: 30_000, maxMs: 6 * 3_600_000, jitter: 0.25 })

/** Exponential backoff with jitter for retry `attempt` (1-based). */
export function retryDelayMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  return backoffMs(attempt, {
    baseMs: policy.baseMs,
    maxMs: policy.maxMs,
    jitter: policy.jitter,
    ...(policy.random ? { random: policy.random } : {}),
  })
}

export function safeErrorMessage(error: unknown, fallback = 'Job failed.'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const clean = scrubString(raw).replace(/\s+/g, ' ').trim().slice(0, 1_000)
  return clean || fallback
}

/**
 * How a failed attempt is retried: permanent errors (PermanentJobError, invalid input, missing
 * records) go to `dead`; a provider's retry-after hint or a RetryJobError delay wins over the
 * default exponential backoff with jitter. Attempt counting and `dead` after max_attempts happen
 * in the queue.
 */
export function classifyFailure(error: unknown, attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): FailureDecision {
  const message = safeErrorMessage(error)
  if (error instanceof PermanentJobError) return { permanent: true, retryInMs: 0, message }
  if (error instanceof RetryJobError && error.retryInMs !== undefined) {
    return { permanent: false, retryInMs: Math.max(0, Math.floor(error.retryInMs)), message }
  }
  if (isAppError(error)) {
    if (PERMANENT_CODES.has(error.code)) return { permanent: true, retryInMs: 0, message }
    const after = retryAfterSeconds(error)
    if (after !== undefined) return { permanent: false, retryInMs: Math.min(policy.maxMs, after * 1_000), message }
  }
  return { permanent: false, retryInMs: retryDelayMs(attempt, policy), message }
}
