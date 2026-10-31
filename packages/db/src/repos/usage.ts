import type { UsageKind, UsageMeter } from '@app/core/types'
import { camelRow, camelRows, clampLimit, truncate } from '../sql'
import type { Db } from '../types'

export interface LedgerRow {
  id: string
  userId: string
  meter: UsageMeter
  kind: UsageKind
  amount: number
  periodStart: Date
  subjectType: string | null
  subjectId: string | null
  idempotencyKey: string
  note: string | null
  createdAt: Date
}

const map = (row: Record<string, unknown> | null): LedgerRow | null => (row ? camelRow<LedgerRow>(row) : null)

export interface LedgerInput {
  meter: UsageMeter
  kind: UsageKind
  /** > 0, except adjust: non-zero (positive consumes, negative gives back). */
  amount: number
  periodStart: Date
  subjectType?: string | null
  subjectId?: string | null
  /** Unique across the ledger, e.g. `clip_seconds:reserve:<mediaId>`. */
  idempotencyKey: string
  note?: string | null
}

export interface RecordResult {
  entry: LedgerRow
  /** false when an entry with the same idempotency key already existed (nothing inserted). */
  created: boolean
}

/**
 * Appends an entry, idempotently: a second call with the same key returns the existing entry
 * with created = false. Throws if the key belongs to another user.
 */
export async function record(db: Db, userId: string, input: LedgerInput): Promise<RecordResult> {
  const inserted = await db.one(
    `insert into public.usage_ledger (user_id, meter, kind, amount, period_start, subject_type, subject_id, idempotency_key, note)
     values ($1, $2::public.usage_meter, $3::public.usage_kind, $4::int, $5::timestamptz, $6, $7, $8, $9)
     on conflict (idempotency_key) do nothing
     returning *`,
    [
      userId,
      input.meter,
      input.kind,
      input.amount,
      input.periodStart,
      input.subjectType ?? null,
      input.subjectId ?? null,
      input.idempotencyKey,
      truncate(input.note, 1000),
    ],
  )
  if (inserted) return { entry: map(inserted) as LedgerRow, created: true }
  const existing = map(await db.one('select * from public.usage_ledger where idempotency_key = $1', [input.idempotencyKey]))
  if (!existing || existing.userId !== userId) throw new Error('usage ledger idempotency key belongs to another user')
  return { entry: existing, created: false }
}

export interface UsageTotals {
  reserved: number
  released: number
  settled: number
  adjusted: number
  /** Reservations not yet released: reserved - released. */
  outstanding: number
  /** What counts against the limit: settled + outstanding + adjusted. */
  used: number
}

/** Sums the user's entries for one meter and period (period_start must match exactly). */
export async function totals(db: Db, userId: string, meter: UsageMeter, periodStart: Date): Promise<UsageTotals> {
  const row = await db.one<{ reserved: number; released: number; settled: number; adjusted: number }>(
    `select coalesce(sum(amount) filter (where kind = 'reserve'), 0)::int as reserved,
            coalesce(sum(amount) filter (where kind = 'release'), 0)::int as released,
            coalesce(sum(amount) filter (where kind = 'settle'), 0)::int as settled,
            coalesce(sum(amount) filter (where kind = 'adjust'), 0)::int as adjusted
       from public.usage_ledger
      where user_id = $1 and meter = $2::public.usage_meter and period_start = $3::timestamptz`,
    [userId, meter, periodStart],
  )
  const reserved = row?.reserved ?? 0
  const released = row?.released ?? 0
  const settled = row?.settled ?? 0
  const adjusted = row?.adjusted ?? 0
  const outstanding = reserved - released
  return { reserved, released, settled, adjusted, outstanding, used: settled + outstanding + adjusted }
}

export type ReserveResult =
  | { ok: true; entry: LedgerRow; created: boolean; used: number }
  | { ok: false; used: number; limit: number }

/**
 * Atomic reserve: locks the user row, sums the period and inserts a reserve entry only if
 * used + amount <= limit. Idempotent by key (an existing entry is returned without a limit
 * check). Call inside the transaction that also enqueues the work.
 */
export async function reserveWithinLimit(
  db: Db,
  userId: string,
  input: Omit<LedgerInput, 'kind'> & { limit: number },
): Promise<ReserveResult> {
  return db.tx(async (tx) => {
    await tx.query('select id from public.users where id = $1 for update', [userId])
    const existing = map(await tx.one('select * from public.usage_ledger where idempotency_key = $1', [input.idempotencyKey]))
    const before = await totals(tx, userId, input.meter, input.periodStart)
    if (existing) {
      if (existing.userId !== userId) throw new Error('usage ledger idempotency key belongs to another user')
      return { ok: true, entry: existing, created: false, used: before.used }
    }
    if (before.used + input.amount > input.limit) return { ok: false, used: before.used, limit: input.limit }
    const { limit: _limit, ...entry } = input
    const result = await record(tx, userId, { ...entry, kind: 'reserve' })
    return { ok: true, entry: result.entry, created: result.created, used: before.used + input.amount }
  })
}

/** Every entry about one subject (e.g. a source media id), oldest first. */
export async function listForSubject(db: Db, userId: string, subjectId: string): Promise<LedgerRow[]> {
  const rows = await db.query(
    'select * from public.usage_ledger where user_id = $1 and subject_id = $2 order by created_at, kind, id',
    [userId, subjectId],
  )
  return camelRows<LedgerRow>(rows)
}

export interface ListLedgerOptions {
  meter?: UsageMeter
  periodStart?: Date
  limit?: number
}

/** Newest first. */
export async function list(db: Db, userId: string, options: ListLedgerOptions = {}): Promise<LedgerRow[]> {
  const rows = await db.query(
    `select * from public.usage_ledger
      where user_id = $1
        and ($2::public.usage_meter is null or meter = $2)
        and ($3::timestamptz is null or period_start = $3::timestamptz)
      order by created_at desc, id desc
      limit $4`,
    [userId, options.meter ?? null, options.periodStart ?? null, clampLimit(options.limit, 100, 1000)],
  )
  return camelRows<LedgerRow>(rows)
}
