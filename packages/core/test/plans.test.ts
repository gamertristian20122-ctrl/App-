import { describe, expect, it } from 'vitest'
import {
  ADD_ONS,
  GB,
  HOUR_SECONDS,
  PLANS,
  SOURCE_LIMITS,
  STRIPE_LOOKUP_KEYS,
  TRIAL,
  X_LINK_POSTS_PER_PLAN,
  addOnFromLookupKey,
  clipHoursToSeconds,
  entitlements,
  formatCents,
  monthlyPriceCents,
  planFromLookupKey,
  secondsToClipHours,
} from '../src/plans'

describe('plan table', () => {
  it('matches the pricing in CLAUDE.md and ARCHITECTURE.md', () => {
    expect(PLANS.starter).toMatchObject({ priceCents: 800, brands: 1, clipHours: 4, storageBytes: 50 * GB })
    expect(PLANS.plus).toMatchObject({ priceCents: 1500, brands: 2, clipHours: 10, storageBytes: 100 * GB })
    expect(PLANS.pro).toMatchObject({ priceCents: 2500, brands: 4, clipHours: 20, storageBytes: 200 * GB })
    expect(ADD_ONS.extra_brand.priceCents).toBe(300)
    expect(ADD_ONS.extra_clip_hour.priceCents).toBe(100)
  })

  it('allows no X link posts by default', () => {
    expect(X_LINK_POSTS_PER_PLAN).toBe(0)
    for (const p of Object.values(PLANS)) expect(p.xLinkPosts).toBe(0)
  })

  it('has a 7-day Starter trial with 1 clip hour', () => {
    expect(TRIAL).toEqual({ days: 7, plan: 'starter', clipHours: 1 })
  })

  it('limits sources to 4 h and 10 GB, kept 30 days', () => {
    expect(SOURCE_LIMITS.maxDurationMs).toBe(4 * 3600 * 1000)
    expect(SOURCE_LIMITS.maxBytes).toBe(10 * GB)
    expect(SOURCE_LIMITS.retentionDays).toBe(30)
  })

  it('maps Stripe lookup keys both ways', () => {
    expect(STRIPE_LOOKUP_KEYS).toEqual(['starter', 'plus', 'pro', 'extra_brand', 'extra_clip_hour'])
    expect(planFromLookupKey('plus')).toBe('plus')
    expect(planFromLookupKey('extra_brand')).toBeNull()
    expect(planFromLookupKey(null)).toBeNull()
    expect(addOnFromLookupKey('extra_clip_hour')).toBe('extra_clip_hour')
    expect(addOnFromLookupKey('pro')).toBeNull()
    expect(addOnFromLookupKey(undefined)).toBeNull()
  })
})

describe('entitlements', () => {
  it('active: plan plus add-ons, everything allowed', () => {
    const e = entitlements('plus', { extraBrands: 1, extraClipHours: 5 }, 'active')
    expect(e).toEqual({
      plan: 'plus',
      status: 'active',
      trial: false,
      brands: 3,
      clipSeconds: 15 * HOUR_SECONDS,
      xLinkPosts: 0,
      storageBytes: 100 * GB,
      canPublish: true,
      canCreate: true,
      canProcessMedia: true,
    })
  })

  it('trialing: Starter limits with 1 clip hour, add-ons ignored', () => {
    const e = entitlements('pro', { extraBrands: 3, extraClipHours: 10 }, 'trialing')
    expect(e).toMatchObject({ plan: 'starter', trial: true, brands: 1, clipSeconds: HOUR_SECONDS, canProcessMedia: true })
    expect(entitlements(null, null, 'trialing').plan).toBe('starter')
  })

  it('past_due keeps publishing but blocks clipping and rendering', () => {
    const e = entitlements('starter', null, 'past_due')
    expect(e).toMatchObject({ brands: 1, canPublish: true, canCreate: true, canProcessMedia: false })
  })

  it.each(['canceled', 'unpaid', 'none'] as const)('%s holds everything', (status) => {
    const e = entitlements('pro', { extraBrands: 2 }, status)
    expect(e).toMatchObject({
      plan: null,
      brands: 0,
      clipSeconds: 0,
      canPublish: false,
      canCreate: false,
      canProcessMedia: false,
    })
  })

  it('active without a plan is treated as no plan', () => {
    expect(entitlements(null, null, 'active').canCreate).toBe(false)
  })

  it('ignores negative, fractional and absurd add-on quantities', () => {
    expect(entitlements('starter', { extraBrands: -3, extraClipHours: 2.9 }, 'active')).toMatchObject({
      brands: 1,
      clipSeconds: 6 * HOUR_SECONDS,
    })
    expect(entitlements('starter', { extraBrands: Number.NaN }, 'active').brands).toBe(1)
    expect(entitlements('starter', { extraBrands: 1e9 }, 'active').brands).toBe(1 + ADD_ONS.extra_brand.maxQuantity)
  })
})

describe('pricing helpers', () => {
  it('computes monthly price with add-ons', () => {
    expect(monthlyPriceCents('starter')).toBe(800)
    expect(monthlyPriceCents('plus', { extraBrands: 2, extraClipHours: 3 })).toBe(1500 + 600 + 300)
  })

  it('formats cents', () => {
    expect(formatCents(800)).toBe('$8')
    expect(formatCents(1550)).toBe('$15.50')
  })

  it('converts clip hours', () => {
    expect(clipHoursToSeconds(1.5)).toBe(5400)
    expect(secondsToClipHours(5400)).toBe(1.5)
    expect(secondsToClipHours(100)).toBe(0)
  })
})
