// What /setup changes in the Stripe routes: the webhook verifies with STRIPE_WEBHOOK_SECRET when
// set, else with the signing secret /setup stored (for the Stripe mode of STRIPE_SECRET_KEY);
// signatures stay mandatory either way. The portal uses the configuration /setup created.

import Stripe from 'stripe'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as portal } from '@/app/api/stripe/portal/route'
import { POST as webhook } from '@/app/api/stripe/webhook/route'
import { SETTING_KEYS, setPlainSetting, setSecretSetting, stripeWebhookSecret } from '@/lib/server/settings'
import type { StripeApi } from '@/lib/server/stripe'
import { BASE, createHarness, readJson, request, type Harness } from './harness'
import { TEST_TOKEN_ENCRYPTION_KEYS } from '@app/core/testing'

const STORED = 'whsec_stored_by_setup_0123456789'
const ENV_SECRET = 'whsec_from_vercel_env_0123456789'

let h: Harness
const fake = {
  pricesByLookupKey: vi.fn(async () => new Map<string, string>()),
  createCheckoutSession: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })),
  createPortalSession: vi.fn(async (_input: { customer: string; returnUrl: string; configuration?: string }) => ({ url: 'https://billing.stripe.com/p/session/x' })),
  retrieveSubscription: vi.fn(async () => ({})),
} satisfies StripeApi

beforeAll(async () => {
  h = await createHarness({
    env: { STRIPE_WEBHOOK_SECRET: undefined, STRIPE_SECRET_KEY: 'sk_test_routekey_0123456789', TOKEN_ENCRYPTION_KEYS: TEST_TOKEN_ENCRYPTION_KEYS },
    overrides: { stripe: fake },
  })
})
afterAll(async () => {
  await h.close()
})
beforeEach(async () => {
  await h.db.query('delete from public.app_settings')
  fake.createPortalSession.mockClear()
  h.install()
})

let n = 0
function signed(secret: string) {
  n += 1
  const payload = JSON.stringify({ id: `evt_setup_${n}_${Date.now()}`, object: 'event', type: 'product.created', data: { object: { id: 'prod_1' } } })
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret })
  return request('/api/stripe/webhook', { body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': header } })
}

/** The same harness runtime with a different environment (config is rebuilt from it). */
async function withEnv(extra: Record<string, string | undefined>) {
  const { createServicesFromEnv } = await import('@app/services')
  const { silentLogger } = await import('@app/core/log')
  const rt = await createServicesFromEnv({ ...h.env, ...extra }, { db: h.db, clock: h.clock, logger: silentLogger, withoutTranscriber: true })
  h.install({ runtime: rt })
}

describe('Stripe webhook signing secret', () => {
  it('without an env secret or a stored one: 503 (not configured)', async () => {
    const res = await webhook(signed(STORED))
    expect(res.status).toBe(503)
  })

  it('uses the stored secret (decrypted) when STRIPE_WEBHOOK_SECRET is empty, and still verifies signatures', async () => {
    await setSecretSetting(h.db, TEST_TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret('test'), STORED)
    const ok = await webhook(signed(STORED))
    expect(ok.status).toBe(200)
    expect(await readJson(ok)).toMatchObject({ received: true, status: 'ignored' })
    expect((await webhook(signed('whsec_someone_else_0123456789'))).status).toBe(400)
    const unsigned = request('/api/stripe/webhook', { body: '{"id":"evt_x"}', headers: { 'content-type': 'application/json' } })
    expect((await webhook(unsigned)).status).toBe(400)
  })

  it('prefers STRIPE_WEBHOOK_SECRET from the environment over the stored one', async () => {
    await setSecretSetting(h.db, TEST_TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret('test'), STORED)
    await withEnv({ STRIPE_WEBHOOK_SECRET: ENV_SECRET })
    expect((await webhook(signed(ENV_SECRET))).status).toBe(200)
    expect((await webhook(signed(STORED))).status).toBe(400)
  })

  it('uses the secret stored for the key’s mode only (a live key ignores the test secret)', async () => {
    await setSecretSetting(h.db, TEST_TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret('test'), STORED)
    await withEnv({ STRIPE_SECRET_KEY: 'sk_live_routekey_0123456789' })
    expect((await webhook(signed(STORED))).status).toBe(503)
    expect(await stripeWebhookSecret(h.db, { STRIPE_SECRET_KEY: 'sk_test_x', TOKEN_ENCRYPTION_KEYS: TEST_TOKEN_ENCRYPTION_KEYS })).toEqual({ secret: STORED, source: 'stored' })
  })

  it('treats a stored secret that cannot be decrypted (keys changed) as missing', async () => {
    await setSecretSetting(h.db, TEST_TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret('test'), STORED)
    const other = 'v9:' + Buffer.alloc(32, 7).toString('base64')
    expect(await stripeWebhookSecret(h.db, { STRIPE_SECRET_KEY: 'sk_test_x', TOKEN_ENCRYPTION_KEYS: other })).toBeNull()
  })
})

describe('Stripe portal configuration', () => {
  it('passes the configuration /setup stored for this mode, and none otherwise', async () => {
    const u = await h.createUser('portal-setup@example.com', { stripeCustomerId: 'cus_setup' })
    let res = await portal(request('/api/stripe/portal', { json: {}, cookie: h.cookie(u.email), headers: { origin: BASE } }))
    expect(res.status).toBe(200)
    expect(fake.createPortalSession).toHaveBeenLastCalledWith({ customer: 'cus_setup', returnUrl: `${BASE}/app/billing` })
    await setPlainSetting(h.db, SETTING_KEYS.stripePortalConfiguration('test'), 'bpc_from_setup')
    res = await portal(request('/api/stripe/portal', { json: {}, cookie: h.cookie(u.email), headers: { origin: BASE } }))
    expect(res.status).toBe(200)
    expect(fake.createPortalSession).toHaveBeenLastCalledWith({ customer: 'cus_setup', returnUrl: `${BASE}/app/billing`, configuration: 'bpc_from_setup' })
  })
})
