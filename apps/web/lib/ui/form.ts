// Reading HTML form fields in server actions. Ids, platforms and time zones are parsed with the
// shared @app/core zod schemas; everything else is passed to services, which validate it with the
// core schemas again. Field readers never throw: they return undefined/null for bad input.

import { PlatformSchema, type Platform } from '@app/core/types'
import { IdSchema, TimezoneSchema } from '@app/core/validation'

export type Fields = Pick<FormData, 'get' | 'getAll'>

/** A string field (undefined when missing, not a string, or longer than `max`). */
export function text(fd: Fields, name: string, options: { max?: number; trim?: boolean } = {}): string | undefined {
  const raw = fd.get(name)
  if (typeof raw !== 'string') return undefined
  const value = options.trim === false ? raw : raw.trim()
  if (value.length > (options.max ?? 10_000)) return undefined
  return value
}

/** A non-empty string field, else undefined. */
export function nonEmpty(fd: Fields, name: string, options: { max?: number } = {}): string | undefined {
  const value = text(fd, name, options)
  return value ? value : undefined
}

export function checkbox(fd: Fields, name: string): boolean {
  const raw = fd.get(name)
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes'
}

/** A whole number in [min, max], or undefined (empty), or null (invalid). */
export function integer(fd: Fields, name: string, min: number, max: number): number | undefined | null {
  const raw = text(fd, name, { max: 20 })
  if (raw === undefined || raw === '') return undefined
  if (!/^-?\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}

export function id(fd: Fields, name: string): string | null {
  const parsed = IdSchema.safeParse(fd.get(name))
  return parsed.success ? parsed.data : null
}

export function isId(value: unknown): value is string {
  return IdSchema.safeParse(value).success
}

export function platform(fd: Fields, name: string): Platform | null {
  const parsed = PlatformSchema.safeParse(fd.get(name))
  return parsed.success ? parsed.data : null
}

export function timeZone(fd: Fields, name: string): string | null {
  const parsed = TimezoneSchema.safeParse(fd.get(name))
  return parsed.success ? parsed.data : null
}

/** One entry per non-empty line. */
export function lines(fd: Fields, name: string, max = 20_000): string[] {
  const value = text(fd, name, { max, trim: false })
  if (!value) return []
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Blocks separated by a line containing only "---". */
export function blocks(fd: Fields, name: string, max = 200_000): string[] {
  const value = text(fd, name, { max, trim: false })
  if (!value) return []
  return value
    .split(/\r?\n\s*---\s*\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
}
