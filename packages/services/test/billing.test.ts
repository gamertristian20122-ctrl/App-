import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestBrand, createTestUser } from '@app/db/testing'
import { createServices } from '../src'
import { START, createHarness, expectAppError, resetHarness, type Harness } from './helpers'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.db.close()
})
beforeEach(async () => {
  await resetHarness(h)
})

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
let n = 0
const evtId = () => `evt_test_${++n}`

function subscription(opts: {
  id?: string
  customer?: string
  status?: string
  plan?: string
  extraBrands?: number
  extraClipHours?: number
  userId?: string
  start?: string
  end?: string
}) {
  const start = sec(opts.start ?? '2026-11-01T00:00:00Z')
  const end = sec(opts.end ?? '2026-12-01T00:00:00Z')
  const items = [{ id: 'si_plan', price: { id: `price_${opts.plan ?? 'starter'}`, lookup_key: opts.plan ?? 'starter' }, quantity: 1, current_period_start: start, current_period_end: end }]
  if (opts.extraBrands) items.push({ id: 'si_b', price: { id: 'price_eb', lookup_key: 'extra_brand' }, quantity: opts.extraBrands, current_period_start: start, current_period_end: end })
  if (opts.extraClipHours) items.push({ id: 'si_h', price: { id: 'price_eh', lookup_key: 'extra_clip_hour' }, quantity: opts.extraClipHours, current_period_start: start, current_period_end: end })
  return {
    id: opts.id ?? 'sub_123',
    object: 'subscription',
    customer: opts.customer ?? 'cus_123',
    status: opts.status ?? 'active',
    items: { object: 'list', data: items },
    metadata: opts.userId ? { userId: opts.userId } : {},
    cancel_at_period_end: false,
  }
}

const event = (type: string, object: unknown, id = evtId()) => ({ id, object: 'event', type, created: 1, data: { object } })

