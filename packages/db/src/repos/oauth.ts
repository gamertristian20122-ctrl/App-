// OAuth 2.1 authorization server storage (DCR clients, PKCE codes, access/refresh tokens).
// Codes and tokens are random 32-byte strings; only their SHA-256 hex hashes are stored, and
// lookups go by hash (not user-scoped: the hash is the credential).

import type { OAuthTokenKind } from '@app/core/types'
import { camelRow, camelRows } from '../sql'
import type { Db } from '../types'

export interface OAuthClientRow {
  clientId: string
  clientName: string | null
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none'
  createdAt: Date
  lastUsedAt: Date | null
}

export interface OAuthCodeRow {
  codeHash: string
  clientId: string
  userId: string
  redirectUri: string
  codeChallenge: string
  scope: string
  resource: string | null
  expiresAt: Date
  usedAt: Date | null
  createdAt: Date
}

export interface OAuthTokenRow {
  id: string
  tokenHash: string
  kind: OAuthTokenKind
  familyId: string
  clientId: string
  userId: string
  scope: string
  resource: string | null
  expiresAt: Date
  revokedAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
}

const mapClient = (r: Record<string, unknown> | null): OAuthClientRow | null => (r ? camelRow<OAuthClientRow>(r) : null)
const mapCode = (r: Record<string, unknown> | null): OAuthCodeRow | null => (r ? camelRow<OAuthCodeRow>(r) : null)
const mapToken = (r: Record<string, unknown> | null): OAuthTokenRow | null => (r ? camelRow<OAuthTokenRow>(r) : null)

// Clients ------------------------------------------------------------------------------------

