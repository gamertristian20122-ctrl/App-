import type { AccountStatus, Platform } from '@app/core/types'
import { camelRow, camelRows, many } from '../sql'
import type { Db } from '../types'

/** connected_accounts row. encrypted_credentials is never returned here (see getCredentials). */
export interface AccountRow {
  id: string
  userId: string
  brandId: string
  platform: Platform
  provider: string
  externalAccountId: string | null
  handle: string | null
  displayName: string | null
  status: AccountStatus
  scopes: string[]
  hasCredentials: boolean
  connectedAt: Date | null
  lastSyncedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const COLUMNS = `id, user_id, brand_id, platform, provider, external_account_id, handle, display_name, status,
  scopes, (encrypted_credentials is not null) as has_credentials, connected_at, last_synced_at, created_at, updated_at`

const map = (row: Record<string, unknown> | null): AccountRow | null => (row ? camelRow<AccountRow>(row) : null)

export interface UpsertAccountInput {
  brandId: string
  platform: Platform
  provider: string
  externalAccountId?: string | null
  handle?: string | null
  displayName?: string | null
  /** A live status: pending, active or needs_reauth. */
  status: 'pending' | 'active' | 'needs_reauth'
  scopes?: string[]
}

/**
 * Inserts the brand's live account for the platform, or updates the existing live one
 * (one live account per platform per brand). Sets connected_at when it becomes active.
 */
export async function upsertLive(db: Db, userId: string, input: UpsertAccountInput): Promise<AccountRow> {
  const row = await db.one(
    `insert into public.connected_accounts as a
       (user_id, brand_id, platform, provider, external_account_id, handle, display_name, status, scopes,
        connected_at, last_synced_at)
     values ($1, $2, $3::public.platform, $4, $5, $6, $7, $8::public.account_status, coalesce($9::text[], '{}'),
             case when $8::public.account_status = 'active' then now() end, now())
     on conflict (brand_id, platform) where status in ('pending', 'active', 'needs_reauth')
     do update set
       provider = excluded.provider,
       external_account_id = coalesce(excluded.external_account_id, a.external_account_id),
       handle = coalesce(excluded.handle, a.handle),
       display_name = coalesce(excluded.display_name, a.display_name),
       status = excluded.status,
       scopes = case when $9::text[] is null then a.scopes else excluded.scopes end,
       connected_at = case when excluded.status = 'active' then coalesce(a.connected_at, now()) else a.connected_at end,
       last_synced_at = now()
     where a.user_id = excluded.user_id
     returning ${COLUMNS}`,
    [
      userId,
      input.brandId,
      input.platform,
      input.provider,
      input.externalAccountId ?? null,
      input.handle ?? null,
      input.displayName ?? null,
      input.status,
      input.scopes ?? null,
    ],
  )
  if (!row) throw new Error('connected account upsert matched another user')
  return map(row) as AccountRow
}

export async function get(db: Db, userId: string, accountId: string): Promise<AccountRow | null> {
  return map(
    await db.one(`select ${COLUMNS} from public.connected_accounts where id = $1 and user_id = $2`, [accountId, userId]),
  )
}

/** The brand's live (pending/active/needs_reauth) account for a platform. */
export async function findLive(db: Db, userId: string, brandId: string, platform: Platform): Promise<AccountRow | null> {
  return map(
    await db.one(
      `select ${COLUMNS} from public.connected_accounts
        where user_id = $1 and brand_id = $2 and platform = $3::public.platform
          and status in ('pending', 'active', 'needs_reauth')`,
      [userId, brandId, platform],
    ),
  )
}

export interface ListAccountsOptions {
  brandId?: string
  platform?: Platform
  status?: AccountStatus | readonly AccountStatus[]
}

export async function list(db: Db, userId: string, options: ListAccountsOptions = {}): Promise<AccountRow[]> {
  const rows = await db.query(
    `select ${COLUMNS} from public.connected_accounts
      where user_id = $1
        and ($2::uuid is null or brand_id = $2)
        and ($3::public.platform is null or platform = $3)
        and ($4::text[]::public.account_status[] is null or status = any($4::text[]::public.account_status[]))
      order by brand_id, platform, created_at`,
    [userId, options.brandId ?? null, options.platform ?? null, many(options.status)],
  )
  return camelRows<AccountRow>(rows)
}

export async function setStatus(db: Db, userId: string, accountId: string, status: AccountStatus): Promise<AccountRow | null> {
  return map(
    await db.one(
      `update public.connected_accounts
          set status = $3::public.account_status,
              connected_at = case when $3::public.account_status = 'active' then coalesce(connected_at, now()) else connected_at end
        where id = $1 and user_id = $2
        returning ${COLUMNS}`,
      [accountId, userId, status],
    ),
  )
}

export async function markSynced(db: Db, userId: string, accountId: string, at?: Date): Promise<void> {
  await db.query(
    'update public.connected_accounts set last_synced_at = coalesce($3::timestamptz, now()) where id = $1 and user_id = $2',
    [accountId, userId, at ?? null],
  )
}

/** Stores AES-256-GCM ciphertext (core crypto encryptBytes). Pass null to clear. */
export async function setCredentials(db: Db, userId: string, accountId: string, ciphertext: Uint8Array | null): Promise<boolean> {
  const rows = await db.query(
    'update public.connected_accounts set encrypted_credentials = $3 where id = $1 and user_id = $2 returning id',
    [accountId, userId, ciphertext],
  )
  return rows.length > 0
}

/** The encrypted credentials (still ciphertext; decrypt in the adapter). */
export async function getCredentials(db: Db, userId: string, accountId: string): Promise<Uint8Array | null> {
  const row = await db.one<{ encrypted_credentials: Uint8Array | null }>(
    'select encrypted_credentials from public.connected_accounts where id = $1 and user_id = $2',
    [accountId, userId],
  )
  return row?.encrypted_credentials ? new Uint8Array(row.encrypted_credentials) : null
}
