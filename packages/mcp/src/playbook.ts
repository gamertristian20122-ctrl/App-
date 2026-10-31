// Playbook text shared by the prompts (user-started) and the tools (model-started). Prompts are
// shortcuts the user picks; the model cannot call prompts/get itself (and ChatGPT does not show
// prompts), so every rule a prompt carries is also reachable through a tool result.

import { formatMs } from '@app/core/time'
import { PLATFORM_LABELS, type Metrics, type Platform, type TimedText } from '@app/core/types'
import { MAX_CLIP_RANGES } from '@app/core/validation'
import type { FollowerChange, WeeklyReview } from '@app/services'
import { excerpt } from './results'

/** Characters of transcript lines in one get_transcript / pick_clips response (about 10k tokens). */
export const TRANSCRIPT_TEXT_BUDGET = 40_000
/** Characters of word timings in one ranged get_transcript response. */
export const WORD_TEXT_BUDGET = 12_000
/** Word timings are given for ranges up to this long (ask for a narrower range otherwise). */
export const WORD_RANGE_MAX_MS = 5 * 60_000

export function segmentLine(s: TimedText): string {
  return `[${formatMs(s.s)}–${formatMs(s.e)} | ${s.s}–${s.e} ms] ${s.t}`
}

/**
 * The segments that fit the text budget, in order. `nextStartMs` is where the next page starts
 * (null when everything fits).
 */
export function pageSegments(segments: readonly TimedText[], budget = TRANSCRIPT_TEXT_BUDGET): { lines: string[]; shown: TimedText[]; nextStartMs: number | null } {
  const lines: string[] = []
  const shown: TimedText[] = []
  let used = 0
  for (const s of segments) {
    const line = segmentLine(s)
    if (shown.length > 0 && used + line.length + 1 > budget) return { lines, shown, nextStartMs: s.s }
    lines.push(line)
    shown.push(s)
    used += line.length + 1
  }
  return { lines, shown, nextStartMs: null }
}

/** Word timings as compact "word@startMs" tokens within the budget. */
export function wordTimings(words: readonly TimedText[], budget = WORD_TEXT_BUDGET): { text: string; shown: TimedText[]; complete: boolean } {
  const parts: string[] = []
  const shown: TimedText[] = []
  let used = 0
  for (const w of words) {
    const token = `${w.t.trim()}@${w.s}`
    if (used + token.length + 1 > budget) return { text: parts.join(' '), shown, complete: false }
    parts.push(token)
    shown.push(w)
    used += token.length + 1
  }
  return { text: parts.join(' '), shown, complete: true }
}

/** The clip-picking rules (pick_clips prompt and get_transcript). */
export function pickClipsRules(mediaId: string): string[] {
  return [
    '## What makes a good clip',
    '- Standalone: it makes sense to someone who has not seen the rest of the video. No "as I said", no unexplained "this/that/he", no references to slides or earlier parts.',
    '- Hook in the first 3 seconds: a surprising claim, a strong question, a bold opinion, a number, or the payoff stated up front. Start right on that sentence, not on filler ("so", "um", "yeah").',
    '- One complete thought with a payoff: it ends right after the point lands (punchline, answer, takeaway), not mid-sentence.',
    '- 20–90 seconds long (never under 3 s or over 180 s). Shorter is better when the thought is complete.',
    '- Prefer emotion, surprise, practical value, a story with a turn, or a contrarian take. Skip intros, outros, sponsor reads and housekeeping.',
    '- Clips must not overlap; spread them across the video.',
    '',
    '## How to cut',
    '1. Choose ranges from the segment timestamps (milliseconds). For a precise cut, call get_transcript with { mediaId, startMs, endMs } (5 minutes or less) around the moment to get word timings ("word@startMs"); start at the first word of the hook (minus ~150 ms) and end just after the last word of the payoff (plus ~300 ms).',
    '2. Show the user your picks (time range, a title of at most 100 characters, the hook line) and why each works. Let them drop or adjust any.',
    `3. Then call make_clips { mediaId: "${mediaId}", ranges: [{ startMs, endMs, title, hook }], captionStyle?: "bold" | "minimal" | "karaoke" | "none" } with at most ${MAX_CLIP_RANGES} ranges.`,
    '4. Each rendered clip becomes a draft. The user approves it in the approval card (approve_draft) before anything is scheduled. Never schedule without approval.',
  ]
}

