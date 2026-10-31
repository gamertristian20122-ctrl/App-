// The /setup one-tap fixes (mocked R2 and Stripe): each does its job, is idempotent, stores the
// Stripe signing secret only encrypted, and never returns a secret. Plus the action runner: owner
// gate (404), per-owner rate limit, audit entry without secrets, page refresh.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appSettings } from '@app/db'
import { HANDLED_STRIPE_EVENTS } from '@app/services'
import { createCatalog, createWebhook, catalogCheck, portalCheck, setupPortal, webhookCheck } from '@/lib/server/setup/stripe'
import { fixStorageCors } from '@/lib/server/setup/actions'
import { SETTING_KEYS, getPlainSetting, getSecretSetting } from '@/lib/server/settings'
import { resetRateLimitsForTests } from '@/lib/server/rate-limit'
import { stripeSafeError } from '@/lib/server/stripe-admin'
import { setUiOverridesForTests } from '@/lib/ui/runtime'
import { createHarness, type Harness } from '../api/harness'
import { createFakeStripe, seedPrice } from './fake-stripe'
import { PROD_URL, R2_ENV, S3Error, scriptedR2, setupDeps } from './helpers'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  },
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  },
}))

const OWNER = 'owner@example.com'
let h: Harness
beforeAll(async () => {
  h = await createHarness({ env: { OWNER_EMAIL: 'Owner@Example.com', STRIPE_SECRET_KEY: 'sk_test_setupkey0123456789', STRIPE_WEBHOOK_SECRET: undefined } })
})
afterAll(async () => {
  setUiOverridesForTests(null)
  await h.close()
})
beforeEach(async () => {
  await h.db.query('delete from public.app_settings')
  revalidatePath.mockClear()
  resetRateLimitsForTests()
  h.install()
})

describe('fix storage CORS', () => {
  it('adds the upload rule for APP_URL, keeps other origins, and is a no-op the second time', async () => {
    const r2 = scriptedR2({ cors: [{ AllowedOrigins: ['https://staging.example.com'], AllowedMethods: ['GET'], AllowedHeaders: [], ExposeHeaders: [] }] })
    const deps = setupDeps(h, { env: R2_ENV, storage: r2.storage })
    const first = await fixStorageCors(deps)
    expect(first).toMatchObject({ ok: true, message: `Storage CORS updated: browsers may now upload from ${PROD_URL}.` })
    expect(r2.cors()).toEqual([
      { AllowedOrigins: ['https://staging.example.com'], AllowedMethods: ['GET'], AllowedHeaders: [], ExposeHeaders: [] },
      { AllowedOrigins: [PROD_URL], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
    ])
    const puts = () => r2.send.mock.calls.filter((c) => c[0].constructor.name === 'PutBucketCorsCommand').length
    expect(puts()).toBe(1)
    const second = await fixStorageCors(deps)
    expect(second).toMatchObject({ ok: true, message: expect.stringContaining('Nothing to do') })
    expect(puts()).toBe(1)
  })

  it('writes even when the token may not read CORS, and explains the manual way when writing is refused too', async () => {
    const readDenied = scriptedR2({ fail: { GetBucketCorsCommand: new S3Error('AccessDenied', 403) } })
    expect(await fixStorageCors(setupDeps(h, { env: R2_ENV, storage: readDenied.storage }))).toMatchObject({ ok: true })
    const denied = scriptedR2({ fail: { GetBucketCorsCommand: new S3Error('AccessDenied', 403), PutBucketCorsCommand: new S3Error('AccessDenied', 403) } })
    const refused = await fixStorageCors(setupDeps(h, { env: R2_ENV, storage: denied.storage }))
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('Settings → CORS policy') })
    expect(JSON.stringify(refused)).not.toContain('r2-secret-for-setup-tests')
    expect(await fixStorageCors(setupDeps(h))).toMatchObject({ ok: false, message: expect.stringContaining('not stored in R2') })
  })
})

