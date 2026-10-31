// Small helpers shared by the repositories.

import { REDACT_KEY_PATTERN } from '@app/core/log'

/** snake_case -> camelCase for one key. */
export function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** Maps a row's keys from snake_case to camelCase (shallow; jsonb values are kept as-is). */
export function camelRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[camelKey(key)] = value
  return out as T
}

export function camelRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camelRow<T>(r))
}

/** int8 / numeric values arrive as number, bigint or string depending on the driver. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value !== '') return Number(value)
  return 0
}

export function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value)
}

/** Serialises a value for a `$n::text::jsonb` parameter (identical on postgres.js and PGlite). */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export type Column = string | { column: string; cast?: string; json?: boolean }

/**
 * Builds "col = $n, ..." for the keys of patch that are not undefined. `first` is the number of
 * the first placeholder. Returns null when nothing is set.
 */
export function setClause(
  patch: Record<string, unknown>,
  columns: Record<string, Column>,
  first: number,
): { sql: string; params: unknown[] } | null {
  const parts: string[] = []
  const params: unknown[] = []
  for (const [key, spec] of Object.entries(columns)) {
    const value = patch[key]
    if (value === undefined) continue
    const column = typeof spec === 'string' ? spec : spec.column
    const isJson = typeof spec !== 'string' && spec.json === true
    const cast = isJson ? '::text::jsonb' : typeof spec !== 'string' && spec.cast ? `::${spec.cast}` : ''
    params.push(isJson && value !== null ? json(value) : value)
    parts.push(`${column} = $${first + params.length - 1}${cast}`)
  }
  return parts.length === 0 ? null : { sql: parts.join(', '), params }
}

/** Clamps a list limit to [1, max]. */
export function clampLimit(limit: number | undefined, fallback = 50, max = 500): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback
  return Math.max(1, Math.min(max, Math.floor(limit)))
}

/** Normalises "one or many" filters to an array (or null when not given). */
export function many<T>(value: T | readonly T[] | undefined): T[] | null {
  if (value === undefined) return null
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T]
}

/** Truncates text stored in bounded columns (errors, notes). */
export function truncate(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Drops keys that look like credentials at any depth (the table CHECK refuses them anyway). */
export function stripSecretKeys(value: unknown, depth = 0): unknown {
  if (depth > 20) return null
  if (Array.isArray(value)) return value.map((v) => stripSecretKeys(v, depth + 1))
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEY_PATTERN.test(key)) continue
      out[key] = stripSecretKeys(v, depth + 1)
    }
    return out
  }
  return value
}
