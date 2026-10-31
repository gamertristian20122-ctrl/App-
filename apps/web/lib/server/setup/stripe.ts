// /setup and Stripe: is the key valid (test or live), do the five prices exist with the amounts in
// @app/core/plans, does a webhook endpoint send exactly the events the webhook route handles (and
// is its signing secret available), and is the customer portal set up? Plus the one-tap fixes,
// each idempotent: running one twice changes nothing the second time. Server-only.

import { ADD_ONS, ADD_ON_KEYS, PLANS, formatCents } from '@app/core/plans'
import { PLAN_TIERS } from '@app/core/types'
import { HANDLED_STRIPE_EVENTS, STRIPE_PRICE_ENV, type PriceKey } from '@app/services'
import { isAppError } from '@app/core/errors'
import { SETTING_KEYS, getPlainSetting, setPlainSetting, setSecretSetting, stripeWebhookSecret } from '../settings'
import type { PortalConfigurationInfo, StripeAdminApi, StripePriceInfo, WebhookEndpointInfo } from '../stripe-admin'
import type { SetupCheck } from '@/lib/ui/setup'
import type { SetupDeps } from './deps'

export interface ActionOutcome {
  ok: boolean
  message: string
  issues?: string[]
  /** For the audit log (never secrets). */
  meta?: Record<string, string | number | boolean>
}

const STRIPE_KEY_FIX = 'Stripe → Developers → API keys → copy the Secret key → paste it into STRIPE_SECRET_KEY in Vercel → Settings → Environment Variables → Redeploy.'
const NEEDS_KEY = 'Needs the Stripe secret key first.'

export const webhookUrl = (appUrl: string) => `${appUrl}/api/stripe/webhook`

/** Short, safe text of an error (our AppErrors carry safe messages; anything else is generic). */
export function safeMessage(error: unknown, fallback = 'Something went wrong. Try again in a minute.'): string {
  return isAppError(error) ? error.message : fallback
}

// --- catalog ------------------------------------------------------------------------------------

export interface CatalogEntry {
  key: PriceKey
  name: string
  /** Cents per month. */
  unitAmount: number
  /** STRIPE_PRICE_* (the app uses that id instead of the lookup key). */
  pinnedEnv: string | null
  price: StripePriceInfo | null
  /** null when the price is right. */
  problem: string | null
}

const PRICE_KEYS_IN_ORDER: PriceKey[] = [...PLAN_TIERS, ...ADD_ON_KEYS]

function expected(key: PriceKey): { name: string; unitAmount: number; lookupKey: string } {
  if ((PLAN_TIERS as readonly string[]).includes(key)) {
    const plan = PLANS[key as (typeof PLAN_TIERS)[number]]
    return { name: plan.name, unitAmount: plan.priceCents, lookupKey: plan.lookupKey }
  }
  const addOn = ADD_ONS[key as (typeof ADD_ON_KEYS)[number]]
  return { name: addOn.name, unitAmount: addOn.priceCents, lookupKey: addOn.lookupKey }
}

function priceProblem(price: StripePriceInfo, unitAmount: number): string | null {
  const interval = price.interval === 'month' && (price.intervalCount ?? 1) === 1
  if (price.currency.toLowerCase() === 'usd' && price.unitAmount === unitAmount && interval && price.active) return null
  const actual = price.unitAmount === null ? 'has no fixed amount' : `is ${formatCents(price.unitAmount)} ${price.currency.toUpperCase()}`
  return `${actual}${interval ? '/month' : ' (not monthly)'}; it should be ${formatCents(unitAmount)} USD/month`
}

/**
 * How the app finds each price today (checkout route): STRIPE_PRICE_* when set, else the active
 * price with the lookup key. Checks every one against the amounts in plans.ts.
 */