describe('create missing products and prices', () => {
  it('creates the five monthly USD prices with lookup keys and the amounts from plans.ts, once', async () => {
    const s = createFakeStripe()
    const deps = setupDeps(h, { stripe: s.api })
    const first = await createCatalog(deps)
    expect(first).toMatchObject({ ok: true, message: 'Created 5 prices: Starter, Plus, Pro, Extra brand, Extra clipping hour.' })
    expect(s.state.prices.map((p) => [p.lookupKey, p.unitAmount, p.currency, p.interval])).toEqual([
      ['starter', 800, 'usd', 'month'],
      ['plus', 1500, 'usd', 'month'],
      ['pro', 2500, 'usd', 'month'],
      ['extra_brand', 300, 'usd', 'month'],
      ['extra_clip_hour', 100, 'usd', 'month'],
    ])
    expect(s.state.products.map((p) => [p.name, p.appKey])).toEqual([
      ['Starter', 'starter'],
      ['Plus', 'plus'],
      ['Pro', 'pro'],
      ['Extra brand', 'extra_brand'],
      ['Extra clipping hour', 'extra_clip_hour'],
    ])
    expect(s.api.createProduct.mock.calls[0]?.[0].idempotencyKey).toMatch(/^setup-product-test-starter-\d+$/)
    expect((await catalogCheck(deps)).status).toBe('ok')

    const second = await createCatalog(deps)
    expect(second).toMatchObject({ ok: true, message: 'Nothing to do: all 5 prices are right.' })
    expect(s.api.createPrice).toHaveBeenCalledTimes(5)
  })

  it('fixes a wrong amount on the same product (the lookup key moves to the new price) and reuses products by name', async () => {
    const s = createFakeStripe()
    const old = seedPrice(s.state, 'pro', 2900)
    s.state.products.push({ id: 'prod_manual_starter', name: 'Starter', active: true, appKey: null })
    const result = await createCatalog(setupDeps(h, { stripe: s.api }))
    expect(result.ok).toBe(true)
    const pro = s.state.prices.find((p) => p.lookupKey === 'pro')
    expect(pro).toMatchObject({ unitAmount: 2500, productId: old.productId })
    expect(s.state.prices.find((p) => p.id === old.id)?.lookupKey).toBeNull()
    expect(s.state.prices.find((p) => p.lookupKey === 'starter')?.productId).toBe('prod_manual_starter')
    expect(s.api.createProduct.mock.calls.map((c) => c[0].appKey)).toEqual(['plus', 'extra_brand', 'extra_clip_hour'])
  })

  it('leaves prices pinned by STRIPE_PRICE_* alone and says so', async () => {
    const s = createFakeStripe()
    for (const [k, v] of [['starter', 800], ['plus', 1500], ['extra_brand', 300], ['extra_clip_hour', 100]] as const) seedPrice(s.state, k, v)
    const result = await createCatalog(setupDeps(h, { stripe: s.api, env: { STRIPE_PRICE_PRO: 'price_missing12345' } }))
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('STRIPE_PRICE_*') })
    expect(s.api.createPrice).not.toHaveBeenCalled()
  })
})

