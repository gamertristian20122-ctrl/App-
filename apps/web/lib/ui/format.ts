// Display formatting for the web UI. Browser-safe (no Node APIs); every function tolerates bad
// input and an unknown time zone instead of throwing during render.

import { HOUR_SECONDS } from '@app/core/plans'

export function safeTimeZone(tz: string | null | undefined, fallback = 'UTC'): string {
  if (!tz) return fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return fallback
  }
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "Mon, Nov 2, 3:05 PM" in `tz` ("… 3:05 PM EST" with `zone`). */
export function formatDateTime(value: Date | string | number | null | undefined, tz?: string | null, options: { zone?: boolean } = {}): string {
  const d = toDate(value)
  if (!d) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(tz),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(options.zone ? { timeZoneName: 'short' as const } : {}),
  }).format(d)
}

/** "Nov 2, 2026" in `tz`. */
export function formatDate(value: Date | string | number | null | undefined, tz?: string | null): string {
  const d = toDate(value)
  if (!d) return '—'
  return new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone(tz), month: 'short', day: 'numeric', year: 'numeric' }).format(d)
}

/** "3:05 PM" in `tz`. */
export function formatTime(value: Date | string | number | null | undefined, tz?: string | null): string {
  const d = toDate(value)
  if (!d) return '—'
  return new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone(tz), hour: 'numeric', minute: '2-digit' }).format(d)
}

/** Milliseconds → "1:02:03" or "2:03" (or "0:05"). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Milliseconds → "1:02.5" style timestamp for transcripts and clip ranges ("mm:ss.s"). */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const totalSec = ms / 1000
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const tenths = Math.floor((ms % 1000) / 100)
  const base = `${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s).padStart(2, '0')}${tenths ? `.${tenths}` : ''}`
  return h > 0 ? `${h}:${base}` : base
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Decimal units (storage is sold in GB = 10^9 bytes). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  let n = bytes
  let unit = 0
  while (n >= 1000 && unit < BYTE_UNITS.length - 1) {
    n /= 1000
    unit += 1
  }
  const digits = unit === 0 || n >= 100 ? 0 : 1
  return `${n.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

/** Seconds of clipping time → "1.5 h" (one decimal), minutes below 0.1 h, "0 h" for nothing. */
export function formatClipHours(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 h'
  const hours = seconds / HOUR_SECONDS
  if (hours < 0.1) return `${Math.max(1, Math.round(seconds / 60))} min`
  const rounded = Math.round(hours * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} h`
}

/** 1234 → "1,234"; 12_345 → "12.3K"; 1_234_567 → "1.2M". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (Math.abs(n) < 10_000) return Math.round(n).toLocaleString('en-US')
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

/** Percent change → "+12.5%", "−3%", or "new" when there is no baseline. */
export function formatChange(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—'
  if (pct === 0) return '0%'
  const abs = Math.abs(pct)
  const text = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1)
  return `${pct > 0 ? '+' : '−'}${text}%`
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : pluralForm}`
}

/** Whole days from `now` until `date` (rounded up; never negative). */
export function daysUntil(date: Date | string | null | undefined, now: Date): number {
  const d = toDate(date)
  if (!d) return 0
  return Math.max(0, Math.ceil((d.getTime() - now.getTime()) / 86_400_000))
}

/** Shortens text for list rows. */
export function excerpt(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Percentage (0–100) of used/limit for meters; 100 when the limit is 0 and something is used. */
export function percentOf(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return 0
  if (limit <= 0) return used > 0 ? 100 : 0
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
}