export async function evaluateCatalog(stripe: StripeAdminApi, config: SetupDeps['config']): Promise<CatalogEntry[]> {
  const pinned = new Map<PriceKey, { env: string; id: string }>()
  for (const key of PRICE_KEYS_IN_ORDER) {
    const env = STRIPE_PRICE_ENV[key]
    const id = (config as unknown as Record<string, unknown>)[env]
    if (typeof id === 'string' && id) pinned.set(key, { env, id })
  }
  const byLookup = new Map<string, StripePriceInfo>()
  const lookupKeys = PRICE_KEYS_IN_ORDER.filter((k) => !pinned.has(k)).map((k) => expected(k).lookupKey)
  for (const price of await stripe.pricesByLookupKeys(lookupKeys)) if (price.lookupKey) byLookup.set(price.lookupKey, price)

  const entries: CatalogEntry[] = []
  for (const key of PRICE_KEYS_IN_ORDER) {
    const want = expected(key)
    const pin = pinned.get(key)
    if (pin) {
      const price = await stripe.retrievePrice(pin.id)
      const wrong = price ? priceProblem(price, want.unitAmount) : null
      const problem = !price ? `${pin.env} points to a price that does not exist in this Stripe mode` : wrong ? `${pin.env} ${wrong}` : null
      entries.push({ key, name: want.name, unitAmount: want.unitAmount, pinnedEnv: pin.env, price, problem })
      continue
    }
    const price = byLookup.get(want.lookupKey) ?? null
    const problem = price ? priceProblem(price, want.unitAmount) : 'missing'
    entries.push({ key, name: want.name, unitAmount: want.unitAmount, pinnedEnv: null, price, problem })
  }
  return entries
}

export async function catalogCheck(deps: SetupDeps): Promise<SetupCheck> {
  const base = { id: 'stripe.catalog', title: 'Plans and add-ons in Stripe' }
  if (!deps.stripe) return { ...base, status: 'unset', summary: NEEDS_KEY, fix: STRIPE_KEY_FIX }
  const entries = await evaluateCatalog(deps.stripe, deps.config)
  const bad = entries.filter((e) => e.problem)
  const lines = entries.map((e) => `${e.name} (${formatCents(e.unitAmount)}/month): ${e.problem ? e.problem : 'OK'}`)
  if (bad.length === 0) {
    return { ...base, status: 'ok', summary: `All ${entries.length} prices exist with the right amounts (monthly, USD).`, details: lines }
  }
  const fixable = bad.filter((e) => !e.pinnedEnv)
  const pinned = bad.some((e) => e.pinnedEnv)
  const fix = pinned
    ? `${fixable.length > 0 ? 'Tap the button, then ' : ''}remove the STRIPE_PRICE_* variables named above from Vercel (the app then finds prices by lookup key) and Redeploy.`
    : 'Tap “Create missing products and prices”.'
  return {
    ...base,
    status: 'attention',
    summary: `${bad.length} of ${entries.length} prices ${bad.length === 1 ? 'is' : 'are'} missing or wrong.`,
    details: lines,
    fix,
    ...(fixable.length > 0
      ? { action: { id: 'create_stripe_catalog' as const, label: 'Create missing products and prices', note: 'Monthly USD prices with the lookup keys the app uses. Existing subscribers keep their price.' } }
      : {}),
  }
}

const tenMinuteBucket = (now: Date) => Math.floor(now.getTime() / 600_000)

