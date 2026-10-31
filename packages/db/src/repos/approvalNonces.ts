// One-time approval nonces (only SHA-256 hashes are stored). Issued with the approval card and
// web approve links; consumed by the human's approve/reject click.

import { camelRow } from '../sql'
import type { Db } from '../types'

/**
 * Where a nonce may be used (migration 0002). 'card': UI-only places the AI never sees (approval
 * card _meta, signed-in web queue buttons). 'link': the plain-text web approve link, which an AI
 * client can read, so it is only accepted by the signed-in web app.
 */
export type ApprovalNonceChannel = 'card' | 'link'

export interface ApprovalNonceRow {
  nonceHash: string
  userId: string
  draftId: string
  revision: number
  channel: ApprovalNonceChannel
  expiresAt: Date
  usedAt: Date | null
  createdAt: Date
}

const map = (row: Record<string, unknown> | null): ApprovalNonceRow | null => (row ? camelRow<ApprovalNonceRow>(row) : null)

export async function create(
  db: Db,
  userId: string,
  input: { nonceHash: string; draftId: string; revision: number; expiresAt: Date; channel?: ApprovalNonceChannel },
): Promise<ApprovalNonceRow> {
  const row = await db.one(
    `insert into public.approval_nonces (nonce_hash, user_id, draft_id, revision, expires_at, channel)
     values ($1, $2, $3, $4::int, $5::timestamptz, $6)
     returning *`,
    [input.nonceHash, userId, input.draftId, input.revision, input.expiresAt, input.channel ?? 'card'],
  )
  return map(row) as ApprovalNonceRow
}

export async function get(db: Db, userId: string, nonceHash: string): Promise<ApprovalNonceRow | null> {
  return map(await db.one('select * from public.approval_nonces where nonce_hash = $1 and user_id = $2', [nonceHash, userId]))
}

/**
 * Lookup by hash alone (the hash is the credential), e.g. for the /approve/[nonce] page before
 * checking that the signed-in user owns it.
 */
export async function findByHash(db: Db, nonceHash: string): Promise<ApprovalNonceRow | null> {
  return map(await db.one('select * from public.approval_nonces where nonce_hash = $1', [nonceHash]))
}

/**
 * Marks an unused, unexpired nonce of this user used and returns it; null otherwise. With
 * `channels`, only a nonce issued for one of them is consumed (others are left untouched).
 */
export async function consume(
  db: Db,
  userId: string,
  nonceHash: string,
  now?: Date,
  channels?: readonly ApprovalNonceChannel[],
): Promise<ApprovalNonceRow | null> {
  return map(
    await db.one(
      `update public.approval_nonces set used_at = coalesce($3::timestamptz, now())
        where nonce_hash = $1 and user_id = $2 and used_at is null and expires_at > coalesce($3::timestamptz, now())
          and ($4::text[] is null or channel = any($4::text[]))
        returning *`,
      [nonceHash, userId, now ?? null, channels ? [...channels] : null],
    ),
  )
}
