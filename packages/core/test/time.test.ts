import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  HOUR_MS,
  POST_METRIC_CHECKPOINTS_MS,
  addDays,
  backoffMs,
  calendarMonthPeriod,
  capQueryRange,
  fixedClock,
  formatMs,
  isWithin,
  manualClock,
  parseTimestampToMs,
  rollingWindow,
  systemClock,
  usagePeriod,
} from '../src/time'

const d = (s: string) => new Date(s)

describe('clocks', () => {
  it('fixedClock returns the same instant (fresh Date each time)', () => {
    const c = fixedClock('2026-01-02T03:04:05Z')
    const a = c.now()
    a.setUTCFullYear(1999)
    expect(c.now().toISOString()).toBe('2026-01-02T03:04:05.000Z')
    expect(() => fixedClock('nope')).toThrow(RangeError)
  })

  it('manualClock advances and can be set', () => {
    const c = manualClock('2026-01-01T00:00:00Z')
    expect(c.advance(HOUR_MS).toISOString()).toBe('2026-01-01T01:00:00.000Z')
    c.set('2026-02-01T00:00:00Z')
    expect(c.now().toISOString()).toBe('2026-02-01T00:00:00.000Z')
    expect(() => c.set('bad')).toThrow(RangeError)
  })

  it('systemClock is close to Date.now()', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000)
  })
})

describe('periods', () => {
  it('calendar month in UTC', () => {
    const p = calendarMonthPeriod(d('2026-12-31T23:59:59.999Z'))
    expect(p.start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(p.end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    const feb = calendarMonthPeriod(d('2028-02-29T12:00:00Z'))
    expect(feb.end.toISOString()).toBe('2028-03-01T00:00:00.000Z')
  })

  it('isWithin is half-open', () => {
    const p = calendarMonthPeriod(d('2026-05-10T00:00:00Z'))
    expect(isWithin(p, p.start)).toBe(true)
    expect(isWithin(p, p.end)).toBe(false)
  })

  it('usagePeriod prefers a current subscription period, else the calendar month', () => {
    const now = d('2026-05-20T00:00:00Z')
    const sub = { start: d('2026-05-15T10:00:00Z'), end: d('2026-06-15T10:00:00Z') }
    expect(usagePeriod(now, sub)).toEqual(sub)
    expect(usagePeriod(now, null).start.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    const stale = { start: d('2026-03-15T00:00:00Z'), end: d('2026-04-15T00:00:00Z') }
    expect(usagePeriod(now, stale).start.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(usagePeriod(now, { start: null, end: null }).start.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    const inverted = { start: sub.end, end: sub.start }
    expect(usagePeriod(now, inverted).start.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('rolling windows', () => {
    const end = d('2026-05-20T12:00:00Z')
    const w = rollingWindow(end)
    expect(w.end).toBe(end)
    expect(end.getTime() - w.start.getTime()).toBe(DAY_MS)
    const q = capQueryRange(end)
    expect(q.end.getTime() - end.getTime()).toBe(DAY_MS)
    expect(end.getTime() - q.start.getTime()).toBe(DAY_MS - 1)
    expect(addDays(end, 2).toISOString()).toBe('2026-05-22T12:00:00.000Z')
  })
})

describe('timestamps', () => {
  it.each([
    ['1:02:03', 3_723_000],
    ['01:02:03.5', 3_723_500],
    ['02:03', 123_000],
    ['2:03.25', 123_250],
    ['0:00.001', 1],
    ['12', 12_000],
    ['12.5s', 12_500],
    ['12,75', 12_750],
    [' 00:10 ', 10_000],
  ])('parses %s', (input, ms) => {
    expect(parseTimestampToMs(input)).toBe(ms)
  })

  it.each(['', 'abc', '1:60', '1:61:00', '-5', '1:2:3:4', '00:10.1234'])('rejects %s', (input) => {
    expect(parseTimestampToMs(input)).toBeNull()
  })

  it('formats ms', () => {
    expect(formatMs(3_723_500)).toBe('1:02:03.500')
    expect(formatMs(65_000)).toBe('1:05.000')
    expect(formatMs(-5)).toBe('0:00.000')
    expect(parseTimestampToMs(formatMs(3_723_500))).toBe(3_723_500)
  })
})

describe('backoff', () => {
  it('doubles from the base and caps', () => {
    expect(backoffMs(1, { baseMs: 1000 })).toBe(1000)
    expect(backoffMs(2, { baseMs: 1000 })).toBe(2000)
    expect(backoffMs(4, { baseMs: 1000 })).toBe(8000)
    expect(backoffMs(100, { baseMs: 1000, maxMs: 60_000 })).toBe(60_000)
    expect(backoffMs(0, { baseMs: 1000 })).toBe(1000)
  })

  it('applies jitter downwards only', () => {
    expect(backoffMs(3, { baseMs: 1000, jitter: 0.5, random: () => 1 })).toBe(2000)
    expect(backoffMs(3, { baseMs: 1000, jitter: 0.5, random: () => 0 })).toBe(4000)
  })

  it('has metric checkpoints at 24h, 48h, 7d, 30d', () => {
    expect(POST_METRIC_CHECKPOINTS_MS.map((ms) => ms / DAY_MS)).toEqual([1, 2, 7, 30])
  })
})