export async function createCatalog(deps: SetupDeps): Promise<ActionOutcome> {
  const stripe = deps.stripe
  if (!stripe) return { ok: false, message: 'Set STRIPE_SECRET_KEY in Vercel first.' }
  const entries = await evaluateCatalog(stripe, deps.config)
  const todo = entries.filter((e) => e.problem && !e.pinnedEnv)
  const skipped = entries.filter((e) => e.problem && e.pinnedEnv)
  if (todo.length === 0) {
    return skipped.length === 0
      ? { ok: true, message: `Nothing to do: all ${entries.length} prices are right.`, meta: { created: 0 } }
      : { ok: false, message: 'The wrong prices are pinned by STRIPE_PRICE_* variables. Remove them from Vercel and Redeploy.', issues: skipped.map((e) => e.problem ?? '') }
  }
  const products = await stripe.listProducts()
  const bucket = tenMinuteBucket(deps.now())
  const created: string[] = []
  for (const entry of todo) {
    const want = expected(entry.key)
    let productId = entry.price?.productId ?? null
    productId ??= products.find((p) => p.appKey === entry.key)?.id ?? null
    productId ??= products.find((p) => p.name.trim().toLowerCase() === want.name.toLowerCase())?.id ?? null
    if (!productId) {
      const product = await stripe.createProduct({ name: want.name, appKey: entry.key, idempotencyKey: `setup-product-${stripe.mode}-${entry.key}-${bucket}` })
      productId = product.id
    }
    await stripe.createPrice({
      productId,
      unitAmount: want.unitAmount,
      lookupKey: want.lookupKey,
      nickname: `${want.name} monthly`,
      idempotencyKey: `setup-price-${stripe.mode}-${want.lookupKey}-${want.unitAmount}-${productId}-${bucket}`,
    })
    created.push(want.name)
  }
  return {
    ok: true,
    message: `Created ${created.length} price${created.length === 1 ? '' : 's'}: ${created.join(', ')}.`,
    ...(skipped.length > 0 ? { issues: skipped.map((e) => `${e.problem ?? ''} (remove it from Vercel)`) } : {}),
    meta: { created: created.length, mode: stripe.mode },
  }
}

// --- key ------------------------------------------------------------------------------------------

export async function stripeKeyCheck(deps: SetupDeps): Promise<SetupCheck> {
  const base = { id: 'stripe.key', title: 'Stripe key' }
  if (!deps.stripe) return { ...base, status: 'unset', summary: 'STRIPE_SECRET_KEY is not set, so nobody can pay.', fix: STRIPE_KEY_FIX }
  const mode = deps.stripe.mode
  try {
    const account = await deps.stripe.account()
    const who = account.businessName ?? account.id
    if (mode === 'live' && !account.chargesEnabled) {
      return {
        ...base,
        status: 'attention',
        summary: `Live mode (${who}), but the account cannot take payments yet.`,
        fix: 'Stripe → Activate payments (or Settings → Business): finish the business details, bank account and identity check.',
      }
    }
    return {
      ...base,
      status: 'ok',
      summary: mode === 'live' ? `Live mode: real payments (${who}).` : `Test mode: no real money moves (${who}).`,
      ...(mode === 'test' ? { details: ['At launch, switch to the live keys and run this page again (docs/LAUNCH-ON-PHONE.md, last step).'] } : {}),
    }
  } catch (error) {
    return { ...base, status: 'attention', summary: safeMessage(error), fix: STRIPE_KEY_FIX }
  }
}

// --- webhook --------------------------------------------------------------------------------------

const HANDLED = [...HANDLED_STRIPE_EVENTS].sort()

function sameEvents(endpoint: WebhookEndpointInfo): boolean {
  const have = [...new Set(endpoint.enabledEvents)].sort()
  return have.length === HANDLED.length && have.every((e, i) => e === HANDLED[i])
}