// ---------------------------------------------------------------------------------------------
// Analytics text (get_analytics and the weekly_review prompt)
// ---------------------------------------------------------------------------------------------

const METRIC_ORDER: readonly (keyof Metrics)[] = ['views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves']

export function metricsText(m: Metrics): string {
  const parts = METRIC_ORDER.filter((k) => typeof m[k] === 'number').map((k) => `${k} ${(m[k] as number).toLocaleString('en-US')}`)
  return parts.length > 0 ? parts.join(', ') : 'no metrics yet'
}

export function followersText(f: readonly FollowerChange[]): string {
  const parts = f
    .filter((x) => x.followers !== null)
    .map((x) => `${PLATFORM_LABELS[x.platform]} ${x.followers?.toLocaleString('en-US')}${x.change !== null ? ` (${x.change >= 0 ? '+' : ''}${x.change})` : ''}`)
  return parts.length > 0 ? parts.join(', ') : 'no follower data yet'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'n/a'
  return `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10}%`
}

export function weeklyReviewText(r: WeeklyReview): string {
  const lines: string[] = []
  const day = (d: Date) => d.toISOString().slice(0, 10)
  lines.push(`## Last 7 days (${day(r.current.from)} to ${day(r.current.to)}) vs the previous 7 days`)
  lines.push(`- Posts: ${r.current.posts} (previous ${r.previous.posts}, ${pct(r.change.posts)})`)
  lines.push(`- This week: ${metricsText(r.current.metrics)}`)
  lines.push(`- Previous week: ${metricsText(r.previous.metrics)}`)
  const changes = Object.entries(r.change)
    .filter(([k]) => k !== 'posts')
    .map(([k, v]) => `${k} ${pct(v)}`)
  if (changes.length > 0) lines.push(`- Change: ${changes.join(', ')}`)
  const byPlatform = Object.entries(r.current.byPlatform)
  if (byPlatform.length > 0) {
    lines.push('- By platform this week:')
    for (const [p, v] of byPlatform) if (v) lines.push(`  - ${PLATFORM_LABELS[p as Platform]}: ${v.posts} posts; ${metricsText(v.metrics)}`)
  }
  lines.push(`- Followers: ${followersText(r.followers)}`)
  const postLine = (p: WeeklyReview['topPosts'][number]) =>
    `  - ${PLATFORM_LABELS[p.platform]}, ${p.publishedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC: "${excerpt(p.excerpt, 120)}" (${metricsText(p.metrics)}, score ${Math.round(p.score)})`
  if (r.topPosts.length > 0) lines.push('- Top posts:', ...r.topPosts.map(postLine))
  if (r.bottomPosts.length > 0) lines.push('- Weakest posts:', ...r.bottomPosts.map(postLine))
  const days = r.cadence.byWeekday.map((c, i) => (c > 0 ? `${WEEKDAYS[i]} ${c}` : null)).filter(Boolean)
  const hours = r.cadence.byHour.map((c, h) => (c > 0 ? `${String(h).padStart(2, '0')}:00 ${c}` : null)).filter(Boolean)
  lines.push(`- Posting days (${r.brand.timezone}): ${days.length > 0 ? days.join(', ') : 'none'}; hours: ${hours.length > 0 ? hours.join(', ') : 'none'}`)
  lines.push(`- Pipeline: ${r.upcoming.scheduled} scheduled, ${r.upcoming.drafts} drafts waiting for approval`)
  lines.push(`- Voice profile: ${r.voiceProfileVersion === null ? 'none yet' : `version ${r.voiceProfileVersion}`}; imported past posts: ${r.importedPosts}`)
  return lines.join('\n')
}

/** What to do with a weekly review (weekly_review prompt and get_analytics with a brandId). */
export const WEEKLY_REVIEW_STEPS: readonly string[] = [
  '## What to do with this review',
  '1. Summarise in 3–5 bullets what worked and what did not, citing the numbers above (compare with the previous week). Say so when there is too little data to conclude anything.',
  '2. Propose exactly 3 concrete experiments for next week. For each: the hypothesis, the exact change (format, hook style, topic, posting day/time, platform, length), how many posts, and the metric that decides success.',
  '3. For each experiment, suggest 1–2 draft posts (per platform text) in the brand voice (read it with list_accounts { brandId }).',
  '4. Ask the user which experiments to run. Only then save the posts with create_draft and show each with approve_draft. Never schedule anything the user has not approved.',
  '5. If posts or analytics are missing, suggest import_past_posts or connecting accounts instead of guessing.',
]

