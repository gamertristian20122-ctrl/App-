import { describe, expect, it, vi } from 'vitest'
import type { Config } from '@app/core/config'
import { TEST_SESSION_SECRET } from '@app/core/testing'
import { users as usersRepo } from '@app/db'
import { createServicesFromEnv, resolveServicesConfig, servicesConfigFromAppConfig } from '../src'
import { openDbFromConfig, pgliteDirFromUrl } from '../src/wiring'

const baseEnv = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  APP_URL: 'http://localhost:3000/',
  LOG_LEVEL: 'error',
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: TEST_SESSION_SECRET,
  POSTING_PROVIDER: 'fake',
  STORAGE_DRIVER: 'memory',
  TRANSCRIPTION_PROVIDER: 'fake',
}

describe('createServicesFromEnv', () => {
  it('builds every port from the environment (PGlite via DATABASE_URL=pglite:)', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    const rt = await createServicesFromEnv(baseEnv, { fetch })
    try {
      expect(rt.db.driver).toBe('pglite')
      expect(rt.provider.name).toBe('fake')
      expect(rt.transcriber?.name).toBe('fake')
      expect(rt.config.APP_URL).toBe('http://localhost:3000')
      // the migrated schema works end to end
      const id = '0f0f0f0f-0000-4000-8000-0000000000aa'
      await usersRepo.devEnsureAuthUser(rt.db, id, 'w@example.test')
      const user = await rt.services.users.ensureUser(id, { email: 'w@example.test' })
      expect(user.subscriptionStatus).toBe('trialing')
      const brand = await rt.services.brands.create(id, { name: 'Wired' })
      expect(brand.providerProfileRef).toMatch(/^fake_brand_/)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await rt.close()
    }
  })

  it('selects Upload-Post and skips the transcriber on request, without network at build time', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    const rt = await createServicesFromEnv(
      { ...baseEnv, POSTING_PROVIDER: 'upload_post', UPLOAD_POST_API_KEY: 'test-key-not-real', STRIPE_PRICE_PLUS: 'price_PLUS1234' },
      { fetch, withoutTranscriber: true },
    )
    try {
      expect(rt.provider.name).toBe('upload_post')
      expect(rt.transcriber).toBeNull()
      expect(rt.services.deps.config.stripePrices).toEqual({ plus: 'price_PLUS1234' })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await rt.close()
    }
  })

  it('refuses invalid configuration and PGlite in production', async () => {
    await expect(createServicesFromEnv({ ...baseEnv, POSTING_PROVIDER: 'upload_post' })).rejects.toThrow(/UPLOAD_POST_API_KEY/)
    await expect(openDbFromConfig({ DATABASE_URL: 'pglite:memory', APP_ENV: 'production' } as unknown as Config)).rejects.toThrow(/Postgres URL in production/)
  })

  it('parses pglite URLs', () => {
    expect(pgliteDirFromUrl('pglite:')).toBe('memory')
    expect(pgliteDirFromUrl('pglite:memory')).toBe('memory')
    expect(pgliteDirFromUrl('pglite://.data/pg')).toBe('.data/pg')
    expect(pgliteDirFromUrl('postgres://u:p@h/db')).toBeNull()
  })
})

describe('services config', () => {
  it('defaults, clamps, and caps the approval nonce lifetime at 24 h', () => {
    const c = resolveServicesConfig({ appUrl: 'https://x.test///', maxClipsPerRequest: 99 })
    expect(c.appUrl).toBe('https://x.test')
    expect(c.maxClipsPerRequest).toBe(30)
    expect(c.approvalNonceTtlSec).toBe(86_400)
    const fromApp = servicesConfigFromAppConfig(
      { APP_URL: 'https://app.test', APPROVAL_NONCE_TTL_SEC: 7 * 86_400 } as unknown as Config,
      { STRIPE_PRICE_PRO: 'price_PRO12345', STRIPE_PRICE_STARTER: 'not-a-price' },
    )
    expect(fromApp.approvalNonceTtlSec).toBe(86_400)
    expect(fromApp.stripePrices).toEqual({ pro: 'price_PRO12345' })
    // validated config values (core loadConfig) win over the raw env
    const fromConfig = servicesConfigFromAppConfig(
      { APP_URL: 'https://app.test', APPROVAL_NONCE_TTL_SEC: 3_600, STRIPE_PRICE_PLUS: 'price_PLUSCFG1' } as unknown as Config,
      { STRIPE_PRICE_PLUS: 'price_PLUSENV1' },
    )
    expect(fromConfig.stripePrices).toEqual({ plus: 'price_PLUSCFG1' })
  })
})
