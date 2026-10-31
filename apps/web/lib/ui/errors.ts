// Recognising service errors without `instanceof`. The services instance is cached on globalThis
// (lib/services.ts) and may have been built by another Next.js bundle (a route handler), whose
// copy of the AppError class is a different object: `instanceof AppError` (core's isAppError) is
// then false for perfectly normal service errors. A structural check works across bundles.
// Browser-safe.

import { isErrorCode, type ErrorCode } from '@app/core/errors'

export interface AppErrorLike {
  name: 'AppError'
  code: ErrorCode
  message: string
  details?: Readonly<Record<string, unknown>>
}

export function asAppError(error: unknown): AppErrorLike | null {
  if (!error || typeof error !== 'object') return null
  const e = error as { name?: unknown; code?: unknown; message?: unknown; details?: unknown }
  if (e.name !== 'AppError' || !isErrorCode(e.code) || typeof e.message !== 'string') return null
  return error as AppErrorLike
}

export function isServiceError(error: unknown, code?: ErrorCode | readonly ErrorCode[]): boolean {
  const e = asAppError(error)
  if (!e) return false
  if (code === undefined) return true
  return typeof code === 'string' ? e.code === code : code.includes(e.code)
}
