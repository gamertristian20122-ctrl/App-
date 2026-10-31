// Transport-level input checks for the few fields the web layer reads itself (everything else is
// passed raw to services, which parse with the @app/core zod schemas). zod is not a direct
// dependency of @app/web (see docs/handoff/web-backend.md), so these are small typed guards.

export type Check<T> = { ok: true; value: T } | { ok: false }

const ok = <T>(value: T): Check<T> => ({ ok: true, value })
const bad = { ok: false } as const

/** A string of at most `max` characters (trimmed when `trim`). `undefined` passes when optional. */
export function stringField(value: unknown, opts: { max: number; min?: number; trim?: boolean; optional: true }): Check<string | undefined>
export function stringField(value: unknown, opts: { max: number; min?: number; trim?: boolean; optional?: false }): Check<string>
export function stringField(
  value: unknown,
  opts: { max: number; min?: number; trim?: boolean; optional?: boolean },
): Check<string | undefined> {
  if (value === undefined || value === null) return opts.optional ? ok(undefined) : bad
  if (typeof value !== 'string') return bad
  const s = opts.trim ? value.trim() : value
  if (s.length > opts.max || s.length < (opts.min ?? 0)) return bad
  return ok(s)
}

/** One of `values` (or `fallback` when absent). */
export function enumField<const T extends string>(value: unknown, values: readonly T[], fallback?: T): Check<T> {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return ok(fallback)
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? ok(value as T) : bad
}

/**
 * A non-negative integer quantity from JSON (number) or a form (digits; "" = 0). The range is
 * left to services. `undefined` when absent.
 */
export function quantityField(value: unknown): Check<number | undefined> {
  if (value === undefined || value === null) return ok(undefined)
  if (typeof value === 'number') return Number.isInteger(value) ? ok(value) : bad
  if (typeof value === 'string') {
    const s = value.trim()
    if (s === '') return ok(0)
    return /^\d{1,4}$/.test(s) ? ok(Number(s)) : bad
  }
  return bad
}
