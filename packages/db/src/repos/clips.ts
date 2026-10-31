import type { ClipStatus } from '@app/core/types'
import { camelRow, camelRows, clampLimit, many, setClause, truncate } from '../sql'
import type { Db } from '../types'

export type CaptionStyle = 'bold' | 'minimal' | 'karaoke' | 'none'

export interface ClipRow {
  id: string
  userId: string
  brandId: string
  sourceMediaId: string
  startMs: number
  endMs: number
  title: string | null
  hook: string | null
  captionStyle: CaptionStyle
  status: ClipStatus
  outputMediaId: string | null
  draftId: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

const map = (row: Record<string, unknown> | null): ClipRow | null => (row ? camelRow<ClipRow>(row) : null)

export interface CreateClipInput {
  brandId: string
  sourceMediaId: string
  startMs: number
  endMs: number
  title?: string | null
  hook?: string | null
  captionStyle?: CaptionStyle
}

export async function create(db: Db, userId: string, input: CreateClipInput): Promise<ClipRow> {
  const row = await db.one(
    `insert into public.clips (user_id, brand_id, source_media_id, start_ms, end_ms, title, hook, caption_style)
     values ($1, $2, $3, $4::int, $5::int, $6, $7, coalesce($8, 'bold'))
     returning *`,
    [
      userId,
      input.brandId,
      input.sourceMediaId,
      input.startMs,
      input.endMs,
      input.title ?? null,
      input.hook ?? null,
      input.captionStyle ?? null,
    ],
  )
  return map(row) as ClipRow
}

/** Inserts several clips atomically (in a transaction / savepoint), in input order. */
export async function createMany(db: Db, userId: string, inputs: readonly CreateClipInput[]): Promise<ClipRow[]> {
  return db.tx(async (tx) => {
    const out: ClipRow[] = []
    for (const input of inputs) out.push(await create(tx, userId, input))
    return out
  })
}

export async function get(db: Db, userId: string, clipId: string): Promise<ClipRow | null> {
  return map(await db.one('select * from public.clips where id = $1 and user_id = $2', [clipId, userId]))
}

export interface ListClipsOptions {
  brandId?: string
  sourceMediaId?: string
  status?: ClipStatus | readonly ClipStatus[]
  limit?: number
}

/** Newest first. */
export async function list(db: Db, userId: string, options: ListClipsOptions = {}): Promise<ClipRow[]> {
  const rows = await db.query(
    `select * from public.clips
      where user_id = $1
        and ($2::uuid is null or brand_id = $2)
        and ($3::uuid is null or source_media_id = $3)
        and ($4::text[]::public.clip_status[] is null or status = any($4::text[]::public.clip_status[]))
      order by created_at desc, start_ms
      limit $5`,
    [userId, options.brandId ?? null, options.sourceMediaId ?? null, many(options.status), clampLimit(options.limit, 100)],
  )
  return camelRows<ClipRow>(rows)
}

export interface UpdateClipPatch {
  status?: ClipStatus
  outputMediaId?: string | null
  draftId?: string | null
  error?: string | null
  title?: string | null
  hook?: string | null
}

export async function update(db: Db, userId: string, clipId: string, patch: UpdateClipPatch): Promise<ClipRow | null> {
  const set = setClause(
    { ...patch, ...(patch.error !== undefined ? { error: truncate(patch.error, 4000) } : {}) },
    {
      status: { column: 'status', cast: 'public.clip_status' },
      outputMediaId: { column: 'output_media_id', cast: 'uuid' },
      draftId: { column: 'draft_id', cast: 'uuid' },
      error: 'error',
      title: 'title',
      hook: 'hook',
    },
    3,
  )
  if (!set) return get(db, userId, clipId)
  return map(
    await db.one(`update public.clips set ${set.sql} where id = $1 and user_id = $2 returning *`, [
      clipId,
      userId,
      ...set.params,
    ]),
  )
}
