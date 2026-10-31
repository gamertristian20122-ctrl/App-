import { AppError } from '@app/core/errors'

/** Standard Postgres SQLSTATEs the app cares about. */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  exclusionViolation: '23P01',
  invalidTextRepresentation: '22P02',
  insufficientPrivilege: '42501',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
} as const

/** SQLSTATEs raised by our triggers (supabase/migrations/0001_init.sql). */
export const APP_SQLSTATE = {
  /** The draft is not approved at the post's revision. */
  notApproved: 'P0A01',
  /** An immutable column was changed. */
  immutable: 'P0A02',
  /** A post status transition is not allowed. */
  invalidTransition: 'P0A03',
  /** A cross reference does not match (another draft, brand, platform or owner). */
  mismatch: 'P0A04',
  /** UPDATE/DELETE on an append-only table. */
  appendOnly: 'P0A05',
  /** Invalid approval or draft/account/brand state. */
  invalidState: 'P0A06',
} as const

/**
 * A database error normalised across postgres.js and PGlite. It keeps the SQLSTATE and the
 * constraint/table/column names but never the query parameters (they may hold secrets).
 */
export class DbError extends Error {
  override readonly name = 'DbError'
  readonly code: string
  readonly constraint: string | undefined
  readonly table: string | undefined
  readonly column: string | undefined
  readonly detail: string | undefined

  constructor(message: string, fields: { code: string; constraint?: string; table?: string; column?: string; detail?: string }) {
    super(message)
    this.code = fields.code
    this.constraint = fields.constraint
    this.table = fields.table
    this.column = fields.column
    this.detail = fields.detail
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Converts a driver error into a DbError; anything else is returned unchanged. */
export function normalizeDbError(error: unknown): unknown {
  if (error instanceof DbError) return error
  if (error === null || typeof error !== 'object') return error
  const e = error as Record<string, unknown>
  const code = str(e.code)
  if (!code || !/^[0-9A-Z]{5}$/.test(code)) return error
  return new DbError(str(e.message) ?? 'database error', {
    code,
    // postgres.js uses *_name, PGlite uses the bare names
    constraint: str(e.constraint_name) ?? str(e.constraint),
    table: str(e.table_name) ?? str(e.table),
    column: str(e.column_name) ?? str(e.column),
    detail: str(e.detail),
  })
}

export function isDbError(error: unknown, code?: string): error is DbError {
  return error instanceof DbError && (code === undefined || error.code === code)
}

export function isUniqueViolation(error: unknown, constraint?: string): error is DbError {
  return isDbError(error, PG_ERROR.uniqueViolation) && (constraint === undefined || error.constraint === constraint)
}

export function isForeignKeyViolation(error: unknown, constraint?: string): error is DbError {
  return isDbError(error, PG_ERROR.foreignKeyViolation) && (constraint === undefined || error.constraint === constraint)
}

export function isCheckViolation(error: unknown, constraint?: string): error is DbError {
  return isDbError(error, PG_ERROR.checkViolation) && (constraint === undefined || error.constraint === constraint)
}

/** True for errors worth retrying the whole transaction for (serialization failure, deadlock). */
export function isRetryableDbError(error: unknown): boolean {
  return isDbError(error, PG_ERROR.serializationFailure) || isDbError(error, PG_ERROR.deadlockDetected)
}

/**
 * Maps a DbError to an AppError for services, MCP tools and routes. Returns null for anything
 * that is not a recognised database error (the caller rethrows it).
 */
export function dbErrorToAppError(error: unknown): AppError | null {
  if (!(error instanceof DbError)) return null
  const details = { dbCode: error.code, ...(error.constraint ? { constraint: error.constraint } : {}) }
  switch (error.code) {
    case PG_ERROR.uniqueViolation:
      return new AppError('conflict', 'That already exists.', details)
    case PG_ERROR.foreignKeyViolation:
      return new AppError('not_found', 'A referenced item does not exist.', details)
    case PG_ERROR.checkViolation:
    case PG_ERROR.notNullViolation:
    case PG_ERROR.invalidTextRepresentation:
      return new AppError('validation', error.message, details)
    case APP_SQLSTATE.notApproved:
      return new AppError('conflict', 'The draft is not approved at its current revision.', details)
    case APP_SQLSTATE.mismatch:
      return new AppError('validation', error.message, details)
    case APP_SQLSTATE.immutable:
    case APP_SQLSTATE.invalidTransition:
    case APP_SQLSTATE.appendOnly:
    case APP_SQLSTATE.invalidState:
      return new AppError('conflict', error.message, details)
    case PG_ERROR.insufficientPrivilege:
      return new AppError('forbidden', 'You do not have access to this resource.', details)
    default:
      return null
  }
}
