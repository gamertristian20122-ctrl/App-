import type { BrandStatus } from '@app/core/types'
import { camelRow, camelRows, many, setClause } from '../sql'
import type { Db } from '../types'

export interface BrandRow {
  id: string
  userId: string
  name: string
  timezone: string
  status: BrandStatus
  providerProfileRef: string | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const map = (row: Record<string, unknown> | null): BrandRow | null => (row ? camelRow<BrandRow>(row) : null)

export interface CreateBrandInput {
  name: string
  timezone?: string
}

/**
 * Inserts an active brand. The brand limit is a service rule: lock the user row
 * (users.lockForUpdate) and compare countActive() with the entitlement in the same transaction.
 */
export async function create(db: Db, userId: string, input: CreateBrandInput): Promise<BrandRow> {
  const row = await db.one(
    `insert into public.brands (user_id, name, timezone) values ($1, $2, coalesce($3, 'UTC')) returning *`,
    [userId, input.name, input.timezone ?? null],
  )
  return map(row) as BrandRow
}

export async function get(db: Db, userId: string, brandId: string): Promise<BrandRow | null> {
  return map(await db.one('select * from public.brands where id = $1 and user_id = $2', [brandId, userId]))
}

/**
 * System lookup for the posting-provider webhook (not user-scoped: verify the webhook first and
 * never pass user input). The profile ref is unique.
 */
export async function findByProviderProfileRef(db: Db, profileRef: string): Promise<BrandRow | null> {
  return map(await db.one('select * from public.brands where provider_profile_ref = $1', [profileRef]))
}

/** Locks the brand row (FOR UPDATE). Use in a transaction. */
export async function lockForUpdate(db: Db, userId: string, brandId: string): Promise<BrandRow | null> {
  return map(await db.one('select * from public.brands where id = $1 and user_id = $2 for update', [brandId, userId]))
}

export interface ListBrandsOptions {
  status?: BrandStatus | readonly BrandStatus[]
}

/** Oldest first. Without a status filter, archived brands are included. */
export async function list(db: Db, userId: string, options: ListBrandsOptions = {}): Promise<BrandRow[]> {
  const statuses = many(options.status)
  const rows = await db.query(
    `select * from public.brands
      where user_id = $1 and ($2::text[]::public.brand_status[] is null or status = any($2::text[]::public.brand_status[]))
      order by created_at, id`,
    [userId, statuses],
  )
  return camelRows<BrandRow>(rows)
}

export async function countActive(db: Db, userId: string): Promise<number> {
  const row = await db.one<{ n: number }>(
    `select count(*)::int as n from public.brands where user_id = $1 and status = 'active'`,
    [userId],
  )
  return row?.n ?? 0
}

export interface UpdateBrandPatch {
  name?: string
  timezone?: string
}

export async function update(db: Db, userId: string, brandId: string, patch: UpdateBrandPatch): Promise<BrandRow | null> {
  const set = setClause({ ...patch }, { name: 'name', timezone: 'timezone' }, 3)
  if (!set) return get(db, userId, brandId)
  return map(
    await db.one(`update public.brands set ${set.sql} where id = $1 and user_id = $2 returning *`, [
      brandId,
      userId,
      ...set.params,
    ]),
  )
}

/** Sets the status; archived_at follows (set when archived, cleared otherwise). */
export async function setStatus(db: Db, userId: string, brandId: string, status: BrandStatus): Promise<BrandRow | null> {
  return map(
    await db.one(
      `update public.brands
          set status = $3::public.brand_status,
              archived_at = case when $3::public.brand_status = 'archived' then coalesce(archived_at, now()) else null end
        where id = $1 and user_id = $2
        returning *`,
      [brandId, userId, status],
    ),
  )
}

export async function setProviderProfileRef(
  db: Db,
  userId: string,
  brandId: string,
  profileRef: string | null,
): Promise<BrandRow | null> {
  return map(
    await db.one('update public.brands set provider_profile_ref = $3 where id = $1 and user_id = $2 returning *', [
      brandId,
      userId,
      profileRef,
    ]),
  )
}

/**
 * Downgrade rule: keeps the `keep` oldest active brands and suspends the rest (newest first).
 * Returns the suspended brands. Nothing is deleted.
 */
export async function suspendNewest(db: Db, userId: string, keep: number): Promise<BrandRow[]> {
  const rows = await db.query(
    `update public.brands b set status = 'suspended'
       where b.id in (
         select id from public.brands
          where user_id = $1 and status = 'active'
          order by created_at, id
          offset $2
       )
       returning b.*`,
    [userId, Math.max(0, Math.floor(keep))],
  )
  return camelRows<BrandRow>(rows)
}
