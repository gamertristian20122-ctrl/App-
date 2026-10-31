// An in-memory Stripe for the /setup tests: products, prices with lookup keys (transfer on
// create), webhook endpoints with a secret only on create, and portal configurations. Every
// method is a vi.fn so tests can count calls. No network.

import { vi } from 'vitest'
import type {
  PortalConfigurationInfo,
  PortalConfigurationInput,
  StripeAdminApi,
  StripePriceInfo,
  StripeProductInfo,
  WebhookEndpointInfo,
} from '@/lib/server/stripe-admin'

export interface FakeStripeState {
  products: StripeProductInfo[]
  prices: StripePriceInfo[]
  endpoints: Array<WebhookEndpointInfo & { secret: string }>
  portals: Array<PortalConfigurationInfo & { input?: PortalConfigurationInput }>
  account: { id: string; businessName: string | null; country: string | null; chargesEnabled: boolean; detailsSubmitted: boolean }
}

export function createFakeStripe(mode: 'test' | 'live' = 'test') {
  let seq = 0
  const id = (prefix: string) => `${prefix}_${++seq}`
  const state: FakeStripeState = {
    products: [],
    prices: [],
    endpoints: [],
    portals: [],
    account: { id: 'acct_123', businessName: 'Acme Studio', country: 'US', chargesEnabled: true, detailsSubmitted: true },
  }
  const portalFrom = (cid: string, input: PortalConfigurationInput, isDefault = false): PortalConfigurationInfo & { input: PortalConfigurationInput } => ({
    id: cid,
    active: true,
    isDefault,
    managedBySetup: true,
    cancelEnabled: true,
    cancelMode: 'at_period_end',
    paymentMethodUpdate: true,
    invoiceHistory: true,
    subscriptionUpdate: input.planProducts.length >= 2,
    input,
  })
  const api = {
    mode,
    account: vi.fn(async () => ({ ...state.account })),
    pricesByLookupKeys: vi.fn(async (keys: string[]) => state.prices.filter((p) => p.active && p.lookupKey && keys.includes(p.lookupKey)).map((p) => ({ ...p }))),
    retrievePrice: vi.fn(async (pid: string) => state.prices.find((p) => p.id === pid) ?? null),
    listProducts: vi.fn(async () => state.products.filter((p) => p.active).map((p) => ({ ...p }))),
    createProduct: vi.fn(async (input: { name: string; appKey: string; idempotencyKey: string }) => {
      const product = { id: id('prod'), name: input.name, active: true, appKey: input.appKey }
      state.products.push(product)
      return { ...product }
    }),
    createPrice: vi.fn(async (input: { productId: string; unitAmount: number; lookupKey: string; nickname: string; idempotencyKey: string }) => {
      for (const p of state.prices) if (p.lookupKey === input.lookupKey) p.lookupKey = null // transfer_lookup_key
      const product = state.products.find((p) => p.id === input.productId)
      const price: StripePriceInfo = {
        id: id('price'),
        lookupKey: input.lookupKey,
        active: true,
        unitAmount: input.unitAmount,
        currency: 'usd',
        interval: 'month',
        intervalCount: 1,
        productId: input.productId,
        productName: product?.name ?? null,
      }
      state.prices.push(price)
      return { ...price }
    }),
    listWebhookEndpoints: vi.fn(async () => state.endpoints.map(({ secret: _secret, ...e }) => ({ ...e, enabledEvents: [...e.enabledEvents] }))),
    createWebhookEndpoint: vi.fn(async (input: { url: string; events: string[]; idempotencyKey: string }) => {
      const endpoint = { id: id('we'), url: input.url, enabledEvents: [...input.events], status: 'enabled', secret: `whsec_fake_${seq}_0123456789abcdef` }
      state.endpoints.push(endpoint)
      const { secret, ...info } = endpoint
      return { endpoint: info, secret }
    }),
    updateWebhookEndpoint: vi.fn(async (wid: string, input: { events: string[] }) => {
      const e = state.endpoints.find((x) => x.id === wid)
      if (!e) throw new Error('no such endpoint')
      e.enabledEvents = [...input.events]
      e.status = 'enabled'
      const { secret: _secret, ...info } = e
      return info
    }),
    deleteWebhookEndpoint: vi.fn(async (wid: string) => {
      state.endpoints = state.endpoints.filter((e) => e.id !== wid)
    }),
    listPortalConfigurations: vi.fn(async () => state.portals.filter((p) => p.active).map(({ input: _input, ...p }) => ({ ...p }))),
    createPortalConfiguration: vi.fn(async (input: PortalConfigurationInput) => {
      const c = portalFrom(id('bpc'), input)
      state.portals.push(c)
      const { input: _input, ...info } = c
      return info
    }),
    updatePortalConfiguration: vi.fn(async (cid: string, input: PortalConfigurationInput) => {
      const index = state.portals.findIndex((p) => p.id === cid)
      if (index < 0) throw new Error('no such configuration')
      const c = portalFrom(cid, input, state.portals[index]?.isDefault)
      state.portals[index] = c
      const { input: _input, ...info } = c
      return info
    }),
  } satisfies StripeAdminApi
  return { api, state }
}

/** A price as Stripe would hold it (for seeding). */
export function seedPrice(state: FakeStripeState, lookupKey: string, unitAmount: number, extra: Partial<StripePriceInfo> = {}): StripePriceInfo {
  const productId = `prod_seed_${lookupKey}`
  if (!state.products.some((p) => p.id === productId)) state.products.push({ id: productId, name: lookupKey, active: true, appKey: null })
  const price: StripePriceInfo = {
    id: `price_seed_${lookupKey}_${unitAmount}`,
    lookupKey,
    active: true,
    unitAmount,
    currency: 'usd',
    interval: 'month',
    intervalCount: 1,
    productId,
    productName: lookupKey,
    ...extra,
  }
  state.prices.push(price)
  return price
}
