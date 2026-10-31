// Every /setup check with mocked services: basics, database + migrations, Supabase auth, R2
// bucket + CORS, Upload-Post, Stripe (key, prices, webhook, portal), transcription, worker
// heartbeats, legal pages and the connect card. The report never contains a secret value.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { workerHeartbeats } from '@app/db'
import { FakePostingProvider, UploadPostProvider } from '@app/posting'
import { HANDLED_STRIPE_EVENTS } from '@app/services'
import {
  basicsChecks,
  connectCheck,
  databaseChecks,
  legalChecks,
  postingChecks,
  runSetupChecks,
  storageChecks,
  supabaseCheck,
  transcriptionCheck,
  workerChecks,
} from '@/lib/server/setup/checks'
import { catalogCheck, portalCheck, stripeKeyCheck, webhookCheck } from '@/lib/server/setup/stripe'
import { SETTING_KEYS, setSecretSetting } from '@/lib/server/settings'
import { createHarness, type Harness } from '../api/harness'
import { createFakeStripe, seedPrice } from './fake-stripe'
import { PROD_URL, R2_ENV, S3Error, json, scriptedR2, setupDeps } from './helpers'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.close()
})
beforeEach(async () => {
  await h.db.query('delete from public.app_settings')
  await h.db.query('delete from public.worker_heartbeats')
})

const byId = <T extends { id: string }>(list: T[], id: string) => list.find((c) => c.id === id) as T

