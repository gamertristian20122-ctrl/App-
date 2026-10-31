// Billing: Stripe webhook events → users plan / status / period / add-on quantities (idempotent via
// stripe_events), downgrade effects on brands, and the parameters the web app passes to Stripe
// Checkout and the customer portal. No Stripe SDK here: the web route verifies the signature and
// may hand in a fetcher for the latest subscription (order-independent processing).

import { z } from 'zod'
import { addOnFromLookupKey, ADD_ONS, monthlyPriceCents, planFromLookupKey, type AddOnKey } from '@app/core/plans'
import { IdSchema } from '@app/core/validation'
import { PLAN_TIERS, PlanTierSchema, type PlanTier, type SubscriptionStatus } from '@app/core/types'
import type { BoundRepos, UserRow } from '@app/db'
import { auditIn } from './audit'
import { reconcileBrandLimitIn, type BrandLimitChange } from './brands'
import type { PriceKey } from './config'
import { conflict, fromZod, requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { userEntitlements, type UserEntitlements } from './entitlements'
import { requeueHeldPostsIn } from './posts'

// ---------------------------------------------------------------------------------------------
// Stripe payload shapes (only the fields we read; everything else passes through)
// ---------------------------------------------------------------------------------------------

const IdRef = z.union([z.string().min(1).max(255), z.looseObject({ id: z.string().min(1).max(255) })]).transform((v) => (typeof v === 'string' ? v : v.id))
const Metadata = z.record(z.string(), z.string()).nullish()

const PriceSchema = z.looseObject({ id: z.string().min(1).max(255), lookup_key: z.string().max(200).nullish() })
const ItemSchema = z.looseObject({
  price: PriceSchema,
  quantity: z.number().int().min(0).nullish(),
  current_period_start: z.number().int().nullish(),
  current_period_end: z.number().int().nullish(),
})
export const StripeSubscriptionSchema = z.looseObject({
  id: z.string().min(1).max(255),
  customer: IdRef,
  status: z.string().max(40),
  items: z.looseObject({ data: z.array(ItemSchema).max(100) }),
  current_period_start: z.number().int().nullish(),
  current_period_end: z.number().int().nullish(),
  trial_end: z.number().int().nullish(),
  metadata: Metadata,
})
export type StripeSubscription = z.output<typeof StripeSubscriptionSchema>

const CheckoutSessionSchema = z.looseObject({
  id: z.string().min(1).max(255),
  mode: z.string().max(40).nullish(),
  customer: IdRef.nullish(),
  subscription: z.union([z.string().min(1).max(255), StripeSubscriptionSchema]).nullish(),
  client_reference_id: z.string().max(255).nullish(),
  metadata: Metadata,
})

const InvoiceSchema = z.looseObject({
  id: z.string().min(1).max(255),
  customer: IdRef.nullish(),
  subscription: IdRef.nullish(),
  parent: z
    .looseObject({ subscription_details: z.looseObject({ subscription: IdRef.nullish() }).nullish() })
    .nullish(),
})

export const StripeEventSchema = z.looseObject({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  created: z.number().int().optional(),
  data: z.looseObject({ object: z.record(z.string(), z.unknown()) }),
})
export type StripeEventInput = z.input<typeof StripeEventSchema>

export const STRIPE_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'unpaid',
  incomplete: 'none',
  incomplete_expired: 'canceled',
  paused: 'unpaid',
}

export const HANDLED_STRIPE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
] as const

export interface StripeEventResult {
  status: 'processed' | 'ignored' | 'duplicate' | 'unmatched'
  eventId: string
  type: string
  userId?: string
  billing?: { plan: PlanTier | null; status: SubscriptionStatus; extraBrands: number; extraClipHours: number }
  brands?: BrandLimitChange
}

export interface ApplyStripeEventOptions {
  /**
   * Fetches the latest subscription from Stripe (e.g. `(id) => stripe.subscriptions.retrieve(id)`).
   * When given, subscription state is taken from it instead of the (possibly stale) event payload.
   */
  fetchSubscription?: (subscriptionId: string) => Promise<unknown>
}

