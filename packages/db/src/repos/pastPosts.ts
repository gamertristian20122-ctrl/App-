import type { Metrics, Platform } from '@app/core/types'
import { camelRow, camelRows, clampLimit, json } from '../sql'
import type { Db } from '../types'

export interface PastPostRow {
  id: string
  userId: string
  brandId: string
  platform: Platform
  externalPostId: string
  text: string | null
  mediaType: string | null
  postedAt: Date | null
  permalink: string | null
  metrics: Metrics
  createdAt: Date
  updatedAt: Date
}

const map = (row: Record<string, unknown> | null): PastPostRow | null => (row ? camelRow<PastPostRow>(row) : null)

export interface PastPostInput {
  platform: Platform
  externalPostId: string
  text?: string | null
  mediaType?: string | null
  postedAt?: Date | null
  permalink?: string | null
  /** Numbers only (core pickMetrics). */
  metrics?: Metrics
}

/** Inserts or refreshes one imported post (unique per brand, platform and external id). */
export async function upsert(db: Db, userId: string, brandId: string, input: PastPostInput): Promise<PastPostRow> {
  const row = await db.one(
    `insert into public.past_posts as p (user_id, brand_id, platform, external_post_id, text, media_type, posted_at, permalink, metrics)
     values ($1, $2, $3::public.platform, $4, $5, $6, $7::timestamptz, $8, coalesce($9::text::jsonb, '{}'::jsonb))
     on conflict (brand_id, platform, external_post_id) do update set
       text = coalesce(excluded.text, p.text),
       media_type = coalesce(excluded.media_type, p.media_type),
       posted_at = coalesce(excluded.posted_at, p.posted_at),
       permalink = coalesce(excluded.permalink, p.permalink),
       metrics = case when $9::text is null then p.metrics else excluded.metrics end
     where p.user_id = excluded.user_id
     returning *`,
    [
      userId,
      brandId,
      input.platform,
      input.externalPostId,
      input.text ?? null,
      input.mediaType ?? null,
      input.postedAt ?? null,
      input.permalink ?? null,
      input.metrics ? json(input.metrics) : null,
    ],
  )
  if (!row) throw new Error('past post belongs to another user')
  return map(row) as PastPostRow
}

/** Upserts a batch in one transaction; returns the rows in input order. */
export async function upsertMany(
  db: Db,
  userId: string,
  brandId: string,
  inputs: readonly PastPostInput[],
): Promise<PastPostRow[]> {
  return db.tx(async (tx) => {
    const out: PastPostRow[] = []
    for (const input of inputs) out.push(await upsert(tx, userId, brandId, input))
    return out
  })
}

export async function get(db: Db, userId: string, pastPostId: string): Promise<PastPostRow | null> {
  return map(await db.one('select * from public.past_posts where id = $1 and user_id = $2', [pastPostId, userId]))
}

export interface ListPastPostsOptions {
  platform?: Platform
  since?: Date
  limit?: number
}

/** Newest first (by posted_at). */
export async function list(db: Db, userId: string, brandId: string, options: ListPastPostsOptions = {}): Promise<PastPostRow[]> {
  const rows = await db.query(
    `select * from public.past_posts
      where user_id = $1 and brand_id = $2
        and ($3::public.platform is null or platform = $3)
        and ($4::timestamptz is null or posted_at >= $4::timestamptz)
      order by posted_at desc nulls last, id
      limit $5`,
    [userId, brandId, options.platform ?? null, options.since ?? null, clampLimit(options.limit, 100, 1000)],
  )
  return camelRows<PastPostRow>(rows)
}

export async function count(db: Db, userId: string, brandId: string): Promise<number> {
  const row = await db.one<{ n: number }>(
    'select count(*)::int as n from public.past_posts where user_id = $1 and brand_id = $2',
    [userId, brandId],
  )
  return row?.n ?? 0
}
