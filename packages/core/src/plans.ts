// Plans, add-ons and entitlements: the single source of truth for what each plan allows.
// Product decisions live here (docs/ARCHITECTURE.md, "Plans and metering" and "Product decisions").

import type { PlanTier, SubscriptionStatus } from './types'
import { PLAN_TIERS } from './types'

export const HOUR_SECONDS = 3_600
/** Decimal gigabyte (storage is sold and billed by R2 in GB = 10^9 bytes). */
export const GB = 1_000_000_000

export interface PlanDefinition {
  tier: PlanTier
  name: string
  /** Monthly price in cents. */
  priceCents: number
  brands: number
  clipHours: number
  /** Published X posts containing a link, per period (Upload-Post strips links without a paid add-on). */
  xLinkPosts: number
  storageBytes: number
  /** Stripe price lookup key. */
  lookupKey: string
}

/** X link posts are off by default; raise this (and buy the Upload-Post X Links add-on) to enable them. */
export const X_LINK_POSTS_PER_PLAN = 0

export const PLANS: Readonly<Record<PlanTier, PlanDefinition>> = {
  starter: {
    tier: 'starter',
    name: 'Starter',
    priceCents: 800,
    brands: 1,
    clipHours: 4,
    xLinkPosts: X_LINK_POSTS_PER_PLAN,
    storageBytes: 50 * GB,
    lookupKey: 'starter',
  },
  plus: {
    tier: 'plus',
    name: 'Plus',
    priceCents: 1_500,
    brands: 2,
    clipHours: 10,
    xLinkPosts: X_LINK_POSTS_PER_PLAN,
    storageBytes: 100 * GB,
    lookupKey: 'plus',
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    priceCents: 2_500,
    brands: 4,
    clipHours: 20,
    xLinkPosts: X_LINK_POSTS_PER_PLAN,
    storageBytes: 200 * GB,
    lookupKey: 'pro',
  },
}

export const ADD_ON_KEYS = ['extra_brand', 'extra_clip_hour'] as const
export type AddOnKey = (typeof ADD_ON_KEYS)[number]

export interface AddOnDefinition {
  key: AddOnKey
  name: string
  /** Monthly price per unit in cents (recurring Stripe quantity). */
  priceCents: number
  lookupKey: string
  maxQuantity: number
}

export const ADD_ONS: Readonly<Record<AddOnKey, AddOnDefinition>> = {
  extra_brand: { key: 'extra_brand', name: 'Extra brand', priceCents: 300, lookupKey: 'extra_brand', maxQuantity: 20 },
  extra_clip_hour: {
    key: 'extra_clip_hour',
    name: 'Extra clipping hour',
    priceCents: 100,
    lookupKey: 'extra_clip_hour',
    maxQuantity: 200,
  },
}

/** Every Stripe price lookup key we sell. */
export const STRIPE_LOOKUP_KEYS = [
  ...PLAN_TIERS.map((t) => PLANS[t].lookupKey),
  ...ADD_ON_KEYS.map((k) => ADD_ONS[k].lookupKey),
] as const

export function planFromLookupKey(lookupKey: string | null | undefined): PlanTier | null {
  if (!lookupKey) return null
  return PLAN_TIERS.find((t) => PLANS[t].lookupKey === lookupKey) ?? null
}

export function addOnFromLookupKey(lookupKey: string | null | undefined): AddOnKey | null {
  if (!lookupKey) return null
  return ADD_ON_KEYS.find((k) => ADD_ONS[k].lookupKey === lookupKey) ?? null
}

/** Trial: 7 days of Starter with 1 clipping hour. */
export const TRIAL = {
  days: 7,
  plan: 'starter' as PlanTier,
  clipHours: 1,
} as const

/** What one X link post costs us through Upload-Post's X Links add-on ($19 / 50 posts), for internal tracking. */
export const X_LINK_POST_COST_CENTS = 38

/** Source video limits and retention. */
export const SOURCE_LIMITS = {
  maxDurationMs: 4 * HOUR_SECONDS * 1_000,
  maxBytes: 10 * GB,
  retentionDays: 30,
} as const

