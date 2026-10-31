// Provider errors. Every PostingProvider throws AppError (from @app/core) with a stable `details.reason`
// so the worker and services can decide what to do without parsing messages:
//
//   reason                 AppError code   meaning
//   provider_auth          unavailable     our provider credentials were refused (401/403): an ops problem,
//                                          never the end user's, so it must not surface as 401 (MCP clients
//                                          would re-run OAuth). Retrying later can work once ops fix the key.
//   rate_limited           rate_limited    too many requests; details.retryAfterSec says when to retry
//   cap_reached            cap_reached     the account's rolling-24h posting cap is full (429 with violations)
//   provider_rejected      bad_request     the provider refused this request (4xx); the message is safe to show
//   provider_unavailable   unavailable     5xx, network failure, timeout or an unreadable response
//   not_found              not_found       the profile / upload does not exist at the provider
//   conflict               conflict        e.g. the same idempotency key is in flight (retry in a few seconds)
//
// Messages are neutral, end-user safe and never contain secrets, URLs with signatures or the provider's
// dashboard links (we are white-label).

import { AppError, isAppError, type ErrorCode } from '@app/core/errors'
import { scrubString } from '@app/core/log'
import type { ProviderName } from '@app/core/types'

export const PROVIDER_ERROR_REASONS = [
  'provider_auth',
  'rate_limited',
  'cap_reached',
  'provider_rejected',
  'provider_unavailable',
  'not_found',
  'conflict',
] as const
export type ProviderErrorReason = (typeof PROVIDER_ERROR_REASONS)[number]

export const ERROR_CODE_BY_REASON: Readonly<Record<ProviderErrorReason, ErrorCode>> = {
  provider_auth: 'unavailable',
  rate_limited: 'rate_limited',
  cap_reached: 'cap_reached',
  provider_rejected: 'bad_request',
  provider_unavailable: 'unavailable',
  not_found: 'not_found',
  conflict: 'conflict',
}

export interface ProviderErrorDetails {
  provider: ProviderName
  reason: ProviderErrorReason
  /** HTTP status the provider answered with (absent for network errors). */
  status?: number
  /** The provider's machine-readable error code, when it sent a safe one (e.g. PROFILE_LIMIT_REACHED). */
  providerCode?: string
  /** Seconds to wait before retrying (rate_limited, cap_reached, conflict). */
  retryAfterSec?: number
}

export function providerError(
  reason: ProviderErrorReason,
  message: string,
  details: Omit<ProviderErrorDetails, 'reason'>,
): AppError {
  const clean: Record<string, unknown> = { provider: details.provider, reason }
  if (details.status !== undefined) clean.status = details.status
  if (details.providerCode !== undefined) clean.providerCode = details.providerCode
  if (details.retryAfterSec !== undefined) clean.retryAfterSec = details.retryAfterSec
  return new AppError(ERROR_CODE_BY_REASON[reason], message, clean)
}

/** The provider reason of an error thrown by a PostingProvider (undefined for anything else). */
export function providerErrorReason(error: unknown): ProviderErrorReason | undefined {
  if (!isAppError(error)) return undefined
  const reason = error.details?.reason
  return typeof reason === 'string' && (PROVIDER_ERROR_REASONS as readonly string[]).includes(reason)
    ? (reason as ProviderErrorReason)
    : undefined
}

/** Seconds to wait before retrying, when the error says so. */
export function retryAfterSeconds(error: unknown): number | undefined {
  if (!isAppError(error)) return undefined
  const value = error.details?.retryAfterSec
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Whether retrying the same call later can succeed (worker backoff decision). */
export function isRetryableProviderError(error: unknown): boolean {
  const reason = providerErrorReason(error)
  return (
    reason === 'rate_limited' ||
    reason === 'cap_reached' ||
    reason === 'provider_unavailable' ||
    reason === 'provider_auth' ||
    reason === 'conflict'
  )
}

const MAX_MESSAGE = 300

export interface SafeMessageOptions {
  /** Values removed verbatim (e.g. the API key), in case a provider echoes them. */
  secrets?: readonly string[]
  /** Provider-specific clean-up (dashboard names, brand names) applied after URL stripping. */
  rewrite?: (s: string) => string
}

/**
 * Turns a provider's free-text error into something safe to show an end user or an AI client:
 * strips URLs (presigned media URLs carry signatures; dashboard links are not ours), scrubs anything
 * secret-looking, removes the given secrets verbatim, collapses whitespace and truncates.
 */
export function safeProviderMessage(raw: unknown, options: SafeMessageOptions = {}): string | null {
  if (typeof raw !== 'string') return null
  let s = raw
  for (const secret of options.secrets ?? []) {
    if (secret && secret.length >= 4) s = s.split(secret).join('[REDACTED]')
  }
  // URLs, optionally wrapped in parentheses
  // (with a leading "see" / "at" / "from" / "visit" / "via" that would otherwise dangle)
  s = scrubString(s).replace(/(?:,?\s*\b(?:see|at|from|via|visit|on)\s+)?\(?\b(?:https?|ftp):\/\/[^\s)]+\)?/gi, '')
  if (options.rewrite) s = options.rewrite(s)
  s = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
  if (s === '') return null
  if (s.length > MAX_MESSAGE) s = `${s.slice(0, MAX_MESSAGE - 1).trimEnd()}…`
  return s
}

/** A provider error code is only echoed when it looks like an identifier (never free text). */
export function safeProviderCode(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(raw) ? raw : undefined
}
