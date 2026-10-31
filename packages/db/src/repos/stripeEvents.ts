// Stripe webhook de-duplication (not user-scoped: keyed by Stripe's event id).

import { camelRow } from '../sql'
import type { Db } from '../types'

export interface StripeEventRow {
  id: string
  type: string
  processedAt: Date | null
  createdAt: Date
}

const map = (row: Record<string, unknown> | null): StripeEventRow | null => (row ? camelRow<StripeEventRow>(row) : null)

/**
 * Records a received event. Returns the row and whether it was new. Process the event only when
 * processedAt is null (a failed earlier attempt leaves it unprocessed, so Stripe's retry runs it).
 */
export async function record(db: Db, input: { id: string; type: string }): Promise<{ event: StripeEventRow; created: boolean }> {
  const inserted = map(
    await db.one(
      `insert into public.stripe_events (id, type) values ($1, $2) on conflict (id) do nothing returning *`,
      [input.id, input.type],
    ),
  )
  if (inserted) return { event: inserted, created: true }
  const existing = await get(db, input.id)
  if (!existing) throw new Error('stripe event vanished')
  return { event: existing, created: false }
}

export async function get(db: Db, eventId: string): Promise<StripeEventRow | null> {
  return map(await db.one('select * from public.stripe_events where id = $1', [eventId]))
}

/** Marks the event processed; false if it was already processed (or unknown). */
export async function markProcessed(db: Db, eventId: string): Promise<boolean> {
  const rows = await db.query(
    'update public.stripe_events set processed_at = now() where id = $1 and processed_at is null returning id',
    [eventId],
  )
  return rows.length > 0
}

/**
 * Locks the event row for processing (FOR UPDATE SKIP LOCKED) inside a transaction. Returns null
 * when another request is processing it or it is already processed.
 */
export async function lockUnprocessed(db: Db, eventId: string): Promise<StripeEventRow | null> {
  return map(
    await db.one(
      'select * from public.stripe_events where id = $1 and processed_at is null for update skip locked',
      [eventId],
    ),
  )
}