export interface AddOns {
  extraBrands: number
  extraClipHours: number
}

export const NO_ADD_ONS: Readonly<AddOns> = { extraBrands: 0, extraClipHours: 0 }

export interface Entitlements {
  /** The plan whose limits apply (Starter during a trial); null without a usable subscription. */
  plan: PlanTier | null
  status: SubscriptionStatus
  trial: boolean
  /** Maximum active brands. */
  brands: number
  /** Clipping allowance per period, in seconds of source video. */
  clipSeconds: number
  xLinkPosts: number
  storageBytes: number
  /** Approved posts keep publishing. */
  canPublish: boolean
  /** New drafts, approvals, scheduling, brands, connections. */
  canCreate: boolean
  /** New clipping, transcription and rendering. */
  canProcessMedia: boolean
}

function clampQuantity(n: number, max: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.floor(n), max)
}

function zeroEntitlements(status: SubscriptionStatus): Entitlements {
  return {
    plan: null,
    status,
    trial: false,
    brands: 0,
    clipSeconds: 0,
    xLinkPosts: 0,
    storageBytes: 0,
    canPublish: false,
    canCreate: false,
    canProcessMedia: false,
  }
}

/**
 * Limits and permissions for a user.
 * - active: plan + add-ons, everything allowed.
 * - trialing: Starter limits with TRIAL.clipHours; add-ons are ignored (the trial is free).
 * - past_due: plan + add-ons; approved posts keep publishing, but new clipping/rendering is blocked.
 * - canceled / unpaid / none, or no plan: everything is held (read-only); nothing is deleted.
 */
export function entitlements(
  plan: PlanTier | null | undefined,
  addOns: Partial<AddOns> | null | undefined,
  status: SubscriptionStatus,
): Entitlements {
  if (status === 'trialing') {
    const base = PLANS[TRIAL.plan]
    return {
      plan: base.tier,
      status,
      trial: true,
      brands: base.brands,
      clipSeconds: TRIAL.clipHours * HOUR_SECONDS,
      xLinkPosts: base.xLinkPosts,
      storageBytes: base.storageBytes,
      canPublish: true,
      canCreate: true,
      canProcessMedia: true,
    }
  }
  if (!plan || (status !== 'active' && status !== 'past_due')) return zeroEntitlements(status)

  const def = PLANS[plan]
  const extraBrands = clampQuantity(addOns?.extraBrands ?? 0, ADD_ONS.extra_brand.maxQuantity)
  const extraClipHours = clampQuantity(addOns?.extraClipHours ?? 0, ADD_ONS.extra_clip_hour.maxQuantity)
  return {
    plan,
    status,
    trial: false,
    brands: def.brands + extraBrands,
    clipSeconds: (def.clipHours + extraClipHours) * HOUR_SECONDS,
    xLinkPosts: def.xLinkPosts,
    storageBytes: def.storageBytes,
    canPublish: true,
    canCreate: true,
    canProcessMedia: status === 'active',
  }
}

/** Monthly price in cents for a plan plus add-on quantities. */
export function monthlyPriceCents(plan: PlanTier, addOns: Partial<AddOns> = NO_ADD_ONS): number {
  const extraBrands = clampQuantity(addOns.extraBrands ?? 0, ADD_ONS.extra_brand.maxQuantity)
  const extraClipHours = clampQuantity(addOns.extraClipHours ?? 0, ADD_ONS.extra_clip_hour.maxQuantity)
  return (
    PLANS[plan].priceCents +
    extraBrands * ADD_ONS.extra_brand.priceCents +
    extraClipHours * ADD_ONS.extra_clip_hour.priceCents
  )
}

/** "$8", "$15.50" */
export function formatCents(cents: number): string {
  const dollars = cents / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

/** Whole clipping hours → seconds (the unit the usage ledger stores). */
export const clipHoursToSeconds = (hours: number): number => Math.round(hours * HOUR_SECONDS)

/** Seconds → hours rounded to one decimal, for display. */
export const secondsToClipHours = (seconds: number): number => Math.round((seconds / HOUR_SECONDS) * 10) / 10
