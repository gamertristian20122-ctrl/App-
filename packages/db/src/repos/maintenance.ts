// System-wide queries for cron and cleanup jobs. These are the only repository functions (with
// job claiming, OAuth/nonce lookups by hash, Stripe lookups and the Upload-Post webhook lookup)
// that are not scoped by a userId. Never call them with user input.

import type { Platform } from '@app/core/types'
import { camelRows } from '../sql'
import type { Db } from '../types'
import { mapMedia } from './_mappers'
import type { MediaRow } from './media'
import type { PostRow } from './posts'

async function countDeleted(db: Db, sql: string, params: unknown[]): Promise<number> {
  const rows = await db.query(sql, params)
  return rows.length
}

/** Deletes approval nonces that expired before `before` (used or not). */
export function deleteExpiredApprovalNonces(db: Db, before: Date): Promise<number> {
  return countDeleted(db, 'delete from public.approval_nonces where expires_at < $1::timestamptz returning nonce_hash', [before])
}

/** Deletes authorization codes that expired before `before`. */
export function deleteExpiredOAuthCodes(db: Db, before: Date): Promise<number> {
  return countDeleted(db, 'delete from public.oauth_codes where expires_at < $1::timestamptz returning code_hash', [before])
}

/** Deletes tokens that expired before `before` (revoked or not). Keep refresh-token families long enough for reuse detection. */
export function deleteExpiredOAuthTokens(db: Db, before: Date): Promise<number> {
  return countDeleted(db, 'delete from public.oauth_tokens where expires_at < $1::timestamptz returning id', [before])
}

/**
 * Deletes dynamically registered OAuth clients created before `createdBefore` that hold no code
 * and no token (MCP clients register a new client on every fresh connection).
 */
export function deleteUnusedOAuthClients(db: Db, createdBefore: Date): Promise<number> {
  return countDeleted(
    db,
    `delete from public.oauth_clients c
      where c.created_at < $1::timestamptz
        and not exists (select 1 from public.oauth_tokens t where t.client_id = c.client_id)
        and not exists (select 1 from public.oauth_codes k where k.client_id = c.client_id)
      returning c.client_id`,
    [createdBefore],
  )
}

/** Deletes finished (succeeded / dead) jobs that finished before `before`. */
export function pruneFinishedJobs(db: Db, before: Date): Promise<number> {
  return countDeleted(
    db,
    `delete from public.jobs where status in ('succeeded', 'dead') and finished_at < $1::timestamptz returning id`,
    [before],
  )
}

/**
 * Clip sources (uploaded / drive-linked videos with the rights attestation) created before
 * `createdBefore` whose files still exist. Post videos (no attestation) are never returned, so they
 * cannot fill the batch and starve the retention cleanup. A source that a live draft (draft or
 * approved) attaches as post media, or that a scheduled / publishing post will publish, is kept
 * (it counts toward the storage allowance) until that draft or post is done.
 */
export async function listStaleSourceMedia(db: Db, createdBefore: Date, limit = 100): Promise<MediaRow[]> {
  const rows = await db.query(
    `select m.* from public.media_assets m
      where m.origin in ('upload', 'drive_link') and m.kind = 'video' and m.status <> 'deleted'
        and m.rights_attested_at is not null
        and m.created_at < $1::timestamptz
        and not exists (
          select 1 from public.draft_variants v
            join public.drafts d on d.id = v.draft_id and d.user_id = v.user_id
           where v.user_id = m.user_id and m.id = any(v.media_ids) and d.status in ('draft', 'approved'))
        and not exists (
          select 1 from public.posts p
            join public.draft_variants v on v.id = p.variant_id and v.user_id = p.user_id
           where p.user_id = m.user_id and p.status in ('scheduled', 'publishing') and m.id = any(v.media_ids))
      order by m.created_at
      limit $2`,
    [createdBefore, Math.max(1, Math.min(1000, limit))],
  )
  return rows.map(mapMedia)
}

/**
 * Scheduled posts due at or before `now` that no live publish_post job (queued, running, or
 * failed awaiting a retry) refers to: their job was lost. Posts that have a live job (including
 * held ones waiting for their next check) are skipped, so they can never fill the batch and starve
 * the sweep.
 */
export async function listDuePosts(db: Db, now: Date, limit = 100): Promise<PostRow[]> {
  const rows = await db.query(
    `select p.* from public.posts p
      where p.status = 'scheduled' and p.scheduled_for <= $1::timestamptz
        and not exists (
          select 1 from public.jobs j
           where j.type = 'publish_post'
             and j.status in ('queued', 'running', 'failed')
             and j.payload->>'postId' = p.id::text)
      order by p.scheduled_for limit $2`,
    [now, Math.max(1, Math.min(1000, limit))],
  )
  return camelRows<PostRow>(rows)
}

/**
 * Clips still `queued` or `rendering` whose clip_render job is dead or gone (a worker was killed on
 * every attempt): nothing would ever finish or fail them.
 */
