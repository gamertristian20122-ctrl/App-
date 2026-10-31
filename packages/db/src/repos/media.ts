import type { MediaKind, MediaOrigin, MediaStatus } from '@app/core/types'
import { clampLimit, many, setClause, toNumberOrNull } from '../sql'
import { mapMedia } from './_mappers'
import type { Db } from '../types'

export interface MediaRow {
  id: string
  userId: string
  brandId: string | null
  kind: MediaKind
  origin: MediaOrigin
  status: MediaStatus
  storageKey: string
  mimeType: string | null
  bytes: number | null
  durationMs: number | null
  width: number | null
  height: number | null
  sha256: string | null
  sourceHost: string | null
  sourceUrl: string | null
  rightsAttestedAt: Date | null
  parentMediaId: string | null
  createdAt: Date
  updatedAt: Date
}

const map = (row: Record<string, unknown> | null): MediaRow | null => (row ? mapMedia(row) : null)

export interface CreateMediaInput {
  brandId?: string | null
  kind: MediaKind
  origin: MediaOrigin
  status?: MediaStatus
  storageKey: string
  mimeType?: string | null
  bytes?: number | null
  durationMs?: number | null
  width?: number | null
  height?: number | null
  sha256?: string | null
  /** drive_link / url_import: host of the submitted link (drive links: allowlisted drive hosts). */
  sourceHost?: string | null
  /** drive_link / url_import: the full https link until it is fetched. */
  sourceUrl?: string | null
  rightsAttestedAt?: Date | null
  parentMediaId?: string | null
}

export async function create(db: Db, userId: string, input: CreateMediaInput): Promise<MediaRow> {
  const row = await db.one(
    `insert into public.media_assets
       (user_id, brand_id, kind, origin, status, storage_key, mime_type, bytes, duration_ms, width, height,
        sha256, source_host, source_url, rights_attested_at, parent_media_id)
     values ($1, $2, $3::public.media_kind, $4::public.media_origin, coalesce($5::public.media_status, 'pending'),
             $6, $7, $8::bigint, $9::int, $10::int, $11::int, $12, $13, $14, $15::timestamptz, $16)
     returning *`,
    [
      userId,
      input.brandId ?? null,
      input.kind,
      input.origin,
      input.status ?? null,
      input.storageKey,
      input.mimeType ?? null,
      input.bytes ?? null,
      input.durationMs ?? null,
      input.width ?? null,
      input.height ?? null,
      input.sha256 ?? null,
      input.sourceHost ?? null,
      input.sourceUrl ?? null,
      input.rightsAttestedAt ?? null,
      input.parentMediaId ?? null,
    ],
  )
  return map(row) as MediaRow
}

export async function get(db: Db, userId: string, mediaId: string): Promise<MediaRow | null> {
  return map(await db.one('select * from public.media_assets where id = $1 and user_id = $2', [mediaId, userId]))
}

/** The user's media among ids (missing or foreign ids are simply absent). */
export async function getMany(db: Db, userId: string, mediaIds: readonly string[]): Promise<MediaRow[]> {
  if (mediaIds.length === 0) return []
  const rows = await db.query('select * from public.media_assets where user_id = $1 and id = any($2::uuid[])', [
    userId,
    [...mediaIds],
  ])
  return rows.map(mapMedia)
}

export async function findByStorageKey(db: Db, userId: string, storageKey: string): Promise<MediaRow | null> {
  return map(
    await db.one('select * from public.media_assets where storage_key = $1 and user_id = $2', [storageKey, userId]),
  )
}

export interface ListMediaOptions {
  brandId?: string
  kind?: MediaKind | readonly MediaKind[]
  origin?: MediaOrigin | readonly MediaOrigin[]
  status?: MediaStatus | readonly MediaStatus[]
  /** Only rows created before this time (cursor). */
  before?: Date
  limit?: number
}

/** Newest first. Deleted media are included only when status asks for them. */
export async function list(db: Db, userId: string, options: ListMediaOptions = {}): Promise<MediaRow[]> {
  const rows = await db.query(
    `select * from public.media_assets
      where user_id = $1
        and ($2::uuid is null or brand_id = $2)
        and ($3::text[]::public.media_kind[] is null or kind = any($3::text[]::public.media_kind[]))
        and ($4::text[]::public.media_origin[] is null or origin = any($4::text[]::public.media_origin[]))
        and (case when $5::text[]::public.media_status[] is null then status <> 'deleted' else status = any($5::text[]::public.media_status[]) end)
        and ($6::timestamptz is null or created_at < $6::timestamptz)
      order by created_at desc, id desc
      limit $7`,
    [
      userId,
      options.brandId ?? null,
      many(options.kind),
      many(options.origin),
      many(options.status),
      options.before ?? null,
      clampLimit(options.limit),
    ],
  )
  return rows.map(mapMedia)
}

export interface UpdateMediaPatch {
  brandId?: string | null
  status?: MediaStatus
  mimeType?: string | null
  bytes?: number | null
  durationMs?: number | null
  width?: number | null
  height?: number | null
  sha256?: string | null
  /** Set to null once the drive file is fetched. */
  sourceUrl?: string | null
  rightsAttestedAt?: Date | null
}

export async function update(db: Db, userId: string, mediaId: string, patch: UpdateMediaPatch): Promise<MediaRow | null> {
  const set = setClause(
    { ...patch },
    {
      brandId: { column: 'brand_id', cast: 'uuid' },
      status: { column: 'status', cast: 'public.media_status' },
      mimeType: 'mime_type',
      bytes: { column: 'bytes', cast: 'bigint' },
      durationMs: { column: 'duration_ms', cast: 'int' },
      width: { column: 'width', cast: 'int' },
      height: { column: 'height', cast: 'int' },
      sha256: 'sha256',
      sourceUrl: 'source_url',
      rightsAttestedAt: { column: 'rights_attested_at', cast: 'timestamptz' },
    },
    3,
  )
  if (!set) return get(db, userId, mediaId)
  return map(
    await db.one(`update public.media_assets set ${set.sql} where id = $1 and user_id = $2 returning *`, [
      mediaId,
      userId,
      ...set.params,
    ]),
  )
}

/**
 * Points a pending media row at a new storage key (an upload promoted to its immutable source key).
 * Only moves a row that is still pending and still at `fromKey`; null otherwise.
 */
export async function moveStorageKey(db: Db, userId: string, mediaId: string, fromKey: string, toKey: string): Promise<MediaRow | null> {
  return map(
    await db.one(
      `update public.media_assets set storage_key = $4
        where id = $1 and user_id = $2 and storage_key = $3 and status = 'pending'
        returning *`,
      [mediaId, userId, fromKey, toKey],
    ),
  )
}

/** Sum of bytes of the user's stored (not deleted) media, for the storage allowance. */
export async function storageBytes(db: Db, userId: string): Promise<number> {
  const row = await db.one<{ n: unknown }>(
    `select coalesce(sum(bytes), 0)::bigint as n from public.media_assets where user_id = $1 and status <> 'deleted'`,
    [userId],
  )
  return toNumberOrNull(row?.n) ?? 0
}
