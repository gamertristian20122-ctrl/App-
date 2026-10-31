// Stripe account setup for the owner's /setup page, behind a narrow interface so tests inject a
// fake (setServerOverridesForTests({ stripeAdmin })). Reads the account, prices, webhook endpoints
// and portal configurations, and creates the missing ones. Stripe's own error messages are never
// passed on (they can quote part of a key): errors become short AppErrors of our own. Server-only.

import Stripe from 'stripe'
import type { Config } from '@app/core/config'
import { AppError } from '@app/core/errors'
import { serverOverrides } from './deps'
import { stripeModeOf, type StripeMode } from './settings'

export interface StripeAccountInfo {
  id: string
  businessName: string | null
  country: string | null
  /** Live payments possible (account activated). */
  chargesEnabled: boolean
  detailsSubmitted: boolean
}

export interface StripePriceInfo {
  id: string
  lookupKey: string | null
  active: boolean
  /** Cents. */
  unitAmount: number | null
  currency: string
  /** 'month' for our prices; null for one-time prices. */
  interval: string | null
  intervalCount: number | null
  productId: string
  productName: string | null
}

export interface StripeProductInfo {
  id: string
  name: string
  active: boolean
  /** metadata.app_key: which of our plans / add-ons this product is (set by /setup). */
  appKey: string | null
}

export interface WebhookEndpointInfo {
  id: string
  url: string
  enabledEvents: string[]
  /** 'enabled' | 'disabled' */
  status: string
}

export interface PortalConfigurationInfo {
  id: string
  active: boolean
  isDefault: boolean
  /** Created by /setup (metadata.managed_by = "setup"). */
  managedBySetup: boolean
  cancelEnabled: boolean
  cancelMode: string | null
  paymentMethodUpdate: boolean
  invoiceHistory: boolean
  subscriptionUpdate: boolean
}

export interface PortalConfigurationInput {
  returnUrl: string
  privacyUrl: string
  termsUrl: string
  /** Plans customers may switch between in the portal (none = plan switching off). */
  planProducts: Array<{ product: string; prices: string[] }>
}

export interface StripeAdminApi {
  readonly mode: StripeMode
  account(): Promise<StripeAccountInfo>
  /** Active prices for these lookup keys. */
  pricesByLookupKeys(lookupKeys: string[]): Promise<StripePriceInfo[]>
  /** A price by id (null when it does not exist). */
  retrievePrice(id: string): Promise<StripePriceInfo | null>
  /** Active products. */
  listProducts(): Promise<StripeProductInfo[]>
  createProduct(input: { name: string; appKey: string; idempotencyKey: string }): Promise<StripeProductInfo>
  /** A monthly USD price; takes the lookup key over from any older price that has it. */
  createPrice(input: { productId: string; unitAmount: number; lookupKey: string; nickname: string; idempotencyKey: string }): Promise<StripePriceInfo>
  listWebhookEndpoints(): Promise<WebhookEndpointInfo[]>
  /** Creates an endpoint; Stripe returns its signing secret only here. */
  createWebhookEndpoint(input: { url: string; events: string[]; idempotencyKey: string }): Promise<{ endpoint: WebhookEndpointInfo; secret: string }>
  updateWebhookEndpoint(id: string, input: { events: string[] }): Promise<WebhookEndpointInfo>
  deleteWebhookEndpoint(id: string): Promise<void>
  listPortalConfigurations(): Promise<PortalConfigurationInfo[]>
  createPortalConfiguration(input: PortalConfigurationInput): Promise<PortalConfigurationInfo>
  updatePortalConfiguration(id: string, input: PortalConfigurationInput): Promise<PortalConfigurationInfo>
}

/** Marks what /setup created, so it finds (and only updates) its own objects later. */
export const SETUP_METADATA = { managed_by: 'setup' } as const