export interface CheckoutLineItem {
  lookupKey: PriceKey
  /** Stripe price id when configured; otherwise resolve `lookupKey` with prices.list({ lookup_keys }). */
  price: string | null
  quantity: number
}

export interface CheckoutParams {
  mode: 'subscription'
  lineItems: CheckoutLineItem[]
  clientReferenceId: string
  customer: string | null
  customerEmail: string | null
  metadata: { userId: string }
  subscriptionData: { metadata: { userId: string } }
  successUrl: string
  cancelUrl: string
  allowPromotionCodes: boolean
  /** What the user will pay per month (cents), for display. */
  monthlyPriceCents: number
}

const CheckoutInputSchema = z.strictObject({
  plan: PlanTierSchema,
  extraBrands: z.number().int().min(0).max(ADD_ONS.extra_brand.maxQuantity).default(0),
  extraClipHours: z.number().int().min(0).max(ADD_ONS.extra_clip_hour.maxQuantity).default(0),
})

function toDate(sec: number | null | undefined): Date | null {
  return typeof sec === 'number' && sec > 0 ? new Date(sec * 1000) : null
}

export function createBillingService(ctx: Ctx) {
  const priceToKey = new Map<string, PriceKey>()
  for (const [key, price] of Object.entries(ctx.config.stripePrices)) if (price) priceToKey.set(price, key as PriceKey)

  function keyForPrice(price: { id: string; lookup_key?: string | null | undefined }): PriceKey | null {
    const plan = planFromLookupKey(price.lookup_key)
    if (plan) return plan
    const addOn = addOnFromLookupKey(price.lookup_key)
    if (addOn) return addOn
    return priceToKey.get(price.id) ?? null
  }

  function billingFrom(sub: StripeSubscription) {
    let plan: PlanTier | null = null
    let extraBrands = 0
    let extraClipHours = 0
    let periodItem: (typeof sub.items.data)[number] | undefined
    for (const item of sub.items.data) {
      const key = keyForPrice(item.price)
      if (!key) {
        ctx.log.warn('stripe price not recognised', { priceId: item.price.id })
        continue
      }
      if ((PLAN_TIERS as readonly string[]).includes(key)) {
        plan = key as PlanTier
        periodItem = item
      } else if ((key as AddOnKey) === 'extra_brand') {
        extraBrands = Math.min(ADD_ONS.extra_brand.maxQuantity, item.quantity ?? 0)
      } else if ((key as AddOnKey) === 'extra_clip_hour') {
        extraClipHours = Math.min(ADD_ONS.extra_clip_hour.maxQuantity, item.quantity ?? 0)
      }
    }
    periodItem ??= sub.items.data[0]
    // Since API 2025-03-31.basil the period lives on subscription items.
    const start = toDate(periodItem?.current_period_start ?? sub.current_period_start)
    const end = toDate(periodItem?.current_period_end ?? sub.current_period_end)
    return {
      plan,
      status: STRIPE_STATUS_MAP[sub.status] ?? 'none',
      extraBrands,
      extraClipHours,
      currentPeriodStart: start && end && end > start ? start : null,
      currentPeriodEnd: start && end && end > start ? end : null,
      trialEndsAt: toDate(sub.trial_end),
    }
  }

  async function findUserIn(r: BoundRepos, refs: { subscriptionId?: string | null; customerId?: string | null; userId?: string | null }): Promise<UserRow | null> {
    if (refs.subscriptionId) {
      const u = await r.users.findByStripeSubscriptionId(refs.subscriptionId)
      if (u) return u
    }
    if (refs.customerId) {
      const u = await r.users.findByStripeCustomerId(refs.customerId)
      if (u) return u
    }
    const parsed = IdSchema.safeParse(refs.userId ?? '')
    if (parsed.success) return r.users.get(parsed.data)
    return null
  }

  async function applySubscriptionIn(r: BoundRepos, user: UserRow, sub: StripeSubscription, deleted: boolean, eventId: string) {
    const b = billingFrom(sub)
    const status: SubscriptionStatus = deleted ? 'canceled' : b.status
    const isCurrent = !user.stripeSubscriptionId || user.stripeSubscriptionId === sub.id
    // An old subscription's events must not override a newer one.
    if (!isCurrent && (deleted || status === 'canceled' || status === 'none')) return null
    const previous = { plan: user.plan, status: user.subscriptionStatus }
    const updated =
      (await r.users.updateBilling(user.id, {
        ...(b.plan || !deleted ? { plan: b.plan ?? user.plan } : {}),
        subscriptionStatus: status,
        extraBrands: b.extraBrands,
        extraClipHours: b.extraClipHours,
        currentPeriodStart: b.currentPeriodStart,
        currentPeriodEnd: b.currentPeriodEnd,
        ...(b.trialEndsAt ? { trialEndsAt: b.trialEndsAt } : {}),
        stripeCustomerId: sub.customer,
        stripeSubscriptionId: sub.id,
      })) ?? user
    const brands = await reconcileBrandLimitIn(ctx, r, user.id, 'system')
    // Back from a hold (trial over, canceled, unpaid): publish the posts that were held, now.
    if (!userEntitlements(user, ctx.now()).canPublish && userEntitlements(updated, ctx.now()).canPublish) {
      await requeueHeldPostsIn(r, user.id, ctx.now())
    }
    await auditIn(r, user.id, {
      actor: 'system',
      action: 'billing.subscription_synced',
      subjectType: 'user',
      subjectId: user.id,
      meta: {
        eventId,
        plan: updated.plan,
        status: updated.subscriptionStatus,
        previousPlan: previous.plan,
        previousStatus: previous.status,
        extraBrands: updated.extraBrands,
        extraClipHours: updated.extraClipHours,
        suspendedBrands: brands.suspended.length,
        restoredBrands: brands.restored.length,
      },
    })
    return { updated, brands }
  }

  /**
   * The subscription as Stripe has it now (events arrive out of order and are retried for days,
   * so the event payload may be stale). When the fetch fails the event is NOT applied from its
   * payload: the error makes the webhook answer non-2xx and Stripe retries. Without a fetcher
   * (no Stripe key: local dev, tests) the payload is used.
   */
  async function latestSubscription(id: string, fallback: unknown, options: ApplyStripeEventOptions): Promise<StripeSubscription> {
    let raw = fallback
    if (options.fetchSubscription) {
      try {
        raw = await options.fetchSubscription(id)
      } catch (error) {
        ctx.log.warn('stripe subscription fetch failed; the event will be retried', { subscriptionId: id })
        throw error
      }
    }
    return fromZod(StripeSubscriptionSchema, raw, 'Stripe subscription')
  }

  function summarize(user: UserRow) {
    return { plan: user.plan, status: user.subscriptionStatus, extraBrands: user.extraBrands, extraClipHours: user.extraClipHours }
  }

  return withErrors({
    /**
     * Applies a verified Stripe webhook event once (stripe_events dedupe; a failed attempt stays
     * unprocessed so Stripe's retry runs it again). `unmatched` (no user found yet) is left
     * unprocessed too: answer non-2xx so Stripe retries.
     */
    async applyStripeEvent(input: unknown, options: ApplyStripeEventOptions = {}): Promise<StripeEventResult> {
      const event = fromZod(StripeEventSchema, input, 'Stripe event')
      const base = { eventId: event.id, type: event.type }
      const handled = (HANDLED_STRIPE_EVENTS as readonly string[]).includes(event.type)
      const { event: record } = await ctx.repos.stripeEvents.record({ id: event.id, type: event.type })
      if (record.processedAt) return { status: 'duplicate', ...base }
      if (!handled) {
        await ctx.repos.stripeEvents.markProcessed(event.id)
        return { status: 'ignored', ...base }
      }

      // Read external state before the transaction (never hold a transaction across HTTP).
      const obj = event.data.object
      let subscription: StripeSubscription | null = null
      let session: z.output<typeof CheckoutSessionSchema> | null = null
      let invoice: z.output<typeof InvoiceSchema> | null = null
      if (event.type.startsWith('customer.subscription.')) {
        const parsed = fromZod(StripeSubscriptionSchema, obj, 'Stripe subscription')
        subscription = event.type === 'customer.subscription.deleted' ? parsed : await latestSubscription(parsed.id, obj, options)
      } else if (event.type === 'checkout.session.completed') {
        session = fromZod(CheckoutSessionSchema, obj, 'Checkout session')
        if (session.mode && session.mode !== 'subscription') {
          await ctx.repos.stripeEvents.markProcessed(event.id)
          return { status: 'ignored', ...base }
        }
        const subRef = session.subscription
        if (typeof subRef === 'string') {
          if (options.fetchSubscription) subscription = await latestSubscription(subRef, undefined, options)
        } else if (subRef) {
          subscription = subRef
        }
      } else {
        invoice = fromZod(InvoiceSchema, obj, 'Invoice')
      }
      // invoice.payment_failed: apply the subscription's current state, not "past_due" blindly (a
      // late retry of this event must not undo a recovery that was already applied).
      let invoiceSubscription: StripeSubscription | null = null
      const invoiceSubscriptionId = invoice ? (invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null) : null
      if (invoiceSubscriptionId && options.fetchSubscription) {
        invoiceSubscription = await latestSubscription(invoiceSubscriptionId, undefined, options)
      }

      return ctx.tx(async (r): Promise<StripeEventResult> => {
        const locked = await r.stripeEvents.lockUnprocessed(event.id)
        if (!locked) return { status: 'duplicate', ...base }

        if (session) {
          const user = await findUserIn(r, {
            customerId: session.customer ?? null,
            userId: session.client_reference_id ?? session.metadata?.userId ?? null,
          })
          if (!user) return { status: 'unmatched', ...base }
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null)
          await r.users.updateBilling(user.id, {
            ...(session.customer ? { stripeCustomerId: session.customer } : {}),
            ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          })
          const fresh = await requireUser(r, user.id)
          const applied = subscription ? await applySubscriptionIn(r, fresh, subscription, false, event.id) : null
          await auditIn(r, user.id, { actor: 'system', action: 'billing.checkout_completed', subjectType: 'user', subjectId: user.id, meta: { eventId: event.id } })
          await r.stripeEvents.markProcessed(event.id)
          const final = applied?.updated ?? (await requireUser(r, user.id))
          return { status: 'processed', ...base, userId: user.id, billing: summarize(final), ...(applied ? { brands: applied.brands } : {}) }
        }

        if (subscription) {
          const user = await findUserIn(r, {
            subscriptionId: subscription.id,
            customerId: subscription.customer,
            userId: subscription.metadata?.userId ?? null,
          })
          if (!user) return { status: 'unmatched', ...base }
          const applied = await applySubscriptionIn(r, user, subscription, event.type === 'customer.subscription.deleted', event.id)
          await r.stripeEvents.markProcessed(event.id)
          if (!applied) return { status: 'ignored', ...base, userId: user.id }
          return { status: 'processed', ...base, userId: user.id, billing: summarize(applied.updated), brands: applied.brands }
        }

        // invoice.payment_failed
        const inv = invoice as z.output<typeof InvoiceSchema>
        const subscriptionId = inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null
        const user = await findUserIn(r, { subscriptionId, customerId: inv.customer ?? null })
        if (!user) return { status: 'unmatched', ...base }
        // A failed invoice of an older subscription (found through the customer) must not put the
        // current subscription on hold.
        if (subscriptionId && user.stripeSubscriptionId && subscriptionId !== user.stripeSubscriptionId) {
          await r.stripeEvents.markProcessed(event.id)
          return { status: 'ignored', ...base, userId: user.id }
        }
        if (invoiceSubscription) {
          const applied = await applySubscriptionIn(r, user, invoiceSubscription, false, event.id)
          if (applied && applied.updated.subscriptionStatus !== user.subscriptionStatus) {
            await auditIn(r, user.id, {
              actor: 'system',
              action: 'billing.payment_failed',
              subjectType: 'user',
              subjectId: user.id,
              meta: { eventId: event.id, invoiceId: inv.id, status: applied.updated.subscriptionStatus },
            })
          }
          await r.stripeEvents.markProcessed(event.id)
          const final = applied?.updated ?? user
          return { status: 'processed', ...base, userId: user.id, billing: summarize(final), ...(applied ? { brands: applied.brands } : {}) }
        }
        let current = user
        if (user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing') {
          current = (await r.users.updateBilling(user.id, { subscriptionStatus: 'past_due' })) ?? user
          await auditIn(r, user.id, {
            actor: 'system',
            action: 'billing.payment_failed',
            subjectType: 'user',
            subjectId: user.id,
            meta: { eventId: event.id, invoiceId: inv.id },
          })
        }
        await r.stripeEvents.markProcessed(event.id)
        return { status: 'processed', ...base, userId: user.id, billing: summarize(current) }
      })
    },

    /** Line items and options for Stripe Checkout (the web route creates the session). */
    async checkoutParams(userId: string, input: unknown): Promise<CheckoutParams> {
      const uid = userIdOf(userId)
      const data = fromZod(CheckoutInputSchema, input, 'Plan choice')
      const user = await requireUser(ctx.repos, uid)
      if (user.stripeSubscriptionId && ['active', 'trialing', 'past_due', 'unpaid'].includes(user.subscriptionStatus)) {
        throw conflict('You already have a subscription. Change your plan in the billing portal.', { portal: true })
      }
      const item = (key: PriceKey, quantity: number): CheckoutLineItem => ({ lookupKey: key, price: ctx.config.stripePrices[key] ?? null, quantity })
      const lineItems = [item(data.plan, 1)]
      if (data.extraBrands > 0) lineItems.push(item('extra_brand', data.extraBrands))
      if (data.extraClipHours > 0) lineItems.push(item('extra_clip_hour', data.extraClipHours))
      const base = ctx.config.appUrl
      return {
        mode: 'subscription',
        lineItems,
        clientReferenceId: uid,
        customer: user.stripeCustomerId,
        customerEmail: user.stripeCustomerId ? null : user.email,
        metadata: { userId: uid },
        subscriptionData: { metadata: { userId: uid } },
        successUrl: `${base}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/app/billing?checkout=canceled`,
        allowPromotionCodes: true,
        monthlyPriceCents: monthlyPriceCents(data.plan, { extraBrands: data.extraBrands, extraClipHours: data.extraClipHours }),
      }
    },

    /** Customer-portal parameters (plan changes, payment method, cancel). */
    async portalParams(userId: string): Promise<{ customer: string; returnUrl: string }> {
      const user = await requireUser(ctx.repos, userIdOf(userId))
      if (!user.stripeCustomerId) throw validation('Choose a plan first.')
      return { customer: user.stripeCustomerId, returnUrl: `${ctx.config.appUrl}/app/billing` }
    },

    /** Billing page data. */
    async summary(userId: string): Promise<{ user: UserRow; entitlements: UserEntitlements; monthlyPriceCents: number | null }> {
      const user = await requireUser(ctx.repos, userIdOf(userId))
      const ent = userEntitlements(user, ctx.now())
      const paying = user.plan && (user.subscriptionStatus === 'active' || user.subscriptionStatus === 'past_due')
      return {
        user,
        entitlements: ent,
        monthlyPriceCents: paying && user.plan ? monthlyPriceCents(user.plan, { extraBrands: user.extraBrands, extraClipHours: user.extraClipHours }) : null,
      }
    },
  })
}

export type BillingService = ReturnType<typeof createBillingService>
