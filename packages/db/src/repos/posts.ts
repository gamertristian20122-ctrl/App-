import type { Platform, PostStatus } from '@app/core/types'
import { camelRow, camelRows, clampLimit, many, truncate } from '../sql'
import type { Db } from '../types'

export interface PostRow {
  id: string
  userId: string
  brandId: string
  draftId: string
  variantId: string
  connectedAccountId: string
  platform: Platform
  scheduledFor: Date
  status: PostStatus
  approvedRevision: number
  provider: string
  providerRequestId: string | null
  providerPostId: string | null
  postUrl: string | null
  error: string | null
  attempts: number
  publishedAt: Date | null
  canceledAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const map = (row: Record<string, unknown> | null): PostRow | null => (row ? camelRow<PostRow>(row) : null)

export interface CreatePostInput {
  brandId: string
  draftId: string
  variantId: string
  connectedAccountId: string
  platform: Platform
  scheduledFor: Date
  /** Must equal the draft's current revision, and the draft must be approved at it (trigger). */
  approvedRevision: number
  provider: string
}

/** Schedules a post. Raises P0A01 unless the draft is approved at approvedRevision. */
export async function create(db: Db, userId: string, input: CreatePostInput): Promise<PostRow> {
  const row = await db.one(
    `insert into public.posts
       (user_id, brand_id, draft_id, variant_id, connected_account_id, platform, scheduled_for, approved_revision, provider)
     values ($1, $2, $3, $4, $5, $6::public.platform, $7::timestamptz, $8::int, $9)
     returning *`,
    [
      userId,
      input.brandId,
      input.draftId,
      input.variantId,
      input.connectedAccountId,
      input.platform,
      input.scheduledFor,
      input.approvedRevision,
      input.provider,
    ],
  )
  return map(row) as PostRow
}

export async function get(db: Db, userId: string, postId: string): Promise<PostRow | null> {
  return map(await db.one('select * from public.posts where id = $1 and user_id = $2', [postId, userId]))
}

export interface ListPostsOptions {
  brandId?: string
  draftId?: string
  connectedAccountId?: string
  status?: PostStatus | readonly PostStatus[]
  /** scheduled_for >= from */
  from?: Date
  /** scheduled_for < to */
  to?: Date
  limit?: number
}

/** Ordered by scheduled_for (calendar order). */
export async function list(db: Db, userId: string, options: ListPostsOptions = {}): Promise<PostRow[]> {
  const rows = await db.query(
    `select * from public.posts
      where user_id = $1
        and ($2::uuid is null or brand_id = $2)
        and ($3::uuid is null or draft_id = $3)
        and ($4::uuid is null or connected_account_id = $4)
        and ($5::text[]::public.post_status[] is null or status = any($5::text[]::public.post_status[]))
        and ($6::timestamptz is null or scheduled_for >= $6::timestamptz)
        and ($7::timestamptz is null or scheduled_for < $7::timestamptz)
      order by scheduled_for, id
      limit $8`,
    [
      userId,
      options.brandId ?? null,
      options.draftId ?? null,
      options.connectedAccountId ?? null,
      many(options.status),
      options.from ?? null,
      options.to ?? null,
      clampLimit(options.limit, 200, 1000),
    ],
  )
  return camelRows<PostRow>(rows)
}

/**
 * Active posts (scheduled, publishing, published) of an account whose time — published_at
 * when published, else scheduled_for — falls in [from, to). Used for platform caps.
 */
export async function countInWindow(db: Db, userId: string, accountId: string, from: Date, to: Date): Promise<number> {
  const row = await db.one<{ n: number }>(
    `select count(*)::int as n from public.posts
      where connected_account_id = $1 and user_id = $2
        and status in ('scheduled', 'publishing', 'published')
        and coalesce(published_at, scheduled_for) >= $3::timestamptz
        and coalesce(published_at, scheduled_for) < $4::timestamptz`,
    [accountId, userId, from, to],
  )
  return row?.n ?? 0
}

/** The times counted by countInWindow, ascending (for core platforms.wouldExceedCap). */
export async function activeTimesInRange(db: Db, userId: string, accountId: string, from: Date, to: Date): Promise<Date[]> {
  const rows = await db.query<{ at: Date }>(
    `select coalesce(published_at, scheduled_for) as at from public.posts
      where connected_account_id = $1 and user_id = $2
        and status in ('scheduled', 'publishing', 'published')
        and coalesce(published_at, scheduled_for) >= $3::timestamptz
        and coalesce(published_at, scheduled_for) < $4::timestamptz
      order by 1`,
    [accountId, userId, from, to],
  )
  return rows.map((r) => new Date(r.at))
}

/** Moves a scheduled post to another time (no re-approval needed). */
export async function reschedule(db: Db, userId: string, postId: string, scheduledFor: Date): Promise<PostRow | null> {
  return map(
    await db.one(
      `update public.posts set scheduled_for = $3::timestamptz
        where id = $1 and user_id = $2 and status = 'scheduled'
        returning *`,
      [postId, userId, scheduledFor],
    ),
  )
}

/** Cancels a scheduled or failed post. Returns null if it is publishing or done. */
export async function cancel(db: Db, userId: string, postId: string, reason?: string | null): Promise<PostRow | null> {
  return map(
    await db.one(
      `update public.posts set status = 'canceled', canceled_at = now(), error = coalesce($3, error)
        where id = $1 and user_id = $2 and status in ('scheduled', 'failed')
        returning *`,
      [postId, userId, truncate(reason, 4000)],
    ),
  )
}

/**
 * Worker: scheduled -> publishing (attempts + 1), only while the draft is still approved at the
 * post's revision. Returns null when the post is not claimable (canceled, already claimed, or
 * no longer approved) instead of raising.
 */
export async function claimForPublish(db: Db, userId: string, postId: string): Promise<PostRow | null> {
  return map(
    await db.one(
      `update public.posts p
          set status = 'publishing', attempts = p.attempts + 1, error = null
        where p.id = $1 and p.user_id = $2 and p.status = 'scheduled'
          and exists (
            select 1 from public.drafts d
             where d.id = p.draft_id and d.status = 'approved'
               and d.revision = p.approved_revision and d.approved_revision = p.approved_revision
          )
        returning p.*`,
      [postId, userId],
    ),
  )
}

/** Records the provider's request id (and provider) while publishing. */
export async function setProviderRequest(
  db: Db,
  userId: string,
  postId: string,
  input: { providerRequestId: string; provider?: string },
): Promise<PostRow | null> {
  return map(
    await db.one(
      `update public.posts set provider_request_id = $3, provider = coalesce($4, provider)
        where id = $1 and user_id = $2
        returning *`,
      [postId, userId, input.providerRequestId, input.provider ?? null],
    ),
  )
}

/** publishing (or failed, when the provider confirms late) -> published; also refreshes delivery fields. */
export async function markPublished(
  db: Db,
  userId: string,
  postId: string,
  input: { providerPostId?: string | null; postUrl?: string | null; publishedAt?: Date | null } = {},
): Promise<PostRow | null> {
  return map(
    await db.one(
      `update public.posts
          set status = 'published',
              provider_post_id = coalesce($3, provider_post_id),
              post_url = coalesce($4, post_url),
              published_at = coalesce($5::timestamptz, published_at, now()),
              error = null
        where id = $1 and user_id = $2 and status in ('publishing', 'published', 'failed')
        returning *`,
      [postId, userId, input.providerPostId ?? null, input.postUrl ?? null, input.publishedAt ?? null],
    ),
  )
}

/** scheduled/publishing -> failed with an error message. */
export async function markFailed(db: Db, userId: string, postId: string, error: string): Promise<PostRow | null> {
  return map(
    await db.one(
      `update public.posts set status = 'failed', error = $3
        where id = $1 and user_id = $2 and status in ('scheduled', 'publishing')
        returning *`,
      [postId, userId, truncate(error, 4000)],
    ),
  )
}

/**
 * publishing/failed -> scheduled at a new time (cap full, retry). Returns null when the draft
 * is no longer approved at the post's revision (the post stays as it is).
 */
export async function requeue(
  db: Db,
  userId: string,
  postId: string,
  scheduledFor: Date,
  note?: string | null,
): Promise<PostRow | null> {
  return map(
    await db.one(
      `update public.posts p
          set status = 'scheduled', scheduled_for = $3::timestamptz, error = $4
        where p.id = $1 and p.user_id = $2 and p.status in ('publishing', 'failed')
          and exists (
            select 1 from public.drafts d
             where d.id = p.draft_id and d.status = 'approved'
               and d.revision = p.approved_revision and d.approved_revision = p.approved_revision
          )
        returning p.*`,
      [postId, userId, scheduledFor, truncate(note, 4000)],
    ),
  )
}

/**
 * Upload-Post webhook lookup by our request id (not user-scoped: the webhook carries no user;
 * verify the webhook before calling). Optionally narrowed by platform.
 */
export async function findByProviderRequest(
  db: Db,
  provider: string,
  providerRequestId: string,
  platform?: Platform,
): Promise<PostRow[]> {
  const rows = await db.query(
    `select * from public.posts
      where provider_request_id = $1 and provider = $2 and ($3::public.platform is null or platform = $3)
      order by created_at`,
    [providerRequestId, provider, platform ?? null],
  )
  return camelRows<PostRow>(rows)
}