/** Maps any Stripe SDK error to a short, safe AppError (never Stripe's own message). */
export function stripeSafeError(error: unknown): AppError {
  const e = (error ?? {}) as { type?: unknown; code?: unknown; statusCode?: unknown }
  const type = typeof e.type === 'string' ? e.type : ''
  const code = typeof e.code === 'string' && /^[a-z0-9_]{1,60}$/.test(e.code) ? e.code : null
  switch (type) {
    case 'StripeAuthenticationError':
      return new AppError('unavailable', 'Stripe refused STRIPE_SECRET_KEY. Copy the secret key again from Stripe → Developers → API keys.', { reason: 'stripe_auth' })
    case 'StripePermissionError':
      return new AppError('unavailable', 'This Stripe key is not allowed to do that. Use the standard secret key (sk_…), not a restricted key.', { reason: 'stripe_permission' })
    case 'StripeRateLimitError':
      return new AppError('rate_limited', 'Stripe is busy right now. Try again in a minute.', { reason: 'stripe_rate_limited' })
    case 'StripeConnectionError':
    case 'StripeAPIError':
      return new AppError('unavailable', 'Stripe could not be reached. Try again in a minute.', { reason: 'stripe_unavailable' })
    case 'StripeInvalidRequestError':
      return new AppError('bad_request', `Stripe refused the request${code ? ` (${code})` : ''}.`, { reason: 'stripe_invalid', ...(code ? { stripeCode: code } : {}) })
    default:
      return new AppError('unavailable', 'Stripe answered in an unexpected way. Try again in a minute.', { reason: 'stripe_unknown' })
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw stripeSafeError(error)
  }
}

function priceInfo(p: Stripe.Price): StripePriceInfo {
  const product = typeof p.product === 'string' ? null : p.product
  return {
    id: p.id,
    lookupKey: p.lookup_key ?? null,
    active: p.active,
    unitAmount: p.unit_amount ?? null,
    currency: p.currency,
    interval: p.recurring?.interval ?? null,
    intervalCount: p.recurring?.interval_count ?? null,
    productId: typeof p.product === 'string' ? p.product : p.product.id,
    productName: product && !('deleted' in product && product.deleted) ? ((product as Stripe.Product).name ?? null) : null,
  }
}

function productInfo(p: Stripe.Product): StripeProductInfo {
  const key = p.metadata?.app_key
  return { id: p.id, name: p.name, active: p.active, appKey: typeof key === 'string' && key ? key : null }
}

function endpointInfo(w: Stripe.WebhookEndpoint): WebhookEndpointInfo {
  return { id: w.id, url: w.url, enabledEvents: [...w.enabled_events], status: w.status }
}

function portalInfo(c: Stripe.BillingPortal.Configuration): PortalConfigurationInfo {
  return {
    id: c.id,
    active: c.active,
    isDefault: c.is_default,
    managedBySetup: c.metadata?.managed_by === SETUP_METADATA.managed_by,
    cancelEnabled: c.features.subscription_cancel.enabled,
    cancelMode: c.features.subscription_cancel.mode ?? null,
    paymentMethodUpdate: c.features.payment_method_update.enabled,
    invoiceHistory: c.features.invoice_history.enabled,
    subscriptionUpdate: c.features.subscription_update.enabled,
  }
}

function portalParams(input: PortalConfigurationInput) {
  const switching = input.planProducts.length >= 2
  return {
    business_profile: { privacy_policy_url: input.privacyUrl, terms_of_service_url: input.termsUrl },
    default_return_url: input.returnUrl,
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name'] as Array<'email' | 'address' | 'name'> },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' as const },
      // Stripe's portal cannot change a subscription with more than one item (a plan plus add-ons);
      // those customers can still cancel and update their card.
      subscription_update: switching
        ? {
            enabled: true,
            default_allowed_updates: ['price'] as Array<'price'>,
            proration_behavior: 'always_invoice' as const,
            products: input.planProducts.map((p) => ({ product: p.product, prices: p.prices })),
          }
        : { enabled: false },
    },
    metadata: { ...SETUP_METADATA },
  }
}

/**
 * The real client (Stripe SDK). The key stays inside the SDK; nothing logs it. `fetch` replaces the
 * HTTP layer (tests: a mock that answers like Stripe).
 */
