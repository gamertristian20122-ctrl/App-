// Time helpers: clocks, usage periods, rolling windows, timestamps and backoff.

import type { Clock } from './ports'

export const SECOND_MS = 1_000
export const MINUTE_MS = 60 * SECOND_MS
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
export const ROLLING_24H_MS = DAY_MS

// Clocks -------------------------------------------------------------------

export const systemClock: Clock = { now: () => new Date() }

/** A clock frozen at `at`. */
export function fixedClock(at: Date | string | number): Clock {
  const ms = new Date(at).getTime()
  if (Number.isNaN(ms)) throw new RangeError('fixedClock: invalid date')
  return { now: () => new Date(ms) }
}

export interface ManualClock extends Clock {
  set(at: Date | string | number): void
  advance(ms: number): Date
}

/** A clock tests can move forward explicitly. */
export function manualClock(start: Date | string | number = 0): ManualClock {
  let ms = new Date(start).getTime()
  if (Number.isNaN(ms)) throw new RangeError('manualClock: invalid date')
  return {
    now: () => new Date(ms),
    set(at) {
      const next = new Date(at).getTime()
      if (Number.isNaN(next)) throw new RangeError('manualClock: invalid date')
      ms = next
    },
    advance(delta) {
      ms += delta
      return new Date(ms)
    },
  }
}

// Arithmetic ---------------------------------------------------------------

export const addMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms)
export const addDays = (date: Date, days: number): Date => addMs(date, days * DAY_MS)
export const toIso = (date: Date): string => date.toISOString()

// Periods ------------------------------------------------------------------

/** Half-open interval [start, end). */
export interface Period {
  start: Date
  end: Date
}

export function isWithin(period: Period, at: Date): boolean {
  const t = at.getTime()
  return t >= period.start.getTime() && t < period.end.getTime()
}

/** The UTC calendar month containing `at`: [first day 00:00Z, first day of next month 00:00Z). */
export function calendarMonthPeriod(at: Date): Period {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
  return { start, end }
}

/**
 * The usage-metering period for `now`. With a Stripe subscription period that contains `now`
 * we use it. When that period has already ended (the renewal webhook is late or failed) it is
 * rolled forward from its end with the same length, so a late webhook never opens a fresh
 * calendar-month allowance next to the Stripe one (Stripe periods are contiguous: the rolled
 * start is the real next start). Without a period (no subscription) the UTC calendar month.
 */
export function usagePeriod(now: Date, subscriptionPeriod?: { start: Date | null; end: Date | null } | null): Period {
  const start = subscriptionPeriod?.start
  const end = subscriptionPeriod?.end
  if (start && end && start.getTime() < end.getTime()) {
    const period = { start, end }
    if (isWithin(period, now)) return period
    if (now.getTime() >= end.getTime()) {
      const length = end.getTime() - start.getTime()
      const n = Math.floor((now.getTime() - start.getTime()) / length)
      return { start: new Date(start.getTime() + n * length), end: new Date(start.getTime() + (n + 1) * length) }
    }
  }
  return calendarMonthPeriod(now)
}

/** The rolling window of `lengthMs` ending at `end`: [end − length, end). */
export function rollingWindow(end: Date, lengthMs: number = ROLLING_24H_MS): Period {
  return { start: addMs(end, -lengthMs), end }
}

/**
 * The span of existing posts to load when checking a rolling-window cap for a post at `at`:
 * every window of `lengthMs` that contains `at` lies inside (at − length, at + length).
 * Feed the loaded times to `countInBusiestWindow()` from platforms.ts.
 */
export function capQueryRange(at: Date, lengthMs: number = ROLLING_24H_MS): Period {
  return { start: addMs(at, -lengthMs + 1), end: addMs(at, lengthMs) }
}

// Timestamps (clip ranges) ------------------------------------------------

const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/
const SECONDS_RE = /^(\d+)(?:[.,](\d{1,3}))?s?$/

/**
 * Parses "hh:mm:ss(.mmm)", "mm:ss(.mmm)" or "ss(.mmm)" (optionally suffixed with "s") into ms.
 * Returns null for anything else.
 */
export function parseTimestampToMs(input: string): number | null {
  const s = input.trim()
  const fraction = (f: string | undefined) => (f ? Number(f.padEnd(3, '0')) : 0)
  const m = TIMESTAMP_RE.exec(s)
  if (m) {
    const hours = m[1] ? Number(m[1]) : 0
    const minutes = Number(m[2])
    const seconds = Number(m[3])
    if (seconds >= 60) return null
    if (m[1] !== undefined && minutes >= 60) return null
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction(m[4])
  }
  const sec = SECONDS_RE.exec(s)
  if (sec) return Number(sec[1]) * 1000 + fraction(sec[2])
  return null
}

/** Formats ms as "h:mm:ss.mmm" (hours omitted when zero: "m:ss.mmm"). */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const millis = total % 1000
  const totalSeconds = Math.floor(total / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const mmss = `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${mmss}` : `${minutes}:${mmss}`
}

// Backoff ------------------------------------------------------------------

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  /** 0..1, fraction of the delay to randomise (subtracted). Default 0 (deterministic). */
  jitter?: number
  random?: () => number
}

/** Exponential backoff for retry `attempt` (1-based): base · 2^(attempt−1), capped at max. */
export function backoffMs(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 30 * SECOND_MS, maxMs = 6 * HOUR_MS, jitter = 0, random = Math.random } = options
  const n = Math.max(1, Math.floor(attempt))
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 40))
  if (jitter <= 0) return raw
  const j = Math.min(1, jitter)
  return Math.round(raw - raw * j * random())
}

/** When post metrics are pulled after publishing (24h, 48h, 7d, 30d). */
export const POST_METRIC_CHECKPOINTS_MS = [DAY_MS, 2 * DAY_MS, 7 * DAY_MS, 30 * DAY_MS] as const