describe('billing.applyStripeEvent', () => {
  it('maps subscription.created to plan, status, period and add-on quantities', async () => {
    const user = await createTestUser(h.db, { plan: null, subscriptionStatus: 'none' })
    const res = await h.s.billing.applyStripeEvent(
      event('customer.subscription.created', subscription({ plan: 'plus', extraBrands: 1, extraClipHours: 5, userId: user.id })),
    )
    expect(res).toMatchObject({ status: 'processed', userId: user.id, billing: { plan: 'plus', status: 'active', extraBrands: 1, extraClipHours: 5 } })
    const row = await h.s.users.get(user.id)
    expect(row).toMatchObject({ stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' })
    expect(row.currentPeriodStart?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(row.currentPeriodEnd?.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(await h.s.users.getEntitlements(user.id)).toMatchObject({ brands: 3, clipSeconds: 15 * 3_600 })
  })

  it('is idempotent per Stripe event id', async () => {
    const user = await createTestUser(h.db, { plan: null, subscriptionStatus: 'none' })
    const e = event('customer.subscription.created', subscription({ plan: 'pro', userId: user.id }))
    expect((await h.s.billing.applyStripeEvent(e)).status).toBe('processed')
    expect((await h.s.billing.applyStripeEvent(e)).status).toBe('duplicate')
    expect(await h.s.audit.list(user.id, { action: 'billing.subscription_synced' })).toHaveLength(1)
    const rows = await h.db.query<{ processed_at: Date | null }>('select processed_at from public.stripe_events')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.processed_at).not.toBeNull()
  })

  it('downgrade suspends the newest brands; upgrade restores them', async () => {
    const user = await createTestUser(h.db, { plan: 'pro', stripeCustomerId: 'cus_123' })
    for (const name of ['A', 'B', 'C']) {
      await createTestBrand(h.db, user.id, { name })
      await new Promise((r) => setTimeout(r, 3))
    }
    await h.s.billing.applyStripeEvent(event('customer.subscription.updated', subscription({ plan: 'pro' })))
    const down = await h.s.billing.applyStripeEvent(event('customer.subscription.updated', subscription({ plan: 'starter' })))
    expect(down.brands?.suspended.map((b) => b.name).sort()).toEqual(['B', 'C'])
    expect(await h.r.brands.countActive(user.id)).toBe(1)
    const up = await h.s.billing.applyStripeEvent(event('customer.subscription.updated', subscription({ plan: 'starter', extraBrands: 2 })))
    expect(up.brands?.restored).toHaveLength(2)
    expect(await h.r.brands.countActive(user.id)).toBe(3)
  })

  it('deleted → canceled (held, nothing deleted); a stale event of an old subscription is ignored', async () => {
    const user = await createTestUser(h.db, { plan: null, subscriptionStatus: 'none', stripeCustomerId: 'cus_123' })
    await createTestBrand(h.db, user.id)
    await h.s.billing.applyStripeEvent(event('customer.subscription.created', subscription({ id: 'sub_old', plan: 'starter' })))
    await h.s.billing.applyStripeEvent(event('customer.subscription.created', subscription({ id: 'sub_new', plan: 'plus' })))
    expect((await h.s.users.get(user.id)).stripeSubscriptionId).toBe('sub_new')
    const stale = await h.s.billing.applyStripeEvent(event('customer.subscription.deleted', subscription({ id: 'sub_old', status: 'canceled' })))
    expect(stale.status).toBe('ignored')
    expect((await h.s.users.get(user.id)).subscriptionStatus).toBe('active')

    const del = await h.s.billing.applyStripeEvent(event('customer.subscription.deleted', subscription({ id: 'sub_new', status: 'canceled', plan: 'plus' })))
    expect(del.billing).toMatchObject({ status: 'canceled', plan: 'plus' })
    expect(await h.s.users.getEntitlements(user.id)).toMatchObject({ canCreate: false, canPublish: false })
    expect(await h.r.brands.countActive(user.id)).toBe(1)
  })

  it('invoice.payment_failed → past_due (publishing continues, clipping blocked)', async () => {
    const user = await createTestUser(h.db, { plan: 'plus', stripeCustomerId: 'cus_9' })
    await h.r.users.updateBilling(user.id, { stripeSubscriptionId: 'sub_9' })
    const res = await h.s.billing.applyStripeEvent(
      event('invoice.payment_failed', { id: 'in_1', customer: 'cus_9', parent: { subscription_details: { subscription: 'sub_9' } } }),
    )
    expect(res.billing?.status).toBe('past_due')
    expect(await h.s.users.getEntitlements(user.id)).toMatchObject({ canPublish: true, canProcessMedia: false })
  })

  it('a late invoice.payment_failed retry does not undo a recovery (review): it applies the subscription as Stripe has it now', async () => {
    const user = await createTestUser(h.db, { plan: 'plus', stripeCustomerId: 'cus_late' })
    await h.r.users.updateBilling(user.id, { stripeSubscriptionId: 'sub_late' })
    let status = 'active' // the card was fixed and the invoice paid before Stripe retried this event
    const fetchSubscription = async (id: string) => subscription({ id, customer: 'cus_late', plan: 'plus', status })
    const failed = event('invoice.payment_failed', { id: 'in_late', customer: 'cus_late', parent: { subscription_details: { subscription: 'sub_late' } } })
    const res = await h.s.billing.applyStripeEvent(failed, { fetchSubscription })
    expect(res).toMatchObject({ status: 'processed', billing: { status: 'active' } })
    expect(await h.s.users.getEntitlements(user.id)).toMatchObject({ canProcessMedia: true })

    // while the subscription really is past_due, the event puts the user on past_due
    status = 'past_due'
    const again = await h.s.billing.applyStripeEvent(
      event('invoice.payment_failed', { id: 'in_late2', customer: 'cus_late', subscription: 'sub_late' }),
      { fetchSubscription },
    )
    expect(again.billing?.status).toBe('past_due')
    expect(await h.s.audit.list(user.id, { action: 'billing.payment_failed' })).toHaveLength(1)
  })

  it('a failed subscription fetch is retried by Stripe, never applied from the stale payload (review)', async () => {
    const user = await createTestUser(h.db, { plan: 'plus', stripeCustomerId: 'cus_f' })
    await h.r.users.updateBilling(user.id, { stripeSubscriptionId: 'sub_f' })
    const down = async () => {
      throw new Error('stripe unavailable')
    }
    const stale = event('customer.subscription.updated', subscription({ id: 'sub_f', customer: 'cus_f', status: 'past_due', plan: 'plus' }))
    await expect(h.s.billing.applyStripeEvent(stale, { fetchSubscription: down })).rejects.toThrow()
    expect((await h.s.users.get(user.id)).subscriptionStatus).toBe('active')
    const inv = event('invoice.payment_failed', { id: 'in_f', customer: 'cus_f', subscription: 'sub_f' })
    await expect(h.s.billing.applyStripeEvent(inv, { fetchSubscription: down })).rejects.toThrow()
    expect((await h.s.users.get(user.id)).subscriptionStatus).toBe('active')
    // Stripe's retry with Stripe reachable again
    const up = async (id: string) => subscription({ id, customer: 'cus_f', plan: 'plus', status: 'active' })
    expect((await h.s.billing.applyStripeEvent(stale, { fetchSubscription: up })).status).toBe('processed')
    expect((await h.s.billing.applyStripeEvent(inv, { fetchSubscription: up })).status).toBe('processed')
    expect((await h.s.users.get(user.id)).subscriptionStatus).toBe('active')
  })

  it('invoice.payment_failed of an older subscription does not hold the current one', async () => {
    // regression: the user was matched through the customer id and put on past_due
    const user = await createTestUser(h.db, { plan: 'plus', stripeCustomerId: 'cus_10' })
    await h.r.users.updateBilling(user.id, { stripeSubscriptionId: 'sub_new' })
    const res = await h.s.billing.applyStripeEvent(
      event('invoice.payment_failed', { id: 'in_old', customer: 'cus_10', parent: { subscription_details: { subscription: 'sub_old' } } }),
    )
    expect(res).toMatchObject({ status: 'ignored', userId: user.id })
    expect((await h.s.users.get(user.id)).subscriptionStatus).toBe('active')
    expect(await h.s.users.getEntitlements(user.id)).toMatchObject({ canProcessMedia: true })
  })

  it('checkout.session.completed links the customer and (with a fetcher) applies the latest subscription', async () => {
    const user = await createTestUser(h.db, { plan: null, subscriptionStatus: 'none' })
    const fetched: string[] = []
    const res = await h.s.billing.applyStripeEvent(
      event('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', customer: 'cus_77', subscription: 'sub_77', client_reference_id: user.id }),
      {
        fetchSubscription: async (id) => {
          fetched.push(id)
          return subscription({ id, customer: 'cus_77', plan: 'pro' })
        },
      },
    )
    expect(fetched).toEqual(['sub_77'])
    expect(res).toMatchObject({ status: 'processed', billing: { plan: 'pro', status: 'active' } })
    expect(await h.s.users.get(user.id)).toMatchObject({ stripeCustomerId: 'cus_77', stripeSubscriptionId: 'sub_77' })
  })

  it('price ids from config map plans when Stripe sends no lookup key', async () => {
    const s = createServices({ db: h.db, provider: h.provider, storage: h.storage, clock: h.clock, config: { stripePrices: { plus: 'price_PLUS123', extra_clip_hour: 'price_HOURS123' } } })
    const user = await createTestUser(h.db, { plan: null, subscriptionStatus: 'none' })
    const sub = {
      id: 'sub_cfg',
      customer: 'cus_cfg',
      status: 'trialing',
      trial_end: sec('2026-11-09T00:00:00Z'),
      metadata: { userId: user.id },
      items: { data: [{ price: { id: 'price_PLUS123', lookup_key: null }, quantity: 1 }, { price: { id: 'price_HOURS123' }, quantity: 3 }] },
      current_period_start: sec('2026-11-02T00:00:00Z'),
      current_period_end: sec('2026-11-09T00:00:00Z'),
    }
    const res = await s.billing.applyStripeEvent(event('customer.subscription.created', sub))
    expect(res.billing).toMatchObject({ plan: 'plus', status: 'trialing', extraClipHours: 3 })
    expect((await s.users.get(user.id)).trialEndsAt?.toISOString()).toBe('2026-11-09T00:00:00.000Z')
  })

  it('unmatched events stay unprocessed (Stripe retries); unknown types are ignored; bad payloads are refused', async () => {
    const e = event('customer.subscription.updated', subscription({ id: 'sub_nobody', customer: 'cus_nobody' }))
    expect((await h.s.billing.applyStripeEvent(e)).status).toBe('unmatched')
    expect((await h.s.billing.applyStripeEvent(e)).status).toBe('unmatched')
    expect((await h.s.billing.applyStripeEvent(event('customer.created', { id: 'cus_1' }))).status).toBe('ignored')
    await expectAppError(h.s.billing.applyStripeEvent({ id: 'evt_bad', type: 'customer.subscription.updated' }), 'validation')
    await expectAppError(h.s.billing.applyStripeEvent(event('customer.subscription.updated', { id: 'sub_x' })), 'validation')
  })
})

describe('billing.checkoutParams / portal / summary', () => {
  it('returns line items by lookup key (price ids when configured)', async () => {
    const user = await createTestUser(h.db, { plan: null, subscriptionStatus: 'none' })
    const params = await h.s.billing.checkoutParams(user.id, { plan: 'plus', extraBrands: 2, extraClipHours: 5 })
    expect(params.lineItems).toEqual([
      { lookupKey: 'plus', price: null, quantity: 1 },
      { lookupKey: 'extra_brand', price: null, quantity: 2 },
      { lookupKey: 'extra_clip_hour', price: null, quantity: 5 },
    ])
    expect(params).toMatchObject({
      mode: 'subscription',
      clientReferenceId: user.id,
      customerEmail: user.email,
      subscriptionData: { metadata: { userId: user.id } },
      monthlyPriceCents: 1_500 + 600 + 500,
      successUrl: expect.stringContaining('https://app.test/app/billing'),
    })
    await expectAppError(h.s.billing.checkoutParams(user.id, { plan: 'gold' }), 'validation')
    await expectAppError(h.s.billing.checkoutParams(user.id, { plan: 'pro', extraBrands: 21 }), 'validation')
    await expectAppError(h.s.billing.portalParams(user.id), 'validation')
  })

  it('refuses a second subscription (use the portal)', async () => {
    const user = await createTestUser(h.db, { plan: 'plus', stripeCustomerId: 'cus_5' })
    await h.r.users.updateBilling(user.id, { stripeSubscriptionId: 'sub_5' })
    await expectAppError(h.s.billing.checkoutParams(user.id, { plan: 'pro' }), 'conflict', /billing portal/)
    expect(await h.s.billing.portalParams(user.id)).toEqual({ customer: 'cus_5', returnUrl: 'https://app.test/app/billing' })
    const summary = await h.s.billing.summary(user.id)
    expect(summary.monthlyPriceCents).toBe(1_500)
    expect(START).toBeInstanceOf(Date)
  })
})