export async function listOrphanedClips(db: Db, updatedBefore: Date, limit = 100): Promise<Array<{ userId: string; clipId: string }>> {
  const rows = await db.query<{ user_id: string; id: string }>(
    `select c.user_id, c.id from public.clips c
      where c.status in ('queued', 'rendering')
        and c.updated_at < $1::timestamptz
        and not exists (
          select 1 from public.jobs j
           where j.type = 'clip_render'
             and j.status in ('queued', 'running', 'failed')
             and j.payload->>'clipId' = c.id::text)
      order by c.updated_at
      limit $2`,
    [updatedBefore, Math.max(1, Math.min(1000, limit))],
  )
  return rows.map((r) => ({ userId: r.user_id, clipId: r.id }))
}

/**
 * Posts in `publishing` that no live job (queued / running / failed-awaiting-retry publish_post or
 * check_post_status) refers to: their job died, so nothing would ever settle them.
 */
export async function listStuckPublishingPosts(db: Db, limit = 100): Promise<PostRow[]> {
  const rows = await db.query(
    `select p.* from public.posts p
      where p.status = 'publishing'
        and not exists (
          select 1 from public.jobs j
           where j.type in ('publish_post', 'check_post_status')
             and j.status in ('queued', 'running', 'failed')
             and j.payload->>'postId' = p.id::text)
      order by p.updated_at
      limit $1`,
    [Math.max(1, Math.min(1000, limit))],
  )
  return camelRows<PostRow>(rows)
}

/** Published posts whose publication time falls in [from, to) (analytics checkpoints). */
export async function listPublishedBetween(db: Db, from: Date, to: Date, limit = 1000): Promise<PostRow[]> {
  const rows = await db.query(
    `select * from public.posts
      where status = 'published' and published_at >= $1::timestamptz and published_at < $2::timestamptz
      order by published_at limit $3`,
    [from, to, Math.max(1, Math.min(10_000, limit))],
  )
  return camelRows<PostRow>(rows)
}

export interface BrandWithAccounts {
  userId: string
  brandId: string
  providerProfileRef: string
  platforms: Platform[]
}

/** Active brands with a provider profile and at least one active account (daily analytics fan-out). */
export async function listBrandsForAnalytics(db: Db): Promise<BrandWithAccounts[]> {
  const rows = await db.query<{ user_id: string; brand_id: string; provider_profile_ref: string; platforms: string }>(
    `select b.user_id, b.id as brand_id, b.provider_profile_ref,
            string_agg(a.platform::text, ',' order by a.platform) as platforms
       from public.brands b
       join public.connected_accounts a on a.brand_id = b.id and a.status = 'active'
      where b.status = 'active' and b.provider_profile_ref is not null
      group by b.user_id, b.id, b.provider_profile_ref
      order by b.id`,
  )
  return rows.map((r) => ({
    userId: r.user_id,
    brandId: r.brand_id,
    providerProfileRef: r.provider_profile_ref,
    platforms: r.platforms.split(',') as Platform[],
  }))
}

export interface OrphanedReservation {
  userId: string
  mediaId: string
  /** The reservation's idempotency key (`clip_seconds:reserve:<mediaId>`). */
  reserveKey: string
  amount: number
  /** Why it is considered orphaned. */
  reason: 'media_gone' | 'job_dead' | 'stale'
}

/**
 * Outstanding clip_seconds reservations (no release/settle yet) of sources that will never be
 * transcribed: the media failed or was deleted, its transcribe job is dead, or the reservation is
 * older than `staleBefore` without a transcript. The cleanup job releases them (auto-refund).
 */
export async function listOrphanedClipReservations(db: Db, staleBefore: Date, limit = 200): Promise<OrphanedReservation[]> {
  const rows = await db.query<{ user_id: string; media_id: string; reserve_key: string; amount: number; reason: OrphanedReservation['reason'] }>(
    `select l.user_id, l.subject_id as media_id, l.idempotency_key as reserve_key, l.amount,
            case
              when m.id is null or m.status in ('failed', 'deleted') then 'media_gone'
              when exists (
                select 1 from public.jobs j
                 where j.type = 'transcribe' and j.status = 'dead'
                   and j.user_id = l.user_id and j.payload->>'mediaId' = l.subject_id::text
              ) then 'job_dead'
              else 'stale'
            end as reason
       from public.usage_ledger l
       left join public.media_assets m on m.id = l.subject_id and m.user_id = l.user_id
      where l.meter = 'clip_seconds' and l.kind = 'reserve' and l.subject_type = 'media'
        and not exists (
          select 1 from public.usage_ledger x where x.idempotency_key = l.idempotency_key || ':release'
        )
        and not exists (select 1 from public.transcripts t where t.media_id = l.subject_id and t.user_id = l.user_id)
        and (
          m.id is null or m.status in ('failed', 'deleted')
          or l.created_at < $1::timestamptz
          or exists (
            select 1 from public.jobs j
             where j.type = 'transcribe' and j.status = 'dead'
               and j.user_id = l.user_id and j.payload->>'mediaId' = l.subject_id::text
          )
        )
      order by l.created_at
      limit $2`,
    [staleBefore, Math.max(1, Math.min(1000, limit))],
  )
  return rows.map((r) => ({
    userId: r.user_id,
    mediaId: r.media_id,
    reserveKey: r.reserve_key,
    amount: Number(r.amount),
    reason: r.reason,
  }))
}