export async function webhookCheck(deps: SetupDeps): Promise<SetupCheck> {
  const base = { id: 'stripe.webhook', title: 'Stripe webhook' }
  const url = webhookUrl(deps.config.APP_URL)
  if (!deps.stripe) return { ...base, status: 'unset', summary: NEEDS_KEY, fix: STRIPE_KEY_FIX }
  const action = { id: 'create_stripe_webhook' as const, label: 'Create webhook endpoint', note: `Points Stripe at ${url} with the ${HANDLED.length} events the app handles, and stores the signing secret encrypted.` }
  if (!deps.config.APP_URL.startsWith('https://')) {
    return { ...base, status: 'attention', summary: 'Stripe can only send webhooks to a public https address.', fix: 'Set APP_URL to your https address in Vercel first.' }
  }
  const [endpoints, secret] = await Promise.all([deps.stripe.listWebhookEndpoints(), stripeWebhookSecret(deps.db, deps.config)])
  const matches = endpoints.filter((e) => e.url === url)
  const details = [`Events: ${HANDLED.join(', ')}.`]
  if (matches.length === 0) {
    return { ...base, status: 'attention', summary: `No webhook endpoint for ${url} yet.`, fix: 'Tap “Create webhook endpoint”.', action, details }
  }
  const problems: string[] = []
  if (matches.length > 1) problems.push(`${matches.length} endpoints point at this address; Stripe signs each with its own secret.`)
  const endpoint = matches[0] as WebhookEndpointInfo
  if (!sameEvents(endpoint)) problems.push('The endpoint does not send exactly the events the app handles.')
  if (endpoint.status !== 'enabled') problems.push('The endpoint is disabled.')
  if (!secret) problems.push('Its signing secret is not available (STRIPE_WEBHOOK_SECRET is empty and this page has not stored one).')
  if (problems.length > 0) {
    return { ...base, status: 'attention', summary: problems[0] as string, details: [...problems.slice(1), ...details], fix: 'Tap “Create webhook endpoint” to fix it.', action }
  }
  return {
    ...base,
    status: 'ok',
    summary: `Stripe sends the ${HANDLED.length} billing events to ${url}.`,
    details: [`Signing secret: ${secret?.source === 'env' ? 'from STRIPE_WEBHOOK_SECRET in Vercel' : 'stored (encrypted) by this page'}. It is never shown.`, ...details],
  }
}

export async function createWebhook(deps: SetupDeps): Promise<ActionOutcome> {
  const stripe = deps.stripe
  if (!stripe) return { ok: false, message: 'Set STRIPE_SECRET_KEY in Vercel first.' }
  if (!deps.config.APP_URL.startsWith('https://')) return { ok: false, message: 'Stripe can only send webhooks to a public https address. Set APP_URL first.' }
  if (!deps.config.TOKEN_ENCRYPTION_KEYS) return { ok: false, message: 'Set TOKEN_ENCRYPTION_KEYS in Vercel first: it encrypts the stored signing secret.' }
  const url = webhookUrl(deps.config.APP_URL)
  const matches = (await stripe.listWebhookEndpoints()).filter((e) => e.url === url)
  const secret = await stripeWebhookSecret(deps.db, deps.config)

  if (matches.length > 0 && secret) {
    const endpoint = matches[0] as WebhookEndpointInfo
    if (sameEvents(endpoint) && endpoint.status === 'enabled') {
      return { ok: true, message: 'Nothing to do: the webhook endpoint is already set up.', meta: { endpoint: 'unchanged', mode: stripe.mode } }
    }
    await stripe.updateWebhookEndpoint(endpoint.id, { events: [...HANDLED] })
    return { ok: true, message: 'Updated the webhook endpoint: it now sends exactly the events the app handles.', meta: { endpoint: 'updated', mode: stripe.mode } }
  }

  // Stripe shows a signing secret only when an endpoint is created: without one, replace the endpoint.
  for (const old of matches) await stripe.deleteWebhookEndpoint(old.id)
  const { secret: signing } = await stripe.createWebhookEndpoint({
    url,
    events: [...HANDLED],
    idempotencyKey: `setup-webhook-${stripe.mode}-${tenMinuteBucket(deps.now())}`,
  })
  await setSecretSetting(deps.db, deps.config.TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret(stripe.mode), signing)
  const issues = deps.config.STRIPE_WEBHOOK_SECRET
    ? ['Delete STRIPE_WEBHOOK_SECRET in Vercel → Settings → Environment Variables and Redeploy: it belongs to another endpoint and would be used instead of the new one.']
    : []
  return {
    ok: true,
    message: `${matches.length > 0 ? 'Replaced' : 'Created'} the webhook endpoint and stored its signing secret (encrypted).`,
    ...(issues.length > 0 ? { issues } : {}),
    meta: { endpoint: matches.length > 0 ? 'replaced' : 'created', mode: stripe.mode },
  }
}

// --- customer portal ------------------------------------------------------------------------------

const PORTAL_LIMIT_NOTE =
  'Stripe’s portal cannot change a subscription that has add-ons (extra brands or clipping hours): those customers can still cancel and update their card, and you change their plan for them in the Stripe dashboard.'

