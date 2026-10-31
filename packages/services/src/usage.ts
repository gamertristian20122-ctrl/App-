// Usage metering on the append-only ledger: reserve → settle | release, idempotent by key.
// clip_seconds: seconds of source video, reserved when a source is ingested (duration known),
// settled when its transcript is saved, released if ingest/transcription fails. Charged once per
// source video. x_link_posts: one per published X post containing a link (allowance 0 today).

import { z } from 'zod'
import { AppError } from '@app/core/errors'
import { HOUR_SECONDS, secondsToClipHours } from '@app/core/plans'
import type { UsageMeter } from '@app/core/types'
import { UsageMeterSchema } from '@app/core/types'
import { IdSchema } from '@app/core/validation'
import type { BoundRepos, LedgerRow } from '@app/db'
import { requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { requireCanProcessMedia, userEntitlements, type UserEntitlements } from './entitlements'

export interface UsageBalance {
  meter: UsageMeter
  /** Allowance for the period (plan + add-ons; trial: 1 h for clip_seconds). */
  limit: number
  /** settled + outstanding reservations + adjustments. */
  used: number
  settled: number
  /** Reservations not yet settled or released. */
  reserved: number
  remaining: number
  period: { start: Date; end: Date }
}

export interface ReserveInput {
  meter: UsageMeter
  /** Positive integer (seconds for clip_seconds, posts for x_link_posts). */
  amount: number
  /** Unique per reservation, e.g. `clip_seconds:reserve:<mediaId>`. */
  idempotencyKey: string
  subjectType?: string
  subjectId?: string
  note?: string
}

export interface ReserveResult {
  entry: LedgerRow
  /** false when the key already existed (nothing new was reserved). */
  created: boolean
  balance: UsageBalance
}

const KeySchema = z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9:_.-]+$/, 'Invalid idempotency key.')

const ReserveSchema = z
  .object({
    meter: UsageMeterSchema,
    amount: z.number().int().min(1).max(10_000_000),
    idempotencyKey: KeySchema,
    subjectType: z.string().min(1).max(64).optional(),
    subjectId: IdSchema.optional(),
    note: z.string().max(1_000).optional(),
  })
  .refine((v) => (v.subjectType === undefined) === (v.subjectId === undefined), 'Give both subjectType and subjectId, or neither.')

/** The clip_seconds reservation key of one source video (charged once per source). */
export const clipReserveKey = (mediaId: string) => `clip_seconds:reserve:${mediaId}`

function key(value: unknown): string {
  const parsed = KeySchema.safeParse(value)
  if (!parsed.success) throw validation('Invalid idempotency key.')
  return parsed.data
}

export const releaseKeyFor = (reserveKey: string) => `${reserveKey}:release`
export const settleKeyFor = (reserveKey: string) => `${reserveKey}:settle`

function limitFor(ent: UserEntitlements, meter: UsageMeter): number {
  return meter === 'clip_seconds' ? ent.clipSeconds : ent.xLinkPosts
}

function describe(meter: UsageMeter, amount: number): string {
  if (meter === 'clip_seconds') {
    const hours = amount / HOUR_SECONDS
    return hours >= 0.1 ? `${secondsToClipHours(amount)} h` : `${Math.ceil(amount / 60)} min`
  }
  return `${amount} post${amount === 1 ? '' : 's'}`
}

export async function balanceIn(r: BoundRepos, userId: string, ent: UserEntitlements, meter: UsageMeter): Promise<UsageBalance> {
  const totals = await r.usage.totals(userId, meter, ent.period.start)
  const limit = limitFor(ent, meter)
  return {
    meter,
    limit,
    used: totals.used,
    settled: totals.settled,
    reserved: totals.outstanding,
    remaining: Math.max(0, limit - totals.used),
    period: { start: ent.period.start, end: ent.period.end },
  }
}

/**
 * Reserve inside an existing transaction (the caller enqueues the work in the same tx).
 * Refuses with limit_exceeded (details.remaining) when the balance is too small; payment_required
 * when clipping is not allowed (past_due, canceled, unpaid, trial over).
 */
export async function reserveIn(ctx: Ctx, r: BoundRepos, userId: string, input: ReserveInput): Promise<ReserveResult> {
  const parsed = ReserveSchema.safeParse(input)
  if (!parsed.success) throw validation('Invalid usage reservation.')
  const data = parsed.data
  const user = await requireUser(r, userId, true)
  const ent = userEntitlements(user, ctx.now())
  if (data.meter === 'clip_seconds') requireCanProcessMedia(ent)
  const limit = limitFor(ent, data.meter)
  const result = await r.usage.reserveWithinLimit(userId, {
    meter: data.meter,
    amount: data.amount,
    periodStart: ent.period.start,
    idempotencyKey: data.idempotencyKey,
    subjectType: data.subjectType ?? null,
    subjectId: data.subjectId ?? null,
    note: data.note ?? null,
    limit,
  })
  if (!result.ok) {
    const remaining = Math.max(0, result.limit - result.used)
    throw new AppError(
      'limit_exceeded',
      data.meter === 'clip_seconds'
        ? `Not enough clipping time left this period: this needs ${describe(data.meter, data.amount)}, ${describe(data.meter, remaining)} remain${remaining === 0 ? '' : 's'}.`
        : `Not enough ${data.meter} allowance left this period.`,
      {
        meter: data.meter,
        requested: data.amount,
        remaining,
        limit: result.limit,
        used: result.used,
        periodEnd: ent.period.end.toISOString(),
      },
    )
  }
  return { entry: result.entry, created: result.created, balance: await balanceIn(r, userId, ent, data.meter) }
}