describe('create webhook endpoint', () => {
  const url = `${PROD_URL}/api/stripe/webhook`

  it('creates the endpoint with exactly the handled events and stores the signing secret encrypted', async () => {
    const s = createFakeStripe()
    const deps = setupDeps(h, { stripe: s.api, env: { STRIPE_SECRET_KEY: 'sk_test_setupkey0123456789' } })
    const result = await createWebhook(deps)
    expect(result).toMatchObject({ ok: true, message: 'Created the webhook endpoint and stored its signing secret (encrypted).', meta: { endpoint: 'created', mode: 'test' } })
    expect(s.api.createWebhookEndpoint).toHaveBeenCalledWith({ url, events: [...HANDLED_STRIPE_EVENTS].sort(), idempotencyKey: expect.stringMatching(/^setup-webhook-test-\d+$/) })
    const secret = s.state.endpoints[0]?.secret as string
    const row = await appSettings.get(h.db, SETTING_KEYS.stripeWebhookSecret('test'))
    expect(row).toMatchObject({ encrypted: true })
    expect(row?.value).not.toContain(secret)
    expect(await getSecretSetting(h.db, deps.config.TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret('test'))).toBe(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect((await webhookCheck(deps)).status).toBe('ok')

    // idempotent
    expect(await createWebhook(deps)).toMatchObject({ ok: true, message: expect.stringContaining('Nothing to do') })
    expect(s.api.createWebhookEndpoint).toHaveBeenCalledTimes(1)
    // events drifted → updated in place (the stored secret stays valid)
    s.state.endpoints[0]!.enabledEvents = ['checkout.session.completed']
    expect(await createWebhook(deps)).toMatchObject({ ok: true, meta: { endpoint: 'updated' } })
    expect(s.state.endpoints[0]?.enabledEvents.sort()).toEqual([...HANDLED_STRIPE_EVENTS].sort())
    expect(s.api.createWebhookEndpoint).toHaveBeenCalledTimes(1)
  })

  it('replaces an endpoint whose secret is unknown, and warns about an old STRIPE_WEBHOOK_SECRET', async () => {
    const s = createFakeStripe()
    s.state.endpoints.push({ id: 'we_old', url, enabledEvents: [...HANDLED_STRIPE_EVENTS], status: 'enabled', secret: 'whsec_unknown' })
    const replaced = await createWebhook(setupDeps(h, { stripe: s.api }))
    expect(replaced).toMatchObject({ ok: true, meta: { endpoint: 'replaced' } })
    expect(s.api.deleteWebhookEndpoint).toHaveBeenCalledWith('we_old')
    expect(s.state.endpoints.map((e) => e.id)).not.toContain('we_old')

    const fresh = createFakeStripe()
    const withEnv = await createWebhook(setupDeps(h, { stripe: fresh.api, env: { STRIPE_WEBHOOK_SECRET: 'whsec_old_env_0123456789' } }))
    // env set but no endpoint for this URL: create one; the env secret would win, so say to delete it
    expect(withEnv).toMatchObject({ ok: true, issues: [expect.stringContaining('Delete STRIPE_WEBHOOK_SECRET')] })
  })

  it('refuses without https, without the encryption keys, or without Stripe', async () => {
    const s = createFakeStripe()
    expect(await createWebhook(setupDeps(h, { stripe: s.api, env: { APP_URL: 'http://localhost:3000' } }))).toMatchObject({ ok: false })
    expect(await createWebhook(setupDeps(h, { stripe: s.api, env: { TOKEN_ENCRYPTION_KEYS: '' } }))).toMatchObject({ ok: false, message: expect.stringContaining('TOKEN_ENCRYPTION_KEYS') })
    expect(await createWebhook(setupDeps(h))).toMatchObject({ ok: false })
    expect(s.api.createWebhookEndpoint).not.toHaveBeenCalled()
  })
})

describe('set up billing portal', () => {
  it('without the plan prices: cancel at period end and card updates, plan switching off', async () => {
    const s = createFakeStripe()
    const result = await setupPortal(setupDeps(h, { stripe: s.api }))
    expect(result).toMatchObject({ ok: true, issues: [expect.stringContaining('Plan switching is off')] })
    expect(s.api.createPortalConfiguration).toHaveBeenCalledWith({
      returnUrl: `${PROD_URL}/app/billing`,
      privacyUrl: `${PROD_URL}/privacy`,
      termsUrl: `${PROD_URL}/terms`,
      planProducts: [],
    })
  })

  it('with the catalog: plan switching between the three plans; stores the id; updates it the second time', async () => {
    const s = createFakeStripe()
    const deps = setupDeps(h, { stripe: s.api })
    await createCatalog(deps)
    const first = await setupPortal(deps)
    expect(first).toMatchObject({ ok: true, message: expect.stringContaining('plan switching between Starter, Plus and Pro'), issues: [expect.stringContaining('add-ons')] })
    const input = s.api.createPortalConfiguration.mock.calls[0]?.[0]
    expect(input?.planProducts).toHaveLength(3)
    expect(input?.planProducts.every((p) => p.prices.length === 1)).toBe(true)
    const stored = await getPlainSetting(h.db, SETTING_KEYS.stripePortalConfiguration('test'))
    expect(stored).toBe(s.state.portals[0]?.id)
    expect((await portalCheck(deps)).status).toBe('ok')

    const second = await setupPortal(deps)
    expect(second.message).toContain('updated')
    expect(s.api.createPortalConfiguration).toHaveBeenCalledTimes(1)
    expect(s.api.updatePortalConfiguration).toHaveBeenCalledWith(stored, expect.objectContaining({ planProducts: expect.any(Array) }))
  })
})

describe('runSetupAction (owner gate, rate limit, audit)', () => {
  it('is a 404 for anyone but the owner (and while signed out)', async () => {
    const { runSetupAction } = await import('@/lib/server/setup/run')
    const other = await h.createUser('someone@example.com')
    setUiOverridesForTests({ user: other })
    await expect(runSetupAction('create_stripe_catalog')).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
    setUiOverridesForTests({ user: null })
    await expect(runSetupAction('create_stripe_catalog')).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  })

  it('runs for the owner (any letter case), audits without secrets, refreshes the page, and rate-limits', async () => {
    const { runSetupAction } = await import('@/lib/server/setup/run')
    const owner = await h.createUser(OWNER)
    const s = createFakeStripe()
    h.install({ stripeAdmin: s.api })
    setUiOverridesForTests({ user: { id: owner.id, email: 'OWNER@example.com' } })
    const result = await runSetupAction('setup_billing_portal')
    expect(result.ok).toBe(true)
    expect(revalidatePath).toHaveBeenCalledWith('/setup')
    const audit = await h.rt.services.audit.list(owner.id, { action: 'setup.setup_billing_portal' })
    expect(audit[0]).toMatchObject({ actor: 'web', subjectType: 'setup', subjectId: 'setup_billing_portal', meta: { ok: true, portal: 'created', mode: 'test' } })

    // a failing call becomes a safe message, and is audited too
    s.api.listPortalConfigurations.mockRejectedValueOnce(stripeSafeError(Object.assign(new Error('Invalid API Key provided: sk_test_****'), { type: 'StripeAuthenticationError' })))
    const failed = await runSetupAction('setup_billing_portal')
    expect(failed).toMatchObject({ ok: false, message: expect.stringContaining('Stripe refused STRIPE_SECRET_KEY') })
    expect(JSON.stringify(failed)).not.toContain('sk_test')

    // an unexpected error (not one of ours) never reaches the page
    s.api.listPortalConfigurations.mockRejectedValueOnce(new Error('raw sk_test_leak'))
    expect(await runSetupAction('setup_billing_portal')).toMatchObject({ ok: false, message: 'Something went wrong. Try again in a minute.' })

    for (let i = 0; i < 3; i++) await runSetupAction('create_stripe_catalog')
    const limited = await runSetupAction('create_stripe_catalog')
    expect(limited).toMatchObject({ ok: false, message: expect.stringContaining('Too many taps') })
    const all = await h.rt.services.audit.list(owner.id, { limit: 50 })
    expect(JSON.stringify(all)).not.toMatch(/whsec_|sk_test_/)
  })
})