export function createStripeAdminApi(secretKey: string, options: { fetch?: typeof fetch } = {}): StripeAdminApi {
  const client = new Stripe(secretKey, {
    maxNetworkRetries: options.fetch ? 0 : 1,
    timeout: 10_000,
    ...(options.fetch ? { httpClient: Stripe.createFetchHttpClient(options.fetch) } : {}),
  })
  const mode = stripeModeOf(secretKey) ?? 'test'
  return {
    mode,
    account: () =>
      guard(async () => {
        const a = await client.accounts.retrieveCurrent()
        return {
          id: a.id,
          businessName: a.business_profile?.name ?? a.settings?.dashboard?.display_name ?? null,
          country: a.country ?? null,
          chargesEnabled: Boolean(a.charges_enabled),
          detailsSubmitted: Boolean(a.details_submitted),
        }
      }),
    pricesByLookupKeys: (lookupKeys) =>
      guard(async () => {
        if (lookupKeys.length === 0) return []
        const list = await client.prices.list({ lookup_keys: lookupKeys, active: true, limit: 100, expand: ['data.product'] })
        return list.data.map(priceInfo)
      }),
    retrievePrice: (id) =>
      guard(async () => {
        try {
          return priceInfo(await client.prices.retrieve(id, { expand: ['product'] }))
        } catch (error) {
          if ((error as { code?: unknown }).code === 'resource_missing') return null
          throw error
        }
      }),
    listProducts: () =>
      guard(async () => {
        const list = await client.products.list({ active: true, limit: 100 })
        return list.data.map(productInfo)
      }),
    createProduct: (input) =>
      guard(async () =>
        productInfo(
          await client.products.create(
            { name: input.name, metadata: { ...SETUP_METADATA, app_key: input.appKey } },
            { idempotencyKey: input.idempotencyKey },
          ),
        ),
      ),
    createPrice: (input) =>
      guard(async () =>
        priceInfo(
          await client.prices.create(
            {
              product: input.productId,
              unit_amount: input.unitAmount,
              currency: 'usd',
              recurring: { interval: 'month' },
              lookup_key: input.lookupKey,
              transfer_lookup_key: true,
              nickname: input.nickname,
              metadata: { ...SETUP_METADATA },
            },
            { idempotencyKey: input.idempotencyKey },
          ),
        ),
      ),
    listWebhookEndpoints: () =>
      guard(async () => {
        const list = await client.webhookEndpoints.list({ limit: 100 })
        return list.data.map(endpointInfo)
      }),
    createWebhookEndpoint: (input) =>
      guard(async () => {
        const w = await client.webhookEndpoints.create(
          {
            url: input.url,
            enabled_events: input.events as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
            api_version: Stripe.API_VERSION,
            description: 'Billing events for the app (created on /setup)',
            metadata: { ...SETUP_METADATA },
          },
          { idempotencyKey: input.idempotencyKey },
        )
        if (!w.secret) throw new AppError('unavailable', 'Stripe did not return the signing secret. Try again.')
        return { endpoint: endpointInfo(w), secret: w.secret }
      }),
    updateWebhookEndpoint: (id, input) =>
      guard(async () =>
        endpointInfo(
          await client.webhookEndpoints.update(id, {
            enabled_events: input.events as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
            disabled: false,
          }),
        ),
      ),
    deleteWebhookEndpoint: (id) =>
      guard(async () => {
        await client.webhookEndpoints.del(id)
      }),
    listPortalConfigurations: () =>
      guard(async () => {
        const list = await client.billingPortal.configurations.list({ active: true, limit: 100 })
        return list.data.map(portalInfo)
      }),
    createPortalConfiguration: (input) => guard(async () => portalInfo(await client.billingPortal.configurations.create(portalParams(input)))),
    updatePortalConfiguration: (id, input) =>
      guard(async () => portalInfo(await client.billingPortal.configurations.update(id, { ...portalParams(input), active: true }))),
  }
}

const KEY = Symbol.for('app.web.stripeAdmin')

/** The Stripe admin API for this process, or null when STRIPE_SECRET_KEY is not set. */
export function getStripeAdmin(config: Pick<Config, 'STRIPE_SECRET_KEY'>): StripeAdminApi | null {
  const o = serverOverrides()
  if (o.stripeAdmin !== undefined) return o.stripeAdmin
  if (!config.STRIPE_SECRET_KEY) return null
  const g = globalThis as typeof globalThis & { [KEY]?: { key: string; api: StripeAdminApi } }
  if (g[KEY]?.key !== config.STRIPE_SECRET_KEY) g[KEY] = { key: config.STRIPE_SECRET_KEY, api: createStripeAdminApi(config.STRIPE_SECRET_KEY) }
  return g[KEY].api
}
