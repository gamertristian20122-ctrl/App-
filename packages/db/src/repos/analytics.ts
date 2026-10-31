import type { Metrics, Platform, SnapshotScope } from '@app/core/types'
import { camelRow, camelRows, json, many } from '../sql'
import type { Db } from '../types'

export interface SnapshotRow {
  id: string
  userId: string
  brandId: string
  platform: Platform
  postId: string | null
  pastPostId: string | null
  connectedAccountId: string | null
  scope: SnapshotScope
  capturedAt: Date
  metrics: Metrics
  createdAt: Date
}

const map = (row: Record<string, unknown> | null): SnapshotRow | null => (row ? camelRow<SnapshotRow>(row) : null)

export interface SnapshotInput {
  brandId: string
  platform: Platform
  scope: SnapshotScope
  /** scope 'post': exactly one of postId / pastPostId. */
  postId?: string | null
  pastPostId?: string | null
  connectedAccountId?: string | null
  capturedAt?: Date
  /** Numbers only (core pickMetrics); other keys are refused by a CHECK. */
  metrics: Metrics
}

export async function insert(db: Db, userId: string, input: SnapshotInput): Promise<SnapshotRow> {
  const row = await db.one(
    `insert into public.analytics_snapshots
       (user_id, brand_id, platform, post_id, past_post_id, connected_account_id, scope, captured_at, metrics)
     values ($1, $2, $3::public.platform, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9::text::jsonb)
     returning *`,
    [
      userId,
      input.brandId,
      input.platform,
      input.postId ?? null,
      input.pastPostId ?? null,
      input.connectedAccountId ?? null,
      input.scope,
      input.capturedAt ?? null,
      json(input.metrics),
    ],
  )
  return map(row) as SnapshotRow
}

export interface ListSnapshotsOptions {
  scope?: SnapshotScope
  platform?: Platform | readonly Platform[]
  from?: Date
  to?: Date
  limit?: number
}

/** A brand's snapshots captured in [from, to), oldest first. */
export async function listForBrand(
  db: Db,
  userId: string,
  brandId: string,
  options: ListSnapshotsOptions = {},
): Promise<SnapshotRow[]> {
  const rows = await db.query(
    `select * from public.analytics_snapshots
      where user_id = $1 and brand_id = $2
        and ($3::text is null or scope = $3)
        and ($4::text[]::public.platform[] is null or platform = any($4::text[]::public.platform[]))
        and ($5::timestamptz is null or captured_at >= $5::timestamptz)
        and ($6::timestamptz is null or captured_at < $6::timestamptz)
      order by captured_at, id
      limit $7`,
    [
      userId,
      brandId,
      options.scope ?? null,
      many(options.platform),
      options.from ?? null,
      options.to ?? null,
      Math.max(1, Math.min(10_000, options.limit ?? 5_000)),
    ],
  )
  return camelRows<SnapshotRow>(rows)
}

/** The latest snapshot of each given post (posts without a snapshot are absent). */
export async function latestForPosts(db: Db, userId: string, postIds: readonly string[]): Promise<SnapshotRow[]> {
  if (postIds.length === 0) return []
  const rows = await db.query(
    `select distinct on (post_id) * from public.analytics_snapshots
      where user_id = $1 and post_id = any($2::uuid[])
      order by post_id, captured_at desc, id desc`,
    [userId, [...postIds]],
  )
  return camelRows<SnapshotRow>(rows)
}

/** The latest account-scope snapshot per platform for a brand, captured before `before`. */
export async function latestAccountSnapshots(
  db: Db,
  userId: string,
  brandId: string,
  before?: Date,
): Promise<SnapshotRow[]> {
  const rows = await db.query(
    `select distinct on (platform) * from public.analytics_snapshots
      where user_id = $1 and brand_id = $2 and scope = 'account'
        and ($3::timestamptz is null or captured_at < $3::timestamptz)
      order by platform, captured_at desc, id desc`,
    [userId, brandId, before ?? null],
  )
  return camelRows<SnapshotRow>(rows)
}

export interface PostPerformanceRow {
  postId: string
  draftId: string
  platform: Platform
  publishedAt: Date
  postUrl: string | null
  text: string
  title: string | null
  /** Latest snapshot metrics, or {} when none yet. */
  metrics: Metrics
  capturedAt: Date | null
}

/** Posts of a brand published in [from, to) with their latest metrics (weekly review). */
export async function postPerformance(
  db: Db,
  userId: string,
  brandId: string,
  from: Date,
  to: Date,
): Promise<PostPerformanceRow[]> {
  const rows = await db.query(
    `select p.id as post_id, p.draft_id, p.platform, p.published_at, p.post_url, v.text, v.title,
            coalesce(s.metrics, '{}'::jsonb) as metrics, s.captured_at
       from public.posts p
       join public.draft_variants v on v.id = p.variant_id
       left join lateral (
         select metrics, captured_at from public.analytics_snapshots a
          where a.post_id = p.id
          order by a.captured_at desc, a.id desc
          limit 1
       ) s on true
      where p.user_id = $1 and p.brand_id = $2 and p.status = 'published'
        and p.published_at >= $3::timestamptz and p.published_at < $4::timestamptz
      order by p.published_at`,
    [userId, brandId, from, to],
  )
  return camelRows<PostPerformanceRow>(rows)
}
