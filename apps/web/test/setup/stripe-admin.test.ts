// The real Stripe admin adapter (Stripe SDK) over a mocked HTTP layer: the requests /setup makes
// (paths, parameters, idempotency keys) and the mapping of Stripe errors to safe messages.

import { describe, expect, it, vi } from 'vitest'
import { HANDLED_STRIPE_EVENTS } from '@app/services'
import { createStripeAdminApi, stripeSafeError } from '@/lib/server/stripe-admin'
import { stripeModeOf } from '@/lib/server/settings'

const KEY = 'sk_test_adminkey_0123456789abcdef'

interface Seen {
  method: string
  url: URL
  body: URLSearchParams
  headers: Headers
}

function stripeFetch(route: (req: Seen) => { status?: number; body: unknown }) {
  const seen: Seen[] = []
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const req = { method: init.method ?? 'GET', url, body: new URLSearchParams(typeof init.body === 'string' ? init.body : ''), headers: new Headers(init.headers as HeadersInit) }
    seen.push(req)
    const out = route(req)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } })
  })
  return { fetch: fn as unknown as typeof fetch, seen }
}

const product = { id: 'prod_1', object: 'product', name: 'Starter', active: true, metadata: { app_key: 'starter', managed_by: 'setup' } }
const price = (lookup: string, amount: number) => ({
  id: `price_${lookup}`,
  object: 'price',
  active: true,
  currency: 'usd',
  lookup_key: lookup,
  unit_amount: amount,
  recurring: { interval: 'month', interval_count: 1 },
  product,
})
const portal = {
  id: 'bpc_1',
  object: 'billing_portal.configuration',
  active: true,
  is_default: false,
  metadata: { managed_by: 'setup' },
  features: {
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    subscription_update: { enabled: true },
  },
}

