// Stripe routes: Checkout (plan + add-ons → session; customer reuse), the customer portal and the
// webhook (raw-body signature, idempotent replay, unmatched → retry). Stripe's API is a fake;
// signatures are made and checked with the real Stripe library (offline).

import Stripe from 'stripe'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as checkout } from '@/app/api/stripe/checkout/route'
import { POST as portal } from '@/app/api/stripe/portal/route'
import { POST as webhook } from '@/app/api/stripe/webhook/route'
import type { CheckoutSessionInput, StripeApi } from '@/lib/server/stripe'
import { BASE, STRIPE_WEBHOOK_SECRET, createHarness, readJson, request, type Harness } from './harness'

let h: Harness
const subscriptions = new Map<string, unknown>()
const fake = {
  pricesByLookupKey: vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, `price_${k}_test`]))),
  createCheckoutSession: vi.fn(async (_input: CheckoutSessionInput) => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' })),
  createPortalSession: vi.fn(async (_input: { customer: string; returnUrl: string }) => ({ url: 'https://billing.stripe.com/p/session/test_123' })),
  retrieveSubscription: vi.fn(async (id: string) => {
    const sub = subscriptions.get(id)
    if (!sub) throw new Error('no such subscription')
    return sub
  }),
} satisfies StripeApi

beforeAll(async () => {
  h = await createHarness({ overrides: { stripe: fake } })
})
afterAll(async () => {
  await h.close()
})
beforeEach(() => {
  for (const fn of Object.values(fake)) fn.mockClear()
  h.install()
})

