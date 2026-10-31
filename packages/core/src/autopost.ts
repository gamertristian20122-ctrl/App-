// Auto-post: the defaults and pure helpers of the brand's Auto-post rule (docs/plans/02-auto-post.md).
// The rule itself lives in @app/services (autopost.ts); this module holds what the web app, the MCP
// server and the docs share: outcome names and messages, the daily-max bounds and the "best" time
// slots. Browser-safe (Intl only).

import { DAY_MS, MINUTE_MS } from './time'
import type { Platform } from './types'

export const AUTO_POST_DAILY_MAX = { min: 1, max: 25, default: 3 } as const

/**
 * What the rule decided for a draft (drafts.auto_post_outcome). It decides once, right after an AI
 * or the worker made the draft (or once its video finished processing).
 */
export const AUTO_POST_OUTCOMES = ['posted', 'switch_off', 'platform_not_allowed', 'daily_max', 'not_ready', 'cap_reached', 'skipped'] as const
export type AutoPostOutcome = (typeof AUTO_POST_OUTCOMES)[number]

/** Short labels for the web app ("Auto-post skipped: …"). */
export const AUTO_POST_OUTCOME_LABELS: Readonly<Record<AutoPostOutcome, string>> = {
  posted: 'Auto-posted',
  switch_off: 'Auto-post is off for this brand',
  platform_not_allowed: 'A platform is not on the Auto-post list',
  daily_max: 'Daily Auto-post limit reached',
  not_ready: 'Needs fixes before it can post',
  cap_reached: 'Platform limit reached at that time',
  skipped: 'Not eligible for Auto-post',
}

/**
 * "best": simple default posting slots per platform, as local wall-clock times in the brand's time
 * zone (common engagement peaks from public guidance; analytics may refine them later). The rule
 * takes the first slot at least BEST_SLOT_LEAD_MS ahead that is under the platform's 24 h cap.
 */
export const BEST_TIME_SLOTS: Readonly<Record<Platform, readonly string[]>> = {
  tiktok: ['12:00', '19:00'],
  youtube: ['15:00'],
  instagram: ['11:00', '19:00'],
  facebook: ['13:00'],
  threads: ['12:00'],
  x: ['09:00', '17:00'],
  linkedin: ['08:00', '12:00'],
  pinterest: ['20:00'],
  bluesky: ['10:00', '18:00'],
}

/** A "best" slot must be at least this far ahead (time to cancel it in the calendar). */
export const BEST_SLOT_LEAD_MS = 5 * MINUTE_MS

/** How far ahead "best" looks for a free slot. */
export const BEST_SLOT_DAYS = 7

/** "now": the start of the next whole minute (a minute to cancel it, and posts line up). */
export function nextMinute(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS)
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsCache.set(timeZone, f)
  }
  return f
}

/** Wall-clock fields of `at` in `timeZone`. */
export function zonedParts(at: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const out: Record<string, number> = {}
  for (const p of formatter(timeZone).formatToParts(at)) if (p.type !== 'literal') out[p.type] = Number(p.value)
  return { year: out.year ?? 1970, month: out.month ?? 1, day: out.day ?? 1, hour: (out.hour ?? 0) % 24, minute: out.minute ?? 0, second: out.second ?? 0 }
}

/** Offset of `timeZone` from UTC at `at`, in ms (positive east of UTC). */
function offsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The instant when the wall clock in `timeZone` shows y-m-d hh:mm (DST gaps move forward). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let at = guess - offsetMs(new Date(guess), timeZone)
  // a second pass settles DST transitions between the guess and the answer
  at = guess - offsetMs(new Date(at), timeZone)
  return new Date(at)
}

/**
 * Candidate "best" times for a platform: its slots in the brand's time zone over the next
 * BEST_SLOT_DAYS days, at least BEST_SLOT_LEAD_MS after `now`, earliest first.
 */
export function bestSlotTimes(platform: Platform, now: Date, timeZone: string, days: number = BEST_SLOT_DAYS): Date[] {
  const slots = BEST_TIME_SLOTS[platform]
  const earliest = now.getTime() + BEST_SLOT_LEAD_MS
  const out: Date[] = []
  for (let d = 0; d <= days; d++) {
    const day = zonedParts(new Date(now.getTime() + d * DAY_MS), timeZone)
    for (const slot of slots) {
      const [h, m] = slot.split(':').map(Number)
      const at = zonedTimeToUtc(day.year, day.month, day.day, h ?? 0, m ?? 0, timeZone)
      if (at.getTime() >= earliest && at.getTime() <= now.getTime() + (days + 1) * DAY_MS) out.push(at)
    }
  }
  return [...new Map(out.map((d) => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime())
}
