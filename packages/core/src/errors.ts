// Domain errors. Services throw AppError; MCP tools map them to tool errors (isError: true) and
// routes map them to HTTP statuses with toErrorBody(). Messages must be neutral and actionable
// (no upsell, no secrets): they are shown to end users and to AI clients.

import type { z } from 'zod'

export const ERROR_CODES = [
  'bad_request',
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'limit_exceeded',
  'cap_reached',
  'payment_required',
  'rate_limited',
  'unavailable',
  'internal',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  limit_exceeded: 403,
  cap_reached: 429,
  payment_required: 402,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
}

export type ErrorDetails = Readonly<Record<string, unknown>>

/**
 * Registry-wide brand on every AppError instance. Bundlers (Next.js route handlers vs. pages,
 * vitest module graphs) can load this module more than once, so a services instance built in one
 * bundle throws AppErrors whose class is not the other bundle's `AppError`. `Symbol.for` returns
 * the same symbol in every copy, so `isAppError` and `instanceof AppError` work across them.
 */
const APP_ERROR_BRAND = Symbol.for('app.core.AppError')

function hasAppErrorBrand(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[APP_ERROR_BRAND] === true &&
    isErrorCode((value as { code?: unknown }).code)
  )
}

export class AppError extends Error {
  /** Cross-bundle `instanceof` (see APP_ERROR_BRAND). */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasAppErrorBrand(value)
  }

  override readonly name = 'AppError'
  readonly code: ErrorCode
  readonly details: ErrorDetails | undefined

  constructor(code: ErrorCode, message: string, details?: ErrorDetails, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
    this.details = details
    Object.defineProperty(this, APP_ERROR_BRAND, { value: true, enumerable: false })
  }

  get status(): number {
    return HTTP_STATUS_BY_CODE[this.code]
  }

  /** Whether retrying the same call later can succeed. */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable' || this.code === 'cap_reached'
  }

  toJSON(): { code: ErrorCode; message: string; details?: ErrorDetails } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

/** True for an AppError from any copy of this module (see APP_ERROR_BRAND). */
export function isAppError(value: unknown): value is AppError {
  return hasAppErrorBrand(value)
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

// Shorthands ---------------------------------------------------------------

export const notFound = (what: string, details?: ErrorDetails): AppError =>
  new AppError('not_found', `${what} was not found.`, details)

export const forbidden = (message = 'You do not have access to this resource.', details?: ErrorDetails): AppError =>
  new AppError('forbidden', message, details)

export const conflict = (message: string, details?: ErrorDetails): AppError => new AppError('conflict', message, details)

export const validationError = (message: string, details?: ErrorDetails): AppError =>
  new AppError('validation', message, details)

/** Throws AppError(code, message) when `condition` is falsy. */
export function ensure(condition: unknown, code: ErrorCode, message: string, details?: ErrorDetails): asserts condition {
  if (!condition) throw new AppError(code, message, details)
}

// Zod ----------------------------------------------------------------------

export interface FieldIssue {
  path: string
  message: string
}

/** Flattens zod issues into `path: message` pairs (never includes the offending values). */
export function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => (typeof p === 'symbol' ? p.toString() : String(p))).join('.'),
    message: issue.message,
  }))
}

export function fromZodError(error: z.ZodError, what = 'Input'): AppError {
  const issues = zodIssues(error)
  const summary = issues
    .slice(0, 5)
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .join('; ')
  const more = issues.length > 5 ? ` (and ${issues.length - 5} more)` : ''
  return new AppError('validation', `${what} is invalid. ${summary}${more}`, { issues })
}

/** Parses with a zod schema or throws AppError('validation'). */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown, what?: string): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success) throw fromZodError(result.error, what)
  return result.data
}

// Serialisation for HTTP / MCP -----------------------------------------------

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: ErrorDetails }
}

/** Converts anything thrown into a safe response body. Unknown errors become a generic `internal`. */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (isAppError(error)) {
    return { status: error.status, body: { error: error.toJSON() } }
  }
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'Something went wrong on our side. Please try again in a minute.' } },
  }
}
