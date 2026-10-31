// Stripe behind a narrow interface: the routes call these four API operations, and tests inject
// a fake (setServerOverridesForTests({ stripe })). Webhook signatures are verified with the
// Stripe library's own (offline) verifier against the raw body. Server-only.

import Stripe from 'stripe'
import type { Config } from '@app/core/config'
import { serverOverrides } from './deps'

export interface CheckoutSessionInput {
  mode: 'subscription'
  lineItems: Array<{ price: string; quantity: number }>
  clientReferenceId: string
  customer: string | null
  customerEmail: string | null
  metadata: Record<string, string>
  subscriptionMetadata: Record<string, string>
  successUrl: string
  cancelUrl: string
  allowPromotionCodes: boolean
}

export interface StripeApi {
  /** Price ids for lookup keys (active prices only); missing keys are absent from the map. */
  pricesByLookupKey(lookupKeys: string[]): Promise<Map<string, string>>
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string | null }>
  createPortalSession(input: { customer: string; returnUrl: string }): Promise<{ url: string }>
  /** The latest subscription object (order-independent webhook processing). */
  retrieveSubscription(id: string): Promise<unknown>
}

/** The real client (Stripe SDK). The secret key stays inside the SDK; nothing logs it. */
export function createStripeApi(secretKey: string): StripeApi {
  const client = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15_000 })
  return {
    async pricesByLookupKey(lookupKeys) {
      const list = await client.prices.list({ lookup_keys: lookupKeys, active: true, limit: 100 })
      const map = new Map<string, string>()
      for (const p of list.data) if (p.lookup_key) map.set(p.lookup_key, p.id)
      return map
    },
    async createCheckoutSession(input) {
      const session = await client.checkout.sessions.create({
        mode: input.mode,
        line_items: input.lineItems.map((i) => ({ price: i.price, quantity: i.quantity })),
        client_reference_id: input.clientReferenceId,
        ...(input.customer ? { customer: input.customer } : input.customerEmail ? { customer_email: input.customerEmail } : {}),
        metadata: input.metadata,
        subscription_data: { metadata: input.subscriptionMetadata },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: input.allowPromotionCodes,
      })
      return { id: session.id, url: session.url }
    },
    async createPortalSession(input) {
      const session = await client.billingPortal.sessions.create({ customer: input.customer, return_url: input.returnUrl })
      return { url: session.url }
    },
    async retrieveSubscription(id) {
      return client.subscriptions.retrieve(id)
    },
  }
}

const KEY = Symbol.for('app.web.stripe')

/** The Stripe API for this process, or null when STRIPE_SECRET_KEY is not set. */
export function getStripe(config: Pick<Config, 'STRIPE_SECRET_KEY'>): StripeApi | null {
  const o = serverOverrides()
  if (o.stripe !== undefined) return o.stripe
  if (!config.STRIPE_SECRET_KEY) return null
  const g = globalThis as typeof globalThis & { [KEY]?: { key: string; api: StripeApi } }
  if (g[KEY]?.key !== config.STRIPE_SECRET_KEY) g[KEY] = { key: config.STRIPE_SECRET_KEY, api: createStripeApi(config.STRIPE_SECRET_KEY) }
  return g[KEY].api
}

/**
 * Verifies a webhook delivery (Stripe-Signature over the raw body, 5-minute tolerance) and
 * returns the parsed event. Throws on a missing or bad signature.
 */
export function verifyStripeWebhook(rawBody: string, signature: string, secret: string): unknown {
  return Stripe.webhooks.constructEvent(rawBody, signature, secret)
}
