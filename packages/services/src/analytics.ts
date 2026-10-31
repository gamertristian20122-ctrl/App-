// Analytics: get_analytics summaries and the weekly_review data (last 7 days vs the previous 7),
// plus the worker's metric snapshots (post checkpoints and daily account totals).

import { z } from 'zod'
import { DAY_MS, addMs } from '@app/core/time'
import { METRIC_KEYS, pickMetrics, PLATFORMS, type Metrics, type Platform } from '@app/core/types'
import { GetAnalyticsInputSchema } from '@app/core/validation'
import type { BoundRepos, BrandRow, PostPerformanceRow, SnapshotRow } from '@app/db'
import { conflict, fromZod, requireBrand, requirePost, userIdOf, withErrors, type Ctx } from './context'
import { enqueueJob } from './jobs'
import { engagementScore } from './voice'

export interface PostPerformance {
  postId: string
  draftId: string
  platform: Platform
  publishedAt: Date
  url: string | null
  /** First 200 characters of the text. */
  excerpt: string
  title: string | null
  metrics: Metrics
  score: number
  measuredAt: Date | null
}

export interface PeriodTotals {
  from: Date
  to: Date
  posts: number
  /** Sum of each metric over the period's posts (latest snapshot per post). */
  metrics: Metrics
  score: number
  byPlatform: Partial<Record<Platform, { posts: number; metrics: Metrics; score: number }>>
}

export interface FollowerChange {
  platform: Platform
  followers: number | null
  previous: number | null
  change: number | null
}

export interface BrandAnalytics {
  brand: { id: string; name: string }
  period: PeriodTotals
  topPosts: PostPerformance[]
  followers: FollowerChange[]
}

export interface WeeklyReview {
  brand: { id: string; name: string; timezone: string }
  generatedAt: Date
  current: PeriodTotals
  previous: PeriodTotals
  /** Percent change per metric (null when the previous value is 0). */
  change: Partial<Record<keyof Metrics | 'posts' | 'score', number | null>>
  topPosts: PostPerformance[]
  bottomPosts: PostPerformance[]
  followers: FollowerChange[]
  /** Posts per weekday (0 = Sunday) and hour (brand time zone) for the current week. */
  cadence: { byWeekday: number[]; byHour: number[] }
  upcoming: { scheduled: number; drafts: number }
  voiceProfileVersion: number | null
  importedPosts: number
}

function addMetrics(into: Metrics, m: Metrics): void {
  for (const key of METRIC_KEYS) {
    const v = m[key]
    if (typeof v === 'number') into[key] = (into[key] ?? 0) + v
  }
}

function toPerformance(row: PostPerformanceRow): PostPerformance {
  const metrics = pickMetrics(row.metrics)
  return {
    postId: row.postId,
    draftId: row.draftId,
    platform: row.platform,
    publishedAt: new Date(row.publishedAt),
    url: row.postUrl,
    excerpt: (row.text ?? '').slice(0, 200),
    title: row.title,
    metrics,
    score: Math.round(engagementScore(metrics) * 100) / 100,
    measuredAt: row.capturedAt ? new Date(row.capturedAt) : null,
  }
}

function totalsOf(posts: readonly PostPerformance[], from: Date, to: Date): PeriodTotals {
  const metrics: Metrics = {}
  const byPlatform: PeriodTotals['byPlatform'] = {}
  let score = 0
  for (const p of posts) {
    addMetrics(metrics, p.metrics)
    score += p.score
    const slot = (byPlatform[p.platform] ??= { posts: 0, metrics: {}, score: 0 })
    slot.posts += 1
    addMetrics(slot.metrics, p.metrics)
    slot.score += p.score
  }
  return { from, to, posts: posts.length, metrics, score: Math.round(score * 100) / 100, byPlatform }
}

function pct(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

function followerChanges(latest: SnapshotRow[], earlier: SnapshotRow[], platform?: Platform): FollowerChange[] {
  const before = new Map(earlier.map((s) => [s.platform, s.metrics.followers ?? null]))
  return latest
    .filter((s) => !platform || s.platform === platform)
    .map((s) => {
      const followers = s.metrics.followers ?? null
      const previous = before.get(s.platform) ?? null
      return { platform: s.platform, followers, previous, change: followers !== null && previous !== null ? followers - previous : null }
    })
}

function zonedParts(date: Date, timeZone: string): { weekday: number; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date)
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
    return { weekday: weekday < 0 ? 0 : weekday, hour: Number.isFinite(hour) ? hour % 24 : 0 }
  } catch {
    return { weekday: date.getUTCDay(), hour: date.getUTCHours() }
  }
}

const AccountMetricsSchema = z.object({ brandId: z.string(), platform: z.enum(PLATFORMS) })