export async function createClient(
  db: Db,
  input: { clientId: string; clientName?: string | null; redirectUris: readonly string[] },
): Promise<OAuthClientRow> {
  const row = await db.one(
    `insert into public.oauth_clients (client_id, client_name, redirect_uris) values ($1, $2, $3::text[]) returning *`,
    [input.clientId, input.clientName ?? null, [...input.redirectUris]],
  )
  return mapClient(row) as OAuthClientRow
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClientRow | null> {
  return mapClient(await db.one('select * from public.oauth_clients where client_id = $1', [clientId]))
}

export async function touchClient(db: Db, clientId: string): Promise<void> {
  await db.query('update public.oauth_clients set last_used_at = now() where client_id = $1', [clientId])
}

// Authorization codes ------------------------------------------------------------------------

export interface CreateCodeInput {
  codeHash: string
  clientId: string
  userId: string
  redirectUri: string
  /** S256 code challenge (base64url). */
  codeChallenge: string
  scope: string
  resource?: string | null
  expiresAt: Date
}

export async function createCode(db: Db, input: CreateCodeInput): Promise<OAuthCodeRow> {
  const row = await db.one(
    `insert into public.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
     returning *`,
    [
      input.codeHash,
      input.clientId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      input.scope,
      input.resource ?? null,
      input.expiresAt,
    ],
  )
  return mapCode(row) as OAuthCodeRow
}

/** Marks an unused, unexpired code used and returns it; null otherwise (single use). */
export async function consumeCode(db: Db, codeHash: string, now?: Date): Promise<OAuthCodeRow | null> {
  return mapCode(
    await db.one(
      `update public.oauth_codes set used_at = coalesce($2::timestamptz, now())
        where code_hash = $1 and used_at is null and expires_at > coalesce($2::timestamptz, now())
        returning *`,
      [codeHash, now ?? null],
    ),
  )
}

export async function getCode(db: Db, codeHash: string): Promise<OAuthCodeRow | null> {
  return mapCode(await db.one('select * from public.oauth_codes where code_hash = $1', [codeHash]))
}

// Tokens -------------------------------------------------------------------------------------

export interface CreateTokenInput {
  tokenHash: string
  kind: OAuthTokenKind
  familyId: string
  clientId: string
  userId: string
  scope: string
  resource?: string | null
  expiresAt: Date
}

export async function createToken(db: Db, input: CreateTokenInput): Promise<OAuthTokenRow> {
  const row = await db.one(
    `insert into public.oauth_tokens (token_hash, kind, family_id, client_id, user_id, scope, resource, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
     returning *`,
    [
      input.tokenHash,
      input.kind,
      input.familyId,
      input.clientId,
      input.userId,
      input.scope,
      input.resource ?? null,
      input.expiresAt,
    ],
  )
  return mapToken(row) as OAuthTokenRow
}

export async function findTokenByHash(db: Db, tokenHash: string): Promise<OAuthTokenRow | null> {
  return mapToken(await db.one('select * from public.oauth_tokens where token_hash = $1', [tokenHash]))
}

/** A token of `kind` that is neither revoked nor expired; records last use. */
export async function findActiveToken(
  db: Db,
  tokenHash: string,
  kind: OAuthTokenKind,
  now?: Date,
): Promise<OAuthTokenRow | null> {
  return mapToken(
    await db.one(
      `update public.oauth_tokens set last_used_at = coalesce($3::timestamptz, now())
        where token_hash = $1 and kind = $2 and revoked_at is null and expires_at > coalesce($3::timestamptz, now())
        returning *`,
      [tokenHash, kind, now ?? null],
    ),
  )
}

export type RefreshUseResult =
  | { status: 'ok'; token: OAuthTokenRow }
  | { status: 'reused'; familyId: string; userId: string }
  | { status: 'invalid' }

/**
 * Rotation step for a refresh token: atomically revokes it and returns it (status ok; the caller
 * then issues a new pair in the same family). Presenting an already revoked refresh token is
 * reuse: the whole family is revoked (status reused). Unknown or expired: invalid.
 */
export async function useRefreshToken(db: Db, tokenHash: string, now?: Date): Promise<RefreshUseResult> {
  return db.tx(async (tx) => {
    const used = mapToken(
      await tx.one(
        `update public.oauth_tokens set revoked_at = coalesce($2::timestamptz, now()), last_used_at = coalesce($2::timestamptz, now())
          where token_hash = $1 and kind = 'refresh' and revoked_at is null and expires_at > coalesce($2::timestamptz, now())
          returning *`,
        [tokenHash, now ?? null],
      ),
    )
    if (used) return { status: 'ok', token: used }
    const existing = await findTokenByHash(tx, tokenHash)
    if (existing && existing.kind === 'refresh' && existing.revokedAt) {
      await revokeFamily(tx, existing.familyId, now)
      return { status: 'reused', familyId: existing.familyId, userId: existing.userId }
    }
    return { status: 'invalid' }
  })
}

export async function revokeToken(db: Db, tokenHash: string, now?: Date): Promise<boolean> {
  const rows = await db.query(
    `update public.oauth_tokens set revoked_at = coalesce($2::timestamptz, now())
      where token_hash = $1 and revoked_at is null returning id`,
    [tokenHash, now ?? null],
  )
  return rows.length > 0
}

/** Revokes every token of a family; returns how many were still live. */
export async function revokeFamily(db: Db, familyId: string, now?: Date): Promise<number> {
  const rows = await db.query(
    `update public.oauth_tokens set revoked_at = coalesce($2::timestamptz, now())
      where family_id = $1 and revoked_at is null returning id`,
    [familyId, now ?? null],
  )
  return rows.length
}

/** Revokes all of a user's tokens (sign out everywhere / disconnect AI clients). */
export async function revokeAllForUser(db: Db, userId: string, now?: Date): Promise<number> {
  const rows = await db.query(
    `update public.oauth_tokens set revoked_at = coalesce($2::timestamptz, now())
      where user_id = $1 and revoked_at is null returning id`,
    [userId, now ?? null],
  )
  return rows.length
}

/** A user's live token families with their client (for a "connected AI apps" page). */
export async function listActiveForUser(db: Db, userId: string, now?: Date): Promise<OAuthTokenRow[]> {
  const rows = await db.query(
    `select * from public.oauth_tokens
      where user_id = $1 and revoked_at is null and expires_at > coalesce($2::timestamptz, now())
      order by created_at desc`,
    [userId, now ?? null],
  )
  return camelRows<OAuthTokenRow>(rows)
}
