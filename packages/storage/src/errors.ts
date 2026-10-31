// Storage errors. Every driver throws AppError (from @app/core) with a stable `details.reason`:
//
//   reason                AppError code   meaning
//   invalid_key           validation      the key does not follow the users/{userId}/… layout
//   invalid_input         validation      bad content type, size or TTL passed by our own code
//   not_found             not_found       the object does not exist (getToFile)
//   too_large             validation      the object is larger than the single-request limit
//   storage_auth          unavailable     the storage credentials were refused (ops problem)
//   storage_unavailable   unavailable     network failure, timeout, 5xx or an unexpected response
//
// Messages never contain credentials, signatures or presigned URLs.

import { AppError, isAppError, type ErrorCode } from '@app/core/errors'

export const STORAGE_ERROR_REASONS = [
  'invalid_key',
  'invalid_input',
  'not_found',
  'too_large',
  'storage_auth',
  'storage_unavailable',
] as const
export type StorageErrorReason = (typeof STORAGE_ERROR_REASONS)[number]

const CODE_BY_REASON: Readonly<Record<StorageErrorReason, ErrorCode>> = {
  invalid_key: 'validation',
  invalid_input: 'validation',
  not_found: 'not_found',
  too_large: 'validation',
  storage_auth: 'unavailable',
  storage_unavailable: 'unavailable',
}

export function storageError(
  reason: StorageErrorReason,
  message: string,
  extra?: { status?: number; cause?: unknown },
): AppError {
  const details: Record<string, unknown> = { reason }
  if (extra?.status !== undefined) details.status = extra.status
  return new AppError(CODE_BY_REASON[reason], message, details, extra?.cause === undefined ? undefined : { cause: extra.cause })
}

/** The storage reason of an error thrown by an ObjectStorage driver (undefined for anything else). */
export function storageErrorReason(error: unknown): StorageErrorReason | undefined {
  if (!isAppError(error)) return undefined
  const reason = error.details?.reason
  return typeof reason === 'string' && (STORAGE_ERROR_REASONS as readonly string[]).includes(reason)
    ? (reason as StorageErrorReason)
    : undefined
}