function portalGood(c: PortalConfigurationInfo): boolean {
  return c.active && c.cancelEnabled && c.cancelMode === 'at_period_end' && c.paymentMethodUpdate
}

async function currentPortal(deps: SetupDeps, stripe: StripeAdminApi): Promise<{ config: PortalConfigurationInfo | null; stored: string | null; all: PortalConfigurationInfo[] }> {
  const [all, stored] = await Promise.all([stripe.listPortalConfigurations(), getPlainSetting(deps.db, SETTING_KEYS.stripePortalConfiguration(stripe.mode))])
  const mine = (stored ? all.find((c) => c.id === stored) : undefined) ?? all.find((c) => c.managedBySetup)
  return { config: mine ?? all.find((c) => c.isDefault) ?? null, stored, all }
}

export async function portalCheck(deps: SetupDeps): Promise<SetupCheck> {
  const base = { id: 'stripe.portal', title: 'Customer portal (cancel, card, invoices)' }
  if (!deps.stripe) return { ...base, status: 'unset', summary: NEEDS_KEY, fix: STRIPE_KEY_FIX }
  const action = { id: 'setup_billing_portal' as const, label: 'Set up billing portal', note: 'Cancel at the end of the paid period, card updates, invoices, and plan switching between the three plans.' }
  const { config } = await currentPortal(deps, deps.stripe)
  if (!config) {
    return { ...base, status: 'attention', summary: 'The customer portal is not set up, so “Manage billing” would fail.', fix: 'Tap “Set up billing portal”.', action, details: [PORTAL_LIMIT_NOTE] }
  }
  if (!portalGood(config)) {
    return {
      ...base,
      status: 'attention',
      summary: 'The portal does not allow cancelling at period end and card updates.',
      fix: 'Tap “Set up billing portal”.',
      action,
      details: [PORTAL_LIMIT_NOTE],
    }
  }
  return {
    ...base,
    status: 'ok',
    summary: `Customers can cancel (at the end of the paid period) and update their card${config.subscriptionUpdate ? ', and switch plans' : ''}.`,
    details: [PORTAL_LIMIT_NOTE],
  }
}

export async function setupPortal(deps: SetupDeps): Promise<ActionOutcome> {
  const stripe = deps.stripe
  if (!stripe) return { ok: false, message: 'Set STRIPE_SECRET_KEY in Vercel first.' }
  const entries = await evaluateCatalog(stripe, deps.config)
  const plans = entries.filter((e) => (PLAN_TIERS as readonly string[]).includes(e.key) && e.price && !e.problem)
  const byProduct = new Map<string, string[]>()
  for (const e of plans) byProduct.set(e.price!.productId, [...(byProduct.get(e.price!.productId) ?? []), e.price!.id])
  const planProducts = plans.length === PLAN_TIERS.length ? [...byProduct].map(([product, prices]) => ({ product, prices })) : []
  const input = {
    returnUrl: `${deps.config.APP_URL}/app/billing`,
    privacyUrl: `${deps.config.APP_URL}/privacy`,
    termsUrl: `${deps.config.APP_URL}/terms`,
    planProducts,
  }
  const { stored, all } = await currentPortal(deps, stripe)
  const mine = (stored ? all.find((c) => c.id === stored) : undefined) ?? all.find((c) => c.managedBySetup)
  const result = mine ? await stripe.updatePortalConfiguration(mine.id, input) : await stripe.createPortalConfiguration(input)
  if (result.id !== stored) await setPlainSetting(deps.db, SETTING_KEYS.stripePortalConfiguration(stripe.mode), result.id)
  const switching = planProducts.length > 0 && result.subscriptionUpdate
  return {
    ok: true,
    message: `Customer portal ${mine ? 'updated' : 'set up'}: cancel at period end, card updates and invoices${switching ? ', plus plan switching between Starter, Plus and Pro' : ''}.`,
    issues: switching ? [PORTAL_LIMIT_NOTE] : ['Plan switching is off until all three plan prices exist (tap “Create missing products and prices”, then this again).'],
    meta: { portal: mine ? 'updated' : 'created', switching, mode: stripe.mode },
  }
}