describe('a. basics', () => {
  it('flags a test environment, http APP_URL, missing secrets, DEV_AUTH and fake services', () => {
    const checks = basicsChecks(setupDeps(h, { env: { APP_URL: 'http://localhost:3000', CRON_SECRET: '', DEV_AUTH: '1' } }))
    expect(byId(checks, 'basics.environment')).toMatchObject({ status: 'attention', summary: expect.stringContaining('APP_ENV is test') })
    expect(byId(checks, 'basics.app_url')).toMatchObject({ status: 'attention', fix: expect.stringContaining('Settings → Environment Variables') })
    expect(byId(checks, 'basics.secrets')).toMatchObject({ status: 'unset', summary: 'Missing: CRON_SECRET.' })
    expect(byId(checks, 'basics.services')).toMatchObject({ status: 'attention', summary: expect.stringContaining('POSTING_PROVIDER=fake') })
    const dev = basicsChecks(setupDeps(h, { env: { DEV_AUTH: '1' } }))
    expect(byId(dev, 'basics.secrets')).toMatchObject({ status: 'attention', summary: expect.stringContaining('DEV_AUTH is on') })
  })

  it('is all OK for a production setup', () => {
    const checks = basicsChecks(
      setupDeps(h, {
        env: { APP_ENV: 'production', DATABASE_URL: 'postgres://x', POSTING_PROVIDER: 'upload_post', UPLOAD_POST_API_KEY: 'k', TRANSCRIPTION_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'aai-key-0123456789', ...R2_ENV },
      }),
    )
    expect(checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })
})

describe('b. database', () => {
  it('reports the connection and that every migration is applied', async () => {
    const [connection, migrations] = await databaseChecks(setupDeps(h))
    expect(connection).toMatchObject({ status: 'attention', summary: expect.stringContaining('in-process test database') })
    expect(migrations).toMatchObject({ status: 'ok', summary: 'All 5 migrations are applied.' })
  })

  it('names missing migrations and how to apply them from Vercel', async () => {
    const row = await h.db.one<{ version: string; name: string; checksum: string }>(`select version, name, checksum from public.schema_migrations where name = '0005_launch_setup'`)
    await h.db.query(`delete from public.schema_migrations where name = '0005_launch_setup'`)
    try {
      const [, migrations] = await databaseChecks(setupDeps(h))
      expect(migrations).toMatchObject({ status: 'attention', summary: 'Missing 1 migration: 0005_launch_setup.', fix: expect.stringContaining('RUN_MIGRATIONS=1') })
    } finally {
      await h.db.query('insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)', [row?.version, row?.name, row?.checksum])
    }
  })

  it('reports an unreachable database', async () => {
    const deps = { ...setupDeps(h), db: { ...h.db, driver: 'postgres' as const, query: async () => Promise.reject(new Error('ECONNREFUSED postgres://user:pw@host')), one: async () => Promise.reject(new Error('down')) } }
    const [connection, migrations] = await databaseChecks(deps)
    expect(connection).toMatchObject({ status: 'attention', summary: 'The database could not be reached.' })
    expect(migrations?.status).toBe('attention')
    expect(JSON.stringify([connection, migrations])).not.toContain('pw@host')
  })
})

describe('c. Supabase sign-in', () => {
  const env = { SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_ANON_KEY: 'anon-key-0123456789' }

  it('calls /auth/v1/health with the apikey header and reminds about SMTP', async () => {
    const fetchMock = vi.fn(async () => json({ name: 'GoTrue' }))
    const check = await supabaseCheck(setupDeps(h, { env, fetch: fetchMock as unknown as typeof fetch }))
    expect(check).toMatchObject({ status: 'ok', summary: 'Supabase sign-in answered.' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://abcd.supabase.co/auth/v1/health')
    expect((init.headers as Record<string, string>).apikey).toBe('anon-key-0123456789')
    expect(check.details?.join(' ')).toMatch(/SMTP/)
  })

  it('reports a refused key, an unreachable URL and an unset Supabase', async () => {
    const refused = await supabaseCheck(setupDeps(h, { env, fetch: (async () => json({}, 401)) as unknown as typeof fetch }))
    expect(refused).toMatchObject({ status: 'attention', summary: 'Supabase refused SUPABASE_ANON_KEY.' })
    const down = await supabaseCheck(setupDeps(h, { env, fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch }))
    expect(down).toMatchObject({ status: 'attention', summary: 'SUPABASE_URL could not be reached.' })
    expect(await supabaseCheck(setupDeps(h))).toMatchObject({ status: 'unset' })
  })
})

describe('d. R2 storage', () => {
  it('shows local test storage as not set', async () => {
    const [bucket, cors] = await storageChecks(setupDeps(h))
    expect(bucket).toMatchObject({ status: 'unset', summary: expect.stringContaining('in memory') })
    expect(cors?.status).toBe('unset')
  })

  it('HeadBucket OK and CORS missing → attention with the fix button and the policy to copy', async () => {
    const r2 = scriptedR2()
    const [bucket, cors] = await storageChecks(setupDeps(h, { env: R2_ENV, storage: r2.storage }))
    expect(bucket).toMatchObject({ status: 'ok', summary: 'Bucket media-bucket is reachable.' })
    expect(cors).toMatchObject({ status: 'attention', summary: `No CORS rule allows ${PROD_URL}.`, action: { id: 'fix_storage_cors' } })
    expect(JSON.parse(cors?.copies?.[0]?.value ?? '[]')).toEqual([
      { AllowedOrigins: [PROD_URL], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
    ])
    expect(r2.send.mock.calls.map((c) => c[0].constructor.name)).toEqual(['HeadBucketCommand', 'GetBucketCorsCommand'])
  })

  it('CORS that allows the app → OK', async () => {
    const r2 = scriptedR2({ cors: [{ AllowedOrigins: [PROD_URL], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'] }] })
    const [, cors] = await storageChecks(setupDeps(h, { env: R2_ENV, storage: r2.storage }))
    expect(cors).toMatchObject({ status: 'ok' })
  })

  it('an object-only token: HeadBucket refused but objects reachable; CORS unreadable → manual steps', async () => {
    const r2 = scriptedR2({ fail: { HeadBucketCommand: new S3Error('AccessDenied', 403), GetBucketCorsCommand: new S3Error('AccessDenied', 403) } })
    const [bucket, cors] = await storageChecks(setupDeps(h, { env: R2_ENV, storage: r2.storage }))
    expect(bucket).toMatchObject({ status: 'ok', summary: expect.stringContaining('object access') })
    expect(cors).toMatchObject({ status: 'attention', action: { id: 'fix_storage_cors' }, details: [expect.stringContaining('CORS policy → Edit')] })
    expect(JSON.stringify([bucket, cors])).not.toContain('r2-secret-for-setup-tests')
  })

  it('refused keys and a missing bucket', async () => {
    const denied = scriptedR2({ fail: { HeadBucketCommand: new S3Error('AccessDenied', 403), HeadObjectCommand: new S3Error('AccessDenied', 403) } })
    const [bucket] = await storageChecks(setupDeps(h, { env: R2_ENV, storage: denied.storage }))
    expect(bucket).toMatchObject({ status: 'attention', summary: 'R2 refused the access key for bucket media-bucket.' })
    const missing = scriptedR2({ fail: { HeadBucketCommand: new S3Error('NoSuchBucket', 404) } })
    const [gone] = await storageChecks(setupDeps(h, { env: R2_ENV, storage: missing.storage }))
    expect(gone).toMatchObject({ status: 'attention', summary: 'Bucket media-bucket was not found.' })
  })
})

describe('e. Upload-Post', () => {
  const API_KEY = 'up_live_setup_key_0123456789abcdef'

  it('shows TEST MODE with the fake provider', async () => {
    const [provider, webhook] = await postingChecks(setupDeps(h))
    expect(provider).toMatchObject({ status: 'attention', summary: expect.stringContaining('TEST MODE') })
    expect(webhook?.status).toBe('unset')
  })

  it('checks the API key through the adapter’s health check (mocked HTTP)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => json({ success: true, profiles: [{ username: 'brand_1' }] }))
    const provider = new UploadPostProvider({ apiKey: API_KEY, fetch: fetchMock })
    const env = { POSTING_PROVIDER: 'upload_post', UPLOAD_POST_API_KEY: API_KEY, UPLOAD_POST_WEBHOOK_SECRET: 'up-webhook-secret-0123456789' }
    const [ok, webhook] = await postingChecks(setupDeps(h, { env, provider }))
    expect(ok).toMatchObject({ status: 'ok', summary: 'Upload-Post accepted the API key (1 profile in use).' })
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe('/api/uploadposts/users')
    expect(webhook).toMatchObject({ status: 'ok' })

    const refused = new UploadPostProvider({ apiKey: API_KEY, fetch: async () => json({ success: false, message: 'bad key' }, 401) })
    const [bad, missingSecret] = await postingChecks(setupDeps(h, { env: { ...env, UPLOAD_POST_WEBHOOK_SECRET: '' }, provider: refused }))
    expect(bad).toMatchObject({ status: 'attention', summary: expect.stringContaining('refused the API key'), fix: expect.stringContaining('UPLOAD_POST_API_KEY') })
    expect(missingSecret).toMatchObject({ status: 'unset', copies: [{ value: `${PROD_URL}/api/webhooks/upload-post` }] })
    expect(JSON.stringify([ok, bad])).not.toContain(API_KEY)
  })

  it('reports a failing fake health check', async () => {
    const fake = new FakePostingProvider()
    const named = Object.assign(Object.create(Object.getPrototypeOf(fake) as object) as FakePostingProvider, fake, { name: 'upload_post' })
    named.failNext('healthCheck')
    const [provider] = await postingChecks(setupDeps(h, { provider: named }))
    expect(provider).toMatchObject({ status: 'attention', summary: 'The fake posting service is unavailable.' })
  })
})

describe('f. Stripe', () => {
  it('is “not set” without a key', async () => {
    const deps = setupDeps(h)
    expect(await stripeKeyCheck(deps)).toMatchObject({ status: 'unset', fix: expect.stringContaining('STRIPE_SECRET_KEY') })
    for (const check of [catalogCheck, webhookCheck, portalCheck]) expect((await check(deps)).status).toBe('unset')
  })

  it('shows test vs live mode, and a live account that cannot take payments', async () => {
    const test = createFakeStripe('test')
    expect(await stripeKeyCheck(setupDeps(h, { stripe: test.api }))).toMatchObject({ status: 'ok', summary: 'Test mode: no real money moves (Acme Studio).' })
    const live = createFakeStripe('live')
    expect(await stripeKeyCheck(setupDeps(h, { stripe: live.api }))).toMatchObject({ status: 'ok', summary: 'Live mode: real payments (Acme Studio).' })
    live.state.account.chargesEnabled = false
    expect(await stripeKeyCheck(setupDeps(h, { stripe: live.api }))).toMatchObject({ status: 'attention', fix: expect.stringContaining('Activate payments') })
    live.api.account.mockRejectedValueOnce(Object.assign(new Error('Invalid API Key provided: sk_live_****abcd'), { type: 'StripeAuthenticationError' }))
    const refused = await stripeKeyCheck(setupDeps(h, { stripe: live.api }))
    expect(refused).toMatchObject({ status: 'attention' })
    expect(JSON.stringify(refused)).not.toContain('sk_live')
  })

  it('checks the five prices against plans.ts (lookup keys, or pinned STRIPE_PRICE_* ids)', async () => {
    const s = createFakeStripe()
    let check = await catalogCheck(setupDeps(h, { stripe: s.api }))
    expect(check).toMatchObject({ status: 'attention', summary: '5 of 5 prices are missing or wrong.', action: { id: 'create_stripe_catalog' } })
    seedPrice(s.state, 'starter', 800)
    seedPrice(s.state, 'plus', 1500)
    seedPrice(s.state, 'pro', 2900)
    seedPrice(s.state, 'extra_brand', 300)
    seedPrice(s.state, 'extra_clip_hour', 100, { interval: 'year' })
    check = await catalogCheck(setupDeps(h, { stripe: s.api }))
    expect(check.summary).toBe('2 of 5 prices are missing or wrong.')
    expect(check.details).toEqual(expect.arrayContaining(['Pro ($25/month): is $29 USD/month; it should be $25 USD/month', 'Starter ($8/month): OK']))
    expect(check.details?.find((d) => d.startsWith('Extra clipping hour'))).toContain('not monthly')

    // a pinned price id is used instead of the lookup key, and cannot be fixed by the button
    const pinned = await catalogCheck(setupDeps(h, { stripe: s.api, env: { STRIPE_PRICE_PRO: 'price_doesnotexist1' } }))
    expect(pinned.details?.find((d) => d.startsWith('Pro'))).toContain('STRIPE_PRICE_PRO points to a price that does not exist')
    expect(pinned.fix).toContain('remove the STRIPE_PRICE_*')
  })

  it('checks the webhook endpoint: URL, exact events, enabled, signing secret available', async () => {
    const s = createFakeStripe()
    const url = `${PROD_URL}/api/stripe/webhook`
    expect(await webhookCheck(setupDeps(h, { stripe: s.api }))).toMatchObject({ status: 'attention', summary: `No webhook endpoint for ${url} yet.`, action: { id: 'create_stripe_webhook' } })
    s.state.endpoints.push({ id: 'we_1', url, enabledEvents: [...HANDLED_STRIPE_EVENTS], status: 'enabled', secret: 'whsec_x' })
    expect(await webhookCheck(setupDeps(h, { stripe: s.api }))).toMatchObject({ status: 'attention', summary: expect.stringContaining('signing secret is not available') })
    // env secret first
    expect(await webhookCheck(setupDeps(h, { stripe: s.api, env: { STRIPE_WEBHOOK_SECRET: 'whsec_from_env_0123456789' } }))).toMatchObject({
      status: 'ok',
      details: [expect.stringContaining('from STRIPE_WEBHOOK_SECRET'), expect.any(String)],
    })
    // then the stored one (for this Stripe mode)
    const deps = setupDeps(h, { stripe: s.api, env: { STRIPE_SECRET_KEY: 'sk_test_setupkey0123' } })
    await setSecretSetting(h.db, deps.config.TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret('test'), 'whsec_stored_0123456789')
    const ok = await webhookCheck(deps)
    expect(ok).toMatchObject({ status: 'ok', details: [expect.stringContaining('stored (encrypted)'), expect.any(String)] })
    expect(JSON.stringify(ok)).not.toContain('whsec_stored')
    s.state.endpoints[0]!.enabledEvents = ['checkout.session.completed', 'charge.refunded']
    expect(await webhookCheck(deps)).toMatchObject({ status: 'attention', summary: 'The endpoint does not send exactly the events the app handles.' })
    expect(await webhookCheck(setupDeps(h, { stripe: s.api, env: { APP_URL: 'http://localhost:3000' } }))).toMatchObject({ status: 'attention', summary: expect.stringContaining('https') })
  })

  it('checks the customer portal and notes the add-on limit', async () => {
    const s = createFakeStripe()
    expect(await portalCheck(setupDeps(h, { stripe: s.api }))).toMatchObject({ status: 'attention', action: { id: 'setup_billing_portal' } })
    s.state.portals.push({ id: 'bpc_default', active: true, isDefault: true, managedBySetup: false, cancelEnabled: true, cancelMode: 'immediately', paymentMethodUpdate: true, invoiceHistory: true, subscriptionUpdate: false })
    expect((await portalCheck(setupDeps(h, { stripe: s.api }))).status).toBe('attention')
    s.state.portals[0]!.cancelMode = 'at_period_end'
    const ok = await portalCheck(setupDeps(h, { stripe: s.api }))
    expect(ok).toMatchObject({ status: 'ok', details: [expect.stringContaining('add-ons')] })
  })
})

describe('g. transcription', () => {
  it('shows TEST MODE for the fake engine', async () => {
    expect(await transcriptionCheck(setupDeps(h))).toMatchObject({ status: 'attention', summary: expect.stringContaining('TEST MODE') })
  })

  it('reports each engine from the health check', async () => {
    const env = { TRANSCRIPTION_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'aai-key-0123456789abcdef' }
    const ok = await transcriptionCheck(setupDeps(h, { env, transcriptionHealth: async () => [{ engine: 'assemblyai', ok: true, detail: 'AssemblyAI accepted the API key.' }] }))
    expect(ok).toMatchObject({ status: 'ok', summary: 'AssemblyAI ready (TRANSCRIPTION_PROVIDER=assemblyai).' })
    const bad = await transcriptionCheck(setupDeps(h, { env, transcriptionHealth: async () => [{ engine: 'assemblyai', ok: false, detail: 'AssemblyAI refused ASSEMBLYAI_API_KEY.' }] }))
    expect(bad).toMatchObject({ status: 'attention', summary: 'AssemblyAI refused ASSEMBLYAI_API_KEY.', fix: expect.stringContaining('ASSEMBLYAI_API_KEY') })
  })

  it('does not fail a chain because Whisper sits on Railway’s private network', async () => {
    const env = { TRANSCRIPTION_PROVIDER: 'chain', WHISPER_URL: 'http://whisper.railway.internal:8000/v1', ASSEMBLYAI_API_KEY: 'aai-key-0123456789abcdef' }
    const check = await transcriptionCheck(
      setupDeps(h, {
        env,
        transcriptionHealth: async () => [
          { engine: 'whisper', ok: false, detail: 'The Whisper server could not be reached at WHISPER_URL.' },
          { engine: 'assemblyai', ok: true, detail: 'AssemblyAI accepted the API key.' },
        ],
      }),
    )
    expect(check.status).toBe('ok')
    expect(check.details?.[0]).toContain('private network')
  })

  it('the default health check calls the real adapters through the injected fetch', async () => {
    const { setupDepsFromRuntime } = await import('@/lib/server/setup/deps')
    const fetchMock = vi.fn(async () => json({ transcripts: [] }))
    h.install({ fetch: fetchMock as unknown as typeof fetch })
    try {
      const deps = setupDepsFromRuntime(h.rt)
      const result = await deps.transcriptionHealth({ ...deps.config, TRANSCRIPTION_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'aai-key-0123456789abcdef' })
      expect(result).toEqual([{ engine: 'assemblyai', ok: true, detail: 'AssemblyAI accepted the API key.' }])
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/v2/transcript?limit=1')
    } finally {
      h.install()
    }
  })
})

describe('h. workers', () => {
  it('not running → not set; fresh heartbeat → OK; stale → attention', async () => {
    let [posting, media] = await workerChecks(setupDeps(h))
    expect(posting).toMatchObject({ status: 'unset', summary: expect.stringContaining('Not running') })
    expect(media?.status).toBe('unset')

    await workerHeartbeats.beat(h.db, { workerId: 'posting-1', types: ['posting'], version: 'abc123def456' })
    await workerHeartbeats.beat(h.db, { workerId: 'media-1', types: ['media'] })
    await h.db.query(`update public.worker_heartbeats set last_seen_at = now() - interval '2 hours' where worker_id = 'media-1'`)
    ;[posting, media] = await workerChecks(setupDeps(h))
    expect(posting).toMatchObject({ status: 'ok', summary: expect.stringMatching(/^Last seen \d+ seconds? ago \(version abc123def456\)\.$/) })
    expect(media).toMatchObject({ status: 'attention', summary: 'Last seen 2 hours ago: it has stopped.' })
  })
})

describe('i. email and legal pages', () => {
  it('not set → placeholders; set → OK with links; malformed values → attention', () => {
    const [support, pages] = legalChecks(setupDeps(h))
    expect(support).toMatchObject({ status: 'unset' })
    expect(pages).toMatchObject({ status: 'unset', summary: expect.stringContaining('LEGAL_ENTITY_NAME'), links: expect.arrayContaining([{ href: '/privacy', label: 'Privacy policy' }, { href: '/terms', label: 'Terms' }]) })
    const env = { SUPPORT_EMAIL: 'help@example.com', LEGAL_ENTITY_NAME: 'Acme Studio LLC', LEGAL_JURISDICTION: 'the State of Delaware, United States', LEGAL_EFFECTIVE_DATE: '2026-11-01' }
    expect(legalChecks(setupDeps(h, { env })).map((c) => c.status)).toEqual(['ok', 'ok'])
    const odd = legalChecks(setupDeps(h, { env: { ...env, SUPPORT_EMAIL: 'help at example', LEGAL_EFFECTIVE_DATE: 'November' } }))
    expect(odd.map((c) => c.status)).toEqual(['attention', 'attention'])
  })
})

describe('j. connect', () => {
  it('shows the MCP URL and the Claude Code command to copy', () => {
    const check = connectCheck(setupDeps(h))
    expect(check).toMatchObject({ status: 'ok', summary: `${PROD_URL}/api/mcp` })
    expect(check.copies).toEqual([
      { label: 'Copy MCP URL', value: `${PROD_URL}/api/mcp` },
      { label: 'Copy Claude Code command', value: `claude mcp add --transport http clipcast ${PROD_URL}/api/mcp` },
    ])
    expect(check.details?.join(' ')).toMatch(/Claude: Settings → Connectors[\s\S]*ChatGPT: Settings → Apps & Connectors/)
  })
})

describe('runSetupChecks', () => {
  it('runs every group, counts statuses, and never shows a configured secret', async () => {
    const secrets = {
      STRIPE_SECRET_KEY: 'sk_test_SUPERSECRET_0123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_SUPERSECRET_0123456789',
      SUPABASE_URL: 'https://abcd.supabase.co',
      SUPABASE_ANON_KEY: 'anon-SUPERSECRET-0123456789',
      UPLOAD_POST_WEBHOOK_SECRET: 'up-SUPERSECRET-0123456789',
      ...R2_ENV,
    }
    const s = createFakeStripe()
    const r2 = scriptedR2()
    // a misbehaving service echoes a secret back: the report still hides it
    s.api.account.mockResolvedValueOnce({ ...s.state.account, businessName: `Acme ${secrets.STRIPE_SECRET_KEY}` })
    const report = await runSetupChecks(setupDeps(h, { env: secrets, stripe: s.api, storage: r2.storage, fetch: (async () => json({})) as unknown as typeof fetch }))
    expect(report.groups.map((g) => g.id)).toEqual(['basics', 'database', 'auth', 'storage', 'posting', 'billing', 'transcription', 'workers', 'legal', 'connect'])
    expect(report.testMode).toBe(true)
    const total = report.groups.reduce((n, g) => n + g.checks.length, 0)
    expect(report.counts.ok + report.counts.attention + report.counts.unset).toBe(total)
    const text = JSON.stringify(report)
    for (const value of [...Object.values(secrets).filter((v) => v.includes('SECRET')), 'test-session-secret-0123456789abcdef', 'cron-secret-0123456789abcdef', 'r2-secret-for-setup-tests']) {
      expect(text).not.toContain(value)
    }
    expect(text).toContain('[hidden]')
  })

  it('turns a check that throws or hangs into “Needs attention” without hiding the others', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const s = createFakeStripe()
      s.api.listWebhookEndpoints.mockImplementation(() => new Promise(() => undefined))
      s.api.listPortalConfigurations.mockRejectedValue(new Error('boom'))
      const running = runSetupChecks(setupDeps(h, { stripe: s.api }))
      await vi.advanceTimersByTimeAsync(13_000)
      const report = await running
      const billing = report.groups.find((g) => g.id === 'billing')?.checks ?? []
      expect(byId(billing, 'stripe.webhook')).toMatchObject({ status: 'attention', summary: expect.stringContaining('took too long') })
      expect(byId(billing, 'stripe.portal')).toMatchObject({ status: 'attention', summary: 'This check failed: unexpected error' })
      expect(byId(billing, 'stripe.key').status).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })
})
