import type { Actor, DraftStatus, Platform } from '@app/core/types'
import { camelRow, camelRows, clampLimit, json, many, setClause } from '../sql'
import type { Db } from '../types'

export interface DraftRow {
  id: string
  userId: string
  brandId: string
  status: DraftStatus
  /** Starts at 1; bumped once per transaction that changes content (variants or brand). */
  revision: number
  /** SHA-256 of brand + variants, maintained by triggers. */
  contentHash: string
  createdVia: Actor
  sourceClipId: string | null
  approvedRevision: number | null
  approvedHash: string | null
  approvedAt: Date | null
  approvedVia: Actor | null
  rejectedReason: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

export interface VariantRow {
  id: string
  userId: string
  draftId: string
  platform: Platform
  connectedAccountId: string | null
  text: string
  title: string | null
  mediaIds: string[]
  options: Record<string, unknown>
  hasLink: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DraftWithVariants {
  draft: DraftRow
  variants: VariantRow[]
}

const mapDraft = (row: Record<string, unknown> | null): DraftRow | null => (row ? camelRow<DraftRow>(row) : null)
const mapVariant = (row: Record<string, unknown> | null): VariantRow | null => (row ? camelRow<VariantRow>(row) : null)

export interface VariantInput {
  platform: Platform
  connectedAccountId?: string | null
  text?: string
  title?: string | null
  mediaIds?: readonly string[]
  options?: Record<string, unknown>
  /** Whether the text contains a link (core links.hasLink). */
  hasLink?: boolean
}

export interface CreateDraftInput {
  brandId: string
  createdVia: Actor
  sourceClipId?: string | null
  notes?: string | null
  variants?: readonly VariantInput[]
}

/** Creates a draft (status draft, revision 1) with its variants in one transaction. */
export async function create(db: Db, userId: string, input: CreateDraftInput): Promise<DraftWithVariants> {
  return db.tx(async (tx) => {
    const draftRow = await tx.one(
      `insert into public.drafts (user_id, brand_id, created_via, source_clip_id, notes)
       values ($1, $2, $3::public.actor, $4, $5)
       returning id`,
      [userId, input.brandId, input.createdVia, input.sourceClipId ?? null, input.notes ?? null],
    )
    const draftId = String(draftRow?.id)
    const variants: VariantRow[] = []
    for (const v of input.variants ?? []) variants.push(await upsertVariant(tx, userId, draftId, v))
    const draft = await get(tx, userId, draftId)
    if (!draft) throw new Error('draft vanished after insert')
    return { draft, variants }
  })
}

export async function get(db: Db, userId: string, draftId: string): Promise<DraftRow | null> {
  return mapDraft(await db.one('select * from public.drafts where id = $1 and user_id = $2', [draftId, userId]))
}

/** FOR UPDATE lock on the draft row. Use in a transaction. */
export async function lockForUpdate(db: Db, userId: string, draftId: string): Promise<DraftRow | null> {
  return mapDraft(await db.one('select * from public.drafts where id = $1 and user_id = $2 for update', [draftId, userId]))
}

export async function getWithVariants(db: Db, userId: string, draftId: string): Promise<DraftWithVariants | null> {
  const draft = await get(db, userId, draftId)
  if (!draft) return null
  return { draft, variants: await listVariants(db, userId, draftId) }
}

export interface ListDraftsOptions {
  brandId?: string
  status?: DraftStatus | readonly DraftStatus[]
  /** Only drafts created before this time (cursor). */
  before?: Date
  limit?: number
}

/** Newest first. */
export async function list(db: Db, userId: string, options: ListDraftsOptions = {}): Promise<DraftRow[]> {
  const rows = await db.query(
    `select * from public.drafts
      where user_id = $1
        and ($2::uuid is null or brand_id = $2)
        and ($3::text[]::public.draft_status[] is null or status = any($3::text[]::public.draft_status[]))
        and ($4::timestamptz is null or created_at < $4::timestamptz)
      order by created_at desc, id desc
      limit $5`,
    [userId, options.brandId ?? null, many(options.status), options.before ?? null, clampLimit(options.limit)],
  )
  return camelRows<DraftRow>(rows)
}

/** Variants of one draft, in platform order. */
export async function listVariants(db: Db, userId: string, draftId: string): Promise<VariantRow[]> {
  const rows = await db.query(
    'select * from public.draft_variants where draft_id = $1 and user_id = $2 order by platform',
    [draftId, userId],
  )
  return camelRows<VariantRow>(rows)
}

/** Variants of several drafts (for list views). */
export async function listVariantsForDrafts(db: Db, userId: string, draftIds: readonly string[]): Promise<VariantRow[]> {
  if (draftIds.length === 0) return []
  const rows = await db.query(
    'select * from public.draft_variants where user_id = $1 and draft_id = any($2::uuid[]) order by draft_id, platform',
    [userId, [...draftIds]],
  )
  return camelRows<VariantRow>(rows)
}

export async function getVariant(db: Db, userId: string, variantId: string): Promise<VariantRow | null> {
  return mapVariant(await db.one('select * from public.draft_variants where id = $1 and user_id = $2', [variantId, userId]))
}

/**
 * Inserts the draft's variant for input.platform or replaces its content. Content changes bump
 * the draft revision and drop its approval (triggers); identical content changes nothing.
 */
export async function upsertVariant(db: Db, userId: string, draftId: string, input: VariantInput): Promise<VariantRow> {
  const row = await db.one(
    `insert into public.draft_variants as v
       (user_id, draft_id, platform, connected_account_id, text, title, media_ids, options, has_link)
     values ($1, $2, $3::public.platform, $4, coalesce($5, ''), $6, coalesce($7::uuid[], '{}'),
             coalesce($8::text::jsonb, '{}'::jsonb), coalesce($9::boolean, false))
     on conflict (draft_id, platform) do update set
       connected_account_id = excluded.connected_account_id,
       text = excluded.text,
       title = excluded.title,
       media_ids = excluded.media_ids,
       options = excluded.options,
       has_link = excluded.has_link
     where v.user_id = excluded.user_id
     returning *`,
    [
      userId,
      draftId,
      input.platform,
      input.connectedAccountId ?? null,
      input.text ?? null,
      input.title ?? null,
      input.mediaIds ? [...input.mediaIds] : null,
      input.options ? json(input.options) : null,
      input.hasLink ?? null,
    ],
  )
  if (!row) throw new Error('variant belongs to another user')
  return mapVariant(row) as VariantRow
}

export interface UpdateVariantPatch {
  connectedAccountId?: string | null
  text?: string
  title?: string | null
  mediaIds?: readonly string[]
  options?: Record<string, unknown>
  hasLink?: boolean
}

export async function updateVariant(
  db: Db,
  userId: string,
  variantId: string,
  patch: UpdateVariantPatch,
): Promise<VariantRow | null> {
  const set = setClause(
    { ...patch, ...(patch.mediaIds ? { mediaIds: [...patch.mediaIds] } : {}) },
    {
      connectedAccountId: { column: 'connected_account_id', cast: 'uuid' },
      text: 'text',
      title: 'title',
      mediaIds: { column: 'media_ids', cast: 'uuid[]' },
      options: { column: 'options', json: true },
      hasLink: { column: 'has_link', cast: 'boolean' },
    },
    3,
  )
  if (!set) return getVariant(db, userId, variantId)
  return mapVariant(
    await db.one(`update public.draft_variants set ${set.sql} where id = $1 and user_id = $2 returning *`, [
      variantId,
      userId,
      ...set.params,
    ]),
  )
}

/** Removes the draft's variant for a platform (fails if a post references it). */
export async function deleteVariant(db: Db, userId: string, draftId: string, platform: Platform): Promise<boolean> {
  const rows = await db.query(
    'delete from public.draft_variants where draft_id = $1 and user_id = $2 and platform = $3::public.platform returning id',
    [draftId, userId, platform],
  )
  return rows.length > 0
}

export interface ApproveInput {
  /** The revision the human saw (from the approval nonce). */
  revision: number
  via: Actor
}

/**
 * Approves the draft if it is still at `revision` and in status draft or rejected. Returns null
 * when it changed meanwhile (or is archived / already approved / not the user's).
 */
export async function approve(db: Db, userId: string, draftId: string, input: ApproveInput): Promise<DraftRow | null> {
  return mapDraft(
    await db.one(
      `update public.drafts
          set status = 'approved',
              approved_revision = revision,
              approved_hash = content_hash,
              approved_at = now(),
              approved_via = $4::public.actor,
              rejected_reason = null
        where id = $1 and user_id = $2 and revision = $3::int and status in ('draft', 'rejected')
        returning *`,
      [draftId, userId, input.revision, input.via],
    ),
  )
}

/** Rejects a draft or an approved draft (scheduled posts are canceled by trigger). */
export async function reject(db: Db, userId: string, draftId: string, reason?: string | null): Promise<DraftRow | null> {
  return mapDraft(
    await db.one(
      `update public.drafts set status = 'rejected', rejected_reason = $3
        where id = $1 and user_id = $2 and status in ('draft', 'approved')
        returning *`,
      [draftId, userId, reason ?? null],
    ),
  )
}

export async function archive(db: Db, userId: string, draftId: string): Promise<DraftRow | null> {
  return mapDraft(
    await db.one(
      `update public.drafts set status = 'archived' where id = $1 and user_id = $2 and status <> 'archived' returning *`,
      [draftId, userId],
    ),
  )
}

/** Moves a rejected or archived draft back to draft. */
export async function reopen(db: Db, userId: string, draftId: string): Promise<DraftRow | null> {
  return mapDraft(
    await db.one(
      `update public.drafts set status = 'draft', rejected_reason = null
        where id = $1 and user_id = $2 and status in ('rejected', 'archived')
        returning *`,
      [draftId, userId],
    ),
  )
}

/** Notes are not content: editing them keeps the revision and the approval. */
export async function updateNotes(db: Db, userId: string, draftId: string, notes: string | null): Promise<DraftRow | null> {
  return mapDraft(
    await db.one('update public.drafts set notes = $3 where id = $1 and user_id = $2 returning *', [draftId, userId, notes]),
  )
}

/** Moving a draft to another brand is a content change (new revision, approval dropped). */
export async function moveToBrand(db: Db, userId: string, draftId: string, brandId: string): Promise<DraftRow | null> {
  return mapDraft(
    await db.one('update public.drafts set brand_id = $3 where id = $1 and user_id = $2 returning *', [
      draftId,
      userId,
      brandId,
    ]),
  )
}

export async function remove(db: Db, userId: string, draftId: string): Promise<boolean> {
  const rows = await db.query('delete from public.drafts where id = $1 and user_id = $2 returning id', [draftId, userId])
  return rows.length > 0
}
