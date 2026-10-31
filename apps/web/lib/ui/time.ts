// Time-zone arithmetic for the calendar and the schedule forms, using Intl only (no library).
// Day keys are "YYYY-MM-DD" strings in a given IANA zone. Browser-safe.

import { safeTimeZone } from './format'

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday */
  weekday: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  }
}

/** Offset of `tz` from UTC at `date`, in ms (positive east of Greenwich). */
export function timeZoneOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * A wall-clock time in `tz` ("2026-11-02T15:00" from <input type="datetime-local">) → the UTC
 * instant. Nonexistent times (spring-forward gaps) resolve to the later offset. null when invalid.
 */
export function zonedLocalToUtc(local: string, tz: string): Date | null {
  const m = LOCAL_RE.exec(local.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(guess)
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  const zone = safeTimeZone(tz)
  const offsetA = timeZoneOffsetMs(new Date(guess), zone)
  const first = guess - offsetA
  const offsetB = timeZoneOffsetMs(new Date(first), zone)
  const second = guess - offsetB
  const p = zonedParts(new Date(second), zone)
  if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi && p.second === s) return new Date(second)
  // A spring-forward gap: the wall time does not exist. Use the offset from before the change
  // (the smaller one), which lands the same distance after the gap (02:30 → 03:30), never before.
  return new Date(guess - Math.min(offsetA, offsetB))
}

/** The value for <input type="datetime-local"> showing `date` in `tz`. */
export function toLocalInputValue(date: Date, tz: string): string {
  const p = zonedParts(date, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

export function dayKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DAY_KEY_RE.exec(value)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

function keyToUtcNoon(key: string): Date {
  const m = DAY_KEY_RE.exec(key)
  if (!m) throw new Error('Invalid day key.')
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
}

export function addDaysToKey(key: string, days: number): string {
  const d = keyToUtcNoon(key)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 0 = Sunday */
export function weekdayOfKey(key: string): number {
  return keyToUtcNoon(key).getUTCDay()
}

/** Midnight at the start of `key` in `tz`. */
export function startOfDay(key: string, tz: string): Date {
  return zonedLocalToUtc(`${key}T00:00`, tz) ?? keyToUtcNoon(key)
}

export interface DayRange {
  /** First day (inclusive) and the day after the last (exclusive). */
  startKey: string
  endKey: string
  from: Date
  to: Date
  days: string[]
}

function rangeOf(startKey: string, endKey: string, tz: string): DayRange {
  const days: string[] = []
  for (let k = startKey; k < endKey; k = addDaysToKey(k, 1)) days.push(k)
  return { startKey, endKey, from: startOfDay(startKey, tz), to: startOfDay(endKey, tz), days }
}

/** The Monday-to-Sunday week containing `anchorKey`. */
export function weekRange(anchorKey: string, tz: string): DayRange {
  const start = addDaysToKey(anchorKey, -((weekdayOfKey(anchorKey) + 6) % 7))
  return rangeOf(start, addDaysToKey(start, 7), tz)
}

/** The calendar month containing `anchorKey`. */
export function monthRange(anchorKey: string, tz: string): DayRange {
  const start = `${anchorKey.slice(0, 7)}-01`
  const y = Number(anchorKey.slice(0, 4))
  const m = Number(anchorKey.slice(5, 7))
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return rangeOf(start, next, tz)
}

/** "Monday, Nov 2" for a day key. */
export function formatDayKey(key: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(keyToUtcNoon(key))
}

/** "November 2026" for a day key. */
export function formatMonthOfKey(key: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(keyToUtcNoon(key))
}

/** IANA zones for <select>s ("UTC" first, then the runtime's list; `include` is kept if missing). */
export function timeZoneOptions(include?: string | null): string[] {
  let zones: string[] = []
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    zones = []
  }
  if (zones.length === 0) zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney']
  const out = ['UTC', ...zones.filter((z) => z !== 'UTC')]
  if (include && !out.includes(include)) out.splice(1, 0, include)
  return out
}