describe('createStripeAdminApi', () => {
  it('knows its mode from the key', () => {
    expect(createStripeAdminApi(KEY).mode).toBe('test')
    expect(createStripeAdminApi('sk_live_x0123456789').mode).toBe('live')
    expect(stripeModeOf('rk_live_abc')).toBe('live')
    expect(stripeModeOf(undefined)).toBeNull()
  })

  it('reads the account and prices by lookup key', async () => {
    const m = stripeFetch((req) => {
      if (req.url.pathname === '/v1/account') return { body: { id: 'acct_1', object: 'account', business_profile: { name: 'Acme' }, country: 'US', charges_enabled: true, details_submitted: true } }
      if (req.url.pathname === '/v1/prices') return { body: { object: 'list', data: [price('starter', 800)], has_more: false } }
      return { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing' } } }
    })
    const api = createStripeAdminApi(KEY, { fetch: m.fetch })
    expect(await api.account()).toEqual({ id: 'acct_1', businessName: 'Acme', country: 'US', chargesEnabled: true, detailsSubmitted: true })
    expect(await api.pricesByLookupKeys(['starter', 'plus'])).toEqual([
      { id: 'price_starter', lookupKey: 'starter', active: true, unitAmount: 800, currency: 'usd', interval: 'month', intervalCount: 1, productId: 'prod_1', productName: 'Starter' },
    ])
    const q = m.seen[1]?.url.searchParams
    expect(q?.getAll('lookup_keys[]').length ? q.getAll('lookup_keys[]') : [q?.get('lookup_keys[0]'), q?.get('lookup_keys[1]')]).toEqual(['starter', 'plus'])
    expect(q?.get('active')).toBe('true')
    expect(m.seen.every((r) => r.headers.get('authorization') === `Bearer ${KEY}`)).toBe(true)
    expect(await api.retrievePrice('price_missing')).toBeNull()
  })

  it('creates products and monthly USD prices with lookup keys and idempotency keys', async () => {
    const m = stripeFetch((req) => (req.url.pathname === '/v1/products' ? { body: product } : { body: price('starter', 800) }))
    const api = createStripeAdminApi(KEY, { fetch: m.fetch })
    await api.createProduct({ name: 'Starter', appKey: 'starter', idempotencyKey: 'setup-product-test-starter-1' })
    await api.createPrice({ productId: 'prod_1', unitAmount: 800, lookupKey: 'starter', nickname: 'Starter monthly', idempotencyKey: 'setup-price-1' })
    const [p, pr] = m.seen
    expect(p?.headers.get('idempotency-key')).toBe('setup-product-test-starter-1')
    expect(p?.body.get('metadata[app_key]')).toBe('starter')
    expect(Object.fromEntries(pr?.body ?? [])).toMatchObject({
      product: 'prod_1',
      unit_amount: '800',
      currency: 'usd',
      'recurring[interval]': 'month',
      lookup_key: 'starter',
      transfer_lookup_key: 'true',
    })
  })

  it('creates the webhook endpoint with the handled events and the SDK’s API version, returning the secret once', async () => {
    const m = stripeFetch(() => ({ body: { id: 'we_1', object: 'webhook_endpoint', url: 'https://app.example.com/api/stripe/webhook', enabled_events: [...HANDLED_STRIPE_EVENTS], status: 'enabled', secret: 'whsec_created_once' } }))
    const api = createStripeAdminApi(KEY, { fetch: m.fetch })
    const out = await api.createWebhookEndpoint({ url: 'https://app.example.com/api/stripe/webhook', events: [...HANDLED_STRIPE_EVENTS], idempotencyKey: 'setup-webhook-test-1' })
    expect(out).toEqual({ endpoint: { id: 'we_1', url: 'https://app.example.com/api/stripe/webhook', enabledEvents: [...HANDLED_STRIPE_EVENTS], status: 'enabled' }, secret: 'whsec_created_once' })
    const body = m.seen[0]?.body
    expect(body?.get('url')).toBe('https://app.example.com/api/stripe/webhook')
    expect(body?.get('api_version')).toBe('2026-10-28.endive')
    expect([...(body?.keys() ?? [])].filter((k) => k.startsWith('enabled_events')).map((k) => body?.get(k))).toEqual([...HANDLED_STRIPE_EVENTS])
  })

  it('creates a portal configuration: cancel at period end, card updates, plan switching', async () => {
    const m = stripeFetch(() => ({ body: portal }))
    const api = createStripeAdminApi(KEY, { fetch: m.fetch })
    const out = await api.createPortalConfiguration({
      returnUrl: 'https://app.example.com/app/billing',
      privacyUrl: 'https://app.example.com/privacy',
      termsUrl: 'https://app.example.com/terms',
      planProducts: [
        { product: 'prod_s', prices: ['price_s'] },
        { product: 'prod_p', prices: ['price_p'] },
      ],
    })
    expect(out).toMatchObject({ id: 'bpc_1', managedBySetup: true, cancelMode: 'at_period_end', paymentMethodUpdate: true })
    const body = Object.fromEntries(m.seen[0]?.body ?? [])
    expect(body).toMatchObject({
      'features[subscription_cancel][enabled]': 'true',
      'features[subscription_cancel][mode]': 'at_period_end',
      'features[payment_method_update][enabled]': 'true',
      'features[subscription_update][enabled]': 'true',
      'features[subscription_update][products][0][product]': 'prod_s',
      'features[subscription_update][products][1][prices][0]': 'price_p',
      'business_profile[privacy_policy_url]': 'https://app.example.com/privacy',
      'metadata[managed_by]': 'setup',
    })
  })

  it('maps Stripe errors to short messages that never quote the key', async () => {
    const m = stripeFetch(() => ({ status: 401, body: { error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${KEY}` } } }))
    const api = createStripeAdminApi(KEY, { fetch: m.fetch })
    const err = (await api.account().then(
      () => new Error('expected a failure'),
      (e: unknown) => e as Error,
    )) as Error
    expect(err.message).toBe('Stripe refused STRIPE_SECRET_KEY. Copy the secret key again from Stripe → Developers → API keys.')
    expect(JSON.stringify({ message: err.message, details: (err as { details?: unknown }).details })).not.toContain(KEY)
    expect(stripeSafeError({ type: 'StripeInvalidRequestError', code: 'resource_missing' }).message).toBe('Stripe refused the request (resource_missing).')
    expect(stripeSafeError({ type: 'StripeInvalidRequestError', code: 'Bad Code With Spaces' }).message).toBe('Stripe refused the request.')
    expect(stripeSafeError(new Error('x')).message).toContain('unexpected')
  })
})