function signed(event: Record<string, unknown>, secret = STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event)
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret })
  return request('/api/stripe/webhook', { body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': header } })
}

function subscription(id: string, customer: string, userId: string, lookupKey = 'plus') {
  const now = Math.floor(Date.now() / 1000)
  return {
    id,
    object: 'subscription',
    customer,
    status: 'active',
    metadata: { userId },
    items: {
      data: [
        { price: { id: `price_${lookupKey}_test`, lookup_key: lookupKey }, quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400 },
        { price: { id: 'price_extra_brand_test', lookup_key: 'extra_brand' }, quantity: 2, current_period_start: now, current_period_end: now + 30 * 86400 },
      ],
    },
  }
}

describe('POST /api/stripe/checkout', () => {
  it('requires a signed-in, same-origin request', async () => {
    let res = await checkout(request('/api/stripe/checkout', { json: { plan: 'plus' } }))
    expect(res.status).toBe(401)
    const u = await h.createUser('cross@example.com')
    res = await checkout(request('/api/stripe/checkout', { json: { plan: 'plus' }, cookie: h.cookie(u.email), headers: { origin: 'https://evil.example' } }))
    expect(res.status).toBe(403)
  })

  it('creates a subscription Checkout session with resolved prices (JSON)', async () => {
    const u = await h.createUser('buyer@example.com', { plan: null, subscriptionStatus: 'none' })
    const res = await checkout(request('/api/stripe/checkout', { json: { plan: 'plus', extraBrands: 1, extraClipHours: 3 }, cookie: h.cookie(u.email), headers: { origin: BASE } }))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' })
    expect(fake.pricesByLookupKey).toHaveBeenCalledWith(['plus', 'extra_brand', 'extra_clip_hour'])
    const input = fake.createCheckoutSession.mock.calls[0]?.[0]
    expect(input).toMatchObject({
      mode: 'subscription',
      clientReferenceId: u.id,
      customer: null,
      customerEmail: u.email,
      metadata: { userId: u.id },
      subscriptionMetadata: { userId: u.id },
      lineItems: [
        { price: 'price_plus_test', quantity: 1 },
        { price: 'price_extra_brand_test', quantity: 1 },
        { price: 'price_extra_clip_hour_test', quantity: 3 },
      ],
    })
    expect(String(input?.successUrl)).toContain(`${BASE}/app/billing`)
  })

  it('reuses the Stripe customer and redirects form posts to Checkout', async () => {
    const u = await h.createUser('returning@example.com', { plan: null, subscriptionStatus: 'canceled', stripeCustomerId: 'cus_returning' })
    const res = await checkout(request('/api/stripe/checkout', { form: { plan: 'starter', extraBrands: '', extraClipHours: '0' }, cookie: h.cookie(u.email), headers: { origin: BASE } }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
    const input = fake.createCheckoutSession.mock.calls[0]?.[0]
    expect(input).toMatchObject({ customer: 'cus_returning', customerEmail: null, lineItems: [{ price: 'price_starter_test', quantity: 1 }] })
  })

  it('validates the plan and add-ons, and refuses a second subscription', async () => {
    const u = await h.createUser('validate@example.com', { plan: null, subscriptionStatus: 'none' })
    const send = (json: unknown) => checkout(request('/api/stripe/checkout', { json, cookie: h.cookie(u.email) }))
    expect((await send({ plan: 'enterprise' })).status).toBe(400)
    expect((await send({ plan: 'plus', extraBrands: -1 })).status).toBe(400)
    expect((await send({ plan: 'plus', extraBrands: 1.5 })).status).toBe(400)
    expect((await send({})).status).toBe(400)
    expect(fake.createCheckoutSession).not.toHaveBeenCalled()

    const subscribed = await h.createUser('subscribed@example.com', { stripeCustomerId: 'cus_sub' })
    await h.rt.db.query('update public.users set stripe_subscription_id = $2 where id = $1', [subscribed.id, 'sub_existing'])
    const res = await checkout(request('/api/stripe/checkout', { json: { plan: 'pro' }, cookie: h.cookie(subscribed.email) }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: { details?: { portal?: boolean } } }>(res)).error.details?.portal).toBe(true)
  })

  it('reports 503 when Stripe is not configured', async () => {
    h.install({ stripe: null })
    const u = await h.createUser('nostripe@example.com', { plan: null, subscriptionStatus: 'none' })
    const res = await checkout(request('/api/stripe/checkout', { json: { plan: 'plus' }, cookie: h.cookie(u.email) }))
    expect(res.status).toBe(503)
  })
})

describe('POST /api/stripe/portal', () => {
  it('opens the portal for a customer and refuses users without one', async () => {
    const none = await h.createUser('noportal@example.com')
    let res = await portal(request('/api/stripe/portal', { json: {}, cookie: h.cookie(none.email) }))
    expect(res.status).toBe(400)
    const u = await h.createUser('portal@example.com', { stripeCustomerId: 'cus_portal' })
    res = await portal(request('/api/stripe/portal', { form: {}, cookie: h.cookie(u.email), headers: { origin: BASE } }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://billing.stripe.com/p/session/test_123')
    expect(fake.createPortalSession).toHaveBeenCalledWith({ customer: 'cus_portal', returnUrl: `${BASE}/app/billing` })
    expect((await portal(request('/api/stripe/portal', { json: {} }))).status).toBe(401)
  })
})

describe('POST /api/stripe/webhook', () => {
  it('rejects missing and bad signatures', async () => {
    const event = { id: 'evt_sig', type: 'customer.created', data: { object: { id: 'cus_x' } } }
    let res = await webhook(request('/api/stripe/webhook', { json: event }))
    expect(res.status).toBe(400)
    res = await webhook(signed(event, 'whsec_wrong_secret'))
    expect(res.status).toBe(400)
    // a body changed after signing fails
    const good = signed(event)
    const tampered = new Request(good.url, { method: 'POST', headers: good.headers, body: JSON.stringify({ ...event, id: 'evt_other' }) })
    res = await webhook(tampered)
    expect(res.status).toBe(400)
  })

  it('applies checkout.session.completed with the latest subscription, and replays idempotently', async () => {
    const u = await h.createUser('webhook@example.com', { plan: null, subscriptionStatus: 'none' })
    subscriptions.set('sub_webhook', subscription('sub_webhook', 'cus_webhook', u.id, 'plus'))
    const event = {
      id: 'evt_checkout_1',
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'cs_1', object: 'checkout.session', mode: 'subscription', customer: 'cus_webhook', subscription: 'sub_webhook', client_reference_id: u.id, metadata: { userId: u.id } } },
    }
    let res = await webhook(signed(event))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ received: true, status: 'processed' })
    expect(fake.retrieveSubscription).toHaveBeenCalledWith('sub_webhook')
    const row = await h.rt.services.users.get(u.id)
    expect(row).toMatchObject({ plan: 'plus', subscriptionStatus: 'active', stripeCustomerId: 'cus_webhook', stripeSubscriptionId: 'sub_webhook', extraBrands: 2 })

    res = await webhook(signed(event))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ received: true, status: 'duplicate' })
  })

  it('answers non-2xx for events that match no user yet (Stripe retries), 200 for ignored types', async () => {
    const orphan = subscription('sub_orphan', 'cus_orphan', '00000000-0000-4000-8000-000000000000')
    subscriptions.set('sub_orphan', orphan)
    let res = await webhook(signed({ id: 'evt_orphan', type: 'customer.subscription.updated', data: { object: orphan } }))
    expect(res.status).toBe(409)
    expect(await readJson(res)).toMatchObject({ received: false, status: 'unmatched' })
    res = await webhook(signed({ id: 'evt_ignored', type: 'customer.created', data: { object: { id: 'cus_new' } } }))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ status: 'ignored' })
  })

  it('is 503 without a webhook secret and refuses oversized bodies', async () => {
    h.install({ runtime: { ...h.rt, config: { ...h.rt.config, STRIPE_WEBHOOK_SECRET: undefined } } })
    let res = await webhook(signed({ id: 'evt_nosecret', type: 'customer.created', data: { object: {} } }))
    expect(res.status).toBe(503)
    h.install()
    res = await webhook(request('/api/stripe/webhook', { body: 'x'.repeat(600 * 1024), headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' } }))
    expect(res.status).toBe(413)
  })
})