async function findEntry(r: BoundRepos, userId: string, key: string, subjectId?: string | null): Promise<LedgerRow | null> {
  if (subjectId) {
    const rows = await r.usage.listForSubject(userId, subjectId)
    const hit = rows.find((e) => e.idempotencyKey === key)
    if (hit) return hit
  }
  // fall back to a period-agnostic scan of the most recent entries
  const recent = await r.usage.list(userId, { limit: 1000 })
  return recent.find((e) => e.idempotencyKey === key) ?? null
}

export interface SettleInput {
  /** The reservation's idempotency key. */
  reserveKey: string
  /** What was actually consumed (default: the reserved amount). Never more than reserved. */
  amount?: number
  /** Helps find the reservation quickly (e.g. the media id). */
  subjectId?: string
}

export interface SettleResult {
  settled: number
  released: number
  /** false when this reservation was already settled (idempotent replay). */
  created: boolean
}

/**
 * Settles a reservation: one transaction writes a `release` of the reserved amount and a `settle`
 * of the consumed amount, in the reservation's own period. Idempotent (keys derived from the
 * reservation key). A reservation that was already released is still settled (the work happened).
 */
export async function settleIn(r: BoundRepos, userId: string, input: SettleInput): Promise<SettleResult> {
  const reserveKey = key(input.reserveKey)
  const reservation = await findEntry(r, userId, reserveKey, input.subjectId)
  if (!reservation || reservation.kind !== 'reserve') throw validation('No such usage reservation.')
  const amount = Math.max(0, Math.min(reservation.amount, Math.floor(input.amount ?? reservation.amount)))
  const common = {
    meter: reservation.meter,
    periodStart: reservation.periodStart,
    subjectType: reservation.subjectType,
    subjectId: reservation.subjectId,
  }
  const release = await r.usage.record(userId, {
    ...common,
    kind: 'release',
    amount: reservation.amount,
    idempotencyKey: releaseKeyFor(reserveKey),
    note: 'settled',
  })
  if (amount === 0) return { settled: 0, released: release.created ? reservation.amount : 0, created: release.created }
  const settle = await r.usage.record(userId, {
    ...common,
    kind: 'settle',
    amount,
    idempotencyKey: settleKeyFor(reserveKey),
  })
  return {
    settled: settle.created ? amount : 0,
    released: release.created ? reservation.amount : 0,
    created: settle.created,
  }
}

/** Returns a reservation (failure). No-op when it was already settled or released. */
export async function releaseIn(r: BoundRepos, userId: string, input: { reserveKey: string; subjectId?: string; note?: string }) {
  const reserveKey = key(input.reserveKey)
  const reservation = await findEntry(r, userId, reserveKey, input.subjectId)
  if (!reservation || reservation.kind !== 'reserve') return { released: 0, created: false }
  const result = await r.usage.record(userId, {
    meter: reservation.meter,
    kind: 'release',
    amount: reservation.amount,
    periodStart: reservation.periodStart,
    subjectType: reservation.subjectType,
    subjectId: reservation.subjectId,
    idempotencyKey: releaseKeyFor(reserveKey),
    note: input.note ?? 'released',
  })
  return { released: result.created ? reservation.amount : 0, created: result.created }
}

/** Records consumption without a limit check (e.g. a published X post with a link). Idempotent. */
export async function recordConsumptionIn(
  ctx: Ctx,
  r: BoundRepos,
  userId: string,
  input: { meter: UsageMeter; amount: number; idempotencyKey: string; subjectType?: string; subjectId?: string },
) {
  const user = await requireUser(r, userId)
  const ent = userEntitlements(user, ctx.now())
  return r.usage.record(userId, {
    meter: input.meter,
    kind: 'settle',
    amount: input.amount,
    periodStart: ent.period.start,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    idempotencyKey: key(input.idempotencyKey),
  })
}

export function createUsageService(ctx: Ctx) {
  return withErrors({
    /** Balance of one meter for the current period. */
    async balance(userId: string, meter: UsageMeter = 'clip_seconds'): Promise<UsageBalance> {
      const uid = userIdOf(userId)
      const m = UsageMeterSchema.parse(meter)
      const user = await requireUser(ctx.repos, uid)
      return balanceIn(ctx.repos, uid, userEntitlements(user, ctx.now()), m)
    },

    /** Both meters (dashboard). */
    async balances(userId: string): Promise<Record<UsageMeter, UsageBalance>> {
      const uid = userIdOf(userId)
      const user = await requireUser(ctx.repos, uid)
      const ent = userEntitlements(user, ctx.now())
      return {
        clip_seconds: await balanceIn(ctx.repos, uid, ent, 'clip_seconds'),
        x_link_posts: await balanceIn(ctx.repos, uid, ent, 'x_link_posts'),
      }
    },

    async reserve(userId: string, input: ReserveInput): Promise<ReserveResult> {
      const uid = userIdOf(userId)
      return ctx.tx((r) => reserveIn(ctx, r, uid, input))
    },

    async settle(userId: string, input: SettleInput): Promise<SettleResult> {
      const uid = userIdOf(userId)
      return ctx.tx((r) => settleIn(r, uid, input))
    },

    async release(userId: string, input: { reserveKey: string; subjectId?: string; note?: string }) {
      const uid = userIdOf(userId)
      return ctx.tx((r) => releaseIn(r, uid, input))
    },

    /** Ledger entries, newest first (billing page). */
    async history(userId: string, options: { meter?: UsageMeter; limit?: number } = {}) {
      return ctx.repos.usage.list(userIdOf(userId), {
        ...(options.meter ? { meter: UsageMeterSchema.parse(options.meter) } : {}),
        limit: options.limit ?? 50,
      })
    },
  })
}

export type UsageService = ReturnType<typeof createUsageService>
