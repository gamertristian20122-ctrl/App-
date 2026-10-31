import type { PlanTier, SubscriptionStatus } from '@app/core/types'
import { camelRow, setClause } from '../sql'
import type { Db } from '../types'

export interface UserRow {
  id: string
  email: string
  displayName: string | null
  timezone: string
  plan: PlanTier | null
  subscriptionStatus: SubscriptionStatus
  trialEndsAt: Date | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  extraBrands: number
  extraClipHours: number
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  createdAt: Date
  updatedAt: Date
}

const map = (row: Record<string, unknown> | null): UserRow | null => (row ? camelRow<UserRow>(row) : null)

export interface EnsureUserInput {
  email: string
  displayName?: string | null
  timezone?: string
}

/**
 * Creates the app user for an existing auth user (Supabase Auth owns auth.users), or refreshes
 * its email. Returns the row.
 */
export async function ensure(db: Db, userId: string, input: EnsureUserInput): Promise<UserRow> {
  const row = await db.one(
    `insert into public.users (id, email, display_name, timezone)
     values ($1, $2, $3, coalesce($4, 'UTC'))
     on conflict (id) do update
       set email = excluded.email,
           display_name = coalesce(public.users.display_name, excluded.display_name)
     returning *`,
    [userId, input.email, input.displayName ?? null, input.timezone ?? null],
  )
  return map(row) as UserRow
}

/**
 * Local dev and tests only (DEV_AUTH / PGlite with the Supabase shim): creates the auth.users
 * row that Supabase Auth would own. Never call this against Supabase.
 */
export async function devEnsureAuthUser(db: Db, userId: string, email: string): Promise<void> {
  await db.query(
    `insert into auth.users (id, email) values ($1, $2)
     on conflict (id) do update set email = excluded.email`,
    [userId, email],
  )
}

export async function get(db: Db, userId: string): Promise<UserRow | null> {
  return map(await db.one('select * from public.users where id = $1', [userId]))
}

/** SELECT ... FOR UPDATE on the user row: serialises brand-limit and usage checks. Use in a tx. */
export async function lockForUpdate(db: Db, userId: string): Promise<UserRow | null> {
  return map(await db.one('select * from public.users where id = $1 for update', [userId]))
}

export interface UserProfilePatch {
  email?: string
  displayName?: string | null
  timezone?: string
}

export async function updateProfile(db: Db, userId: string, patch: UserProfilePatch): Promise<UserRow | null> {
  const set = setClause({ ...patch }, { email: 'email', displayName: 'display_name', timezone: 'timezone' }, 2)
  if (!set) return get(db, userId)
  return map(await db.one(`update public.users set ${set.sql} where id = $1 returning *`, [userId, ...set.params]))
}

export interface UserBillingPatch {
  plan?: PlanTier | null
  subscriptionStatus?: SubscriptionStatus
  trialEndsAt?: Date | null
  currentPeriodStart?: Date | null
  currentPeriodEnd?: Date | null
  extraBrands?: number
  extraClipHours?: number
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
}

export async function updateBilling(db: Db, userId: string, patch: UserBillingPatch): Promise<UserRow | null> {
  const set = setClause(
    { ...patch },
    {
      plan: { column: 'plan', cast: 'public.plan_tier' },
      subscriptionStatus: { column: 'subscription_status', cast: 'public.subscription_status' },
      trialEndsAt: { column: 'trial_ends_at', cast: 'timestamptz' },
      currentPeriodStart: { column: 'current_period_start', cast: 'timestamptz' },
      currentPeriodEnd: { column: 'current_period_end', cast: 'timestamptz' },
      extraBrands: { column: 'extra_brands', cast: 'int' },
      extraClipHours: { column: 'extra_clip_hours', cast: 'int' },
      stripeCustomerId: 'stripe_customer_id',
      stripeSubscriptionId: 'stripe_subscription_id',
    },
    2,
  )
  if (!set) return get(db, userId)
  return map(await db.one(`update public.users set ${set.sql} where id = $1 returning *`, [userId, ...set.params]))
}

/** Stripe webhook lookup (not user-scoped: the event names the customer). */
export async function findByStripeCustomerId(db: Db, customerId: string): Promise<UserRow | null> {
  return map(await db.one('select * from public.users where stripe_customer_id = $1', [customerId]))
}

/** Stripe webhook lookup (not user-scoped: the event names the subscription). */
export async function findByStripeSubscriptionId(db: Db, subscriptionId: string): Promise<UserRow | null> {
  return map(await db.one('select * from public.users where stripe_subscription_id = $1', [subscriptionId]))
}

/** Deletes the user and, by cascade, everything they own. */
export async function remove(db: Db, userId: string): Promise<boolean> {
  const rows = await db.query('delete from public.users where id = $1 returning id', [userId])
  return rows.length > 0
}