export function createAnalyticsService(ctx: Ctx) {
  async function performance(r: BoundRepos, userId: string, brandId: string, from: Date, to: Date, platform?: Platform) {
    const rows = await r.analytics.postPerformance(userId, brandId, from, to)
    return rows.map(toPerformance).filter((p) => !platform || p.platform === platform)
  }

  async function brandAnalytics(userId: string, brand: BrandRow, days: number, platform?: Platform): Promise<BrandAnalytics> {
    const r = ctx.repos
    const to = ctx.now()
    const from = addMs(to, -days * DAY_MS)
    const posts = await performance(r, userId, brand.id, from, to, platform)
    const latest = await r.analytics.latestAccountSnapshots(userId, brand.id)
    const earlier = await r.analytics.latestAccountSnapshots(userId, brand.id, from)
    return {
      brand: { id: brand.id, name: brand.name },
      period: totalsOf(posts, from, to),
      topPosts: [...posts].sort((a, b) => b.score - a.score).slice(0, 5),
      followers: followerChanges(latest, earlier, platform),
    }
  }

  return withErrors({
    /** get_analytics: one brand (or every active brand) over the last N days. */
    async summary(userId: string, input: unknown = {}): Promise<BrandAnalytics[]> {
      const uid = userIdOf(userId)
      const data = fromZod(GetAnalyticsInputSchema, input ?? {}, 'Analytics request')
      const brands = data.brandId
        ? [await requireBrand(ctx.repos, uid, data.brandId)]
        : await ctx.repos.brands.list(uid, { status: 'active' })
      const out: BrandAnalytics[] = []
      for (const brand of brands) out.push(await brandAnalytics(uid, brand, data.days, data.platform))
      return out
    },

    /** weekly_review data: the last 7 days vs the 7 before, best and worst posts, cadence. */
    async weeklyReview(userId: string, brandId: string): Promise<WeeklyReview> {
      const uid = userIdOf(userId)
      const r = ctx.repos
      const brand = await requireBrand(r, uid, brandId)
      const now = ctx.now()
      const weekAgo = addMs(now, -7 * DAY_MS)
      const twoWeeksAgo = addMs(now, -14 * DAY_MS)
      const current = await performance(r, uid, brand.id, weekAgo, now)
      const previous = await performance(r, uid, brand.id, twoWeeksAgo, weekAgo)
      const cur = totalsOf(current, weekAgo, now)
      const prev = totalsOf(previous, twoWeeksAgo, weekAgo)
      const change: WeeklyReview['change'] = { posts: pct(cur.posts, prev.posts), score: pct(cur.score, prev.score) }
      for (const key of METRIC_KEYS) {
        if (cur.metrics[key] !== undefined || prev.metrics[key] !== undefined) change[key] = pct(cur.metrics[key] ?? 0, prev.metrics[key] ?? 0)
      }
      const ranked = [...current].sort((a, b) => b.score - a.score)
      const top = ranked.slice(0, 3)
      const bottom = ranked.length > 3 ? ranked.slice(-3).reverse() : []
      const byWeekday = Array.from({ length: 7 }, () => 0)
      const byHour = Array.from({ length: 24 }, () => 0)
      for (const p of current) {
        const { weekday, hour } = zonedParts(p.publishedAt, brand.timezone)
        byWeekday[weekday] = (byWeekday[weekday] ?? 0) + 1
        byHour[hour] = (byHour[hour] ?? 0) + 1
      }
      const latest = await r.analytics.latestAccountSnapshots(uid, brand.id)
      const earlier = await r.analytics.latestAccountSnapshots(uid, brand.id, weekAgo)
      const scheduled = await r.posts.list(uid, { brandId: brand.id, status: 'scheduled', from: now, to: addMs(now, 7 * DAY_MS), limit: 1000 })
      const drafts = await r.drafts.list(uid, { brandId: brand.id, status: 'draft', limit: 500 })
      const voice = await r.voice.getLatest(uid, brand.id)
      return {
        brand: { id: brand.id, name: brand.name, timezone: brand.timezone },
        generatedAt: now,
        current: cur,
        previous: prev,
        change,
        topPosts: top,
        bottomPosts: bottom,
        followers: followerChanges(latest, earlier),
        cadence: { byWeekday, byHour },
        upcoming: { scheduled: scheduled.length, drafts: drafts.length },
        voiceProfileVersion: voice?.version ?? null,
        importedPosts: await r.pastPosts.count(uid, brand.id),
      }
    },

    /** Worker (analytics_pull, post scope): stores a metrics snapshot of a published post. */
    async recordPostMetrics(userId: string, postId: string, metrics: unknown, capturedAt?: Date): Promise<SnapshotRow> {
      const uid = userIdOf(userId)
      const post = await requirePost(ctx.repos, uid, postId)
      if (post.status !== 'published') throw conflict('Only published posts have metrics.')
      return ctx.repos.analytics.insert(uid, {
        brandId: post.brandId,
        platform: post.platform,
        scope: 'post',
        postId: post.id,
        connectedAccountId: post.connectedAccountId,
        capturedAt: capturedAt ?? ctx.now(),
        metrics: pickMetrics(metrics),
      })
    },

    /** Worker (analytics_pull, account scope): daily account totals (followers, reach, ...). */
    async recordAccountMetrics(userId: string, input: { brandId: string; platform: Platform; metrics: unknown; capturedAt?: Date }): Promise<SnapshotRow> {
      const uid = userIdOf(userId)
      const data = fromZod(AccountMetricsSchema, { brandId: input.brandId, platform: input.platform }, 'Account metrics')
      const brand = await requireBrand(ctx.repos, uid, data.brandId)
      const account = await ctx.repos.accounts.findLive(uid, brand.id, data.platform)
      return ctx.repos.analytics.insert(uid, {
        brandId: brand.id,
        platform: data.platform,
        scope: 'account',
        connectedAccountId: account?.id ?? null,
        capturedAt: input.capturedAt ?? ctx.now(),
        metrics: pickMetrics(input.metrics),
      })
    },

    /** Cron (daily): one account-metrics job per active brand with connected accounts. System-level. */
    async enqueueDailyAccountPulls(now: Date = ctx.now()): Promise<number> {
      const brands = await ctx.repos.maintenance.listBrandsForAnalytics()
      const day = now.toISOString().slice(0, 10)
      let created = 0
      for (const b of brands) {
        const res = await enqueueJob(ctx.repos, {
          type: 'analytics_pull',
          payload: { scope: 'account', userId: b.userId, brandId: b.brandId },
          idempotencyKey: `analytics_pull:account:${b.brandId}:${day}`,
        })
        if (res.created) created += 1
      }
      return created
    },
  })
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>
