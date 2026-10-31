import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONFIG_KEYS, loadConfig, requireConfig, withHostDefaults } from '../src/config'
import { AppError } from '../src/errors'
import { TEST_TOKEN_ENCRYPTION_KEYS, testConfig } from '../src/testing'

const prodEnv = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  APP_URL: 'https://app.example.com/',
  DATABASE_URL: 'postgres://u:p@db:5432/app',
  TOKEN_ENCRYPTION_KEYS: TEST_TOKEN_ENCRYPTION_KEYS,
  SESSION_SECRET: 'x'.repeat(40),
  POSTING_PROVIDER: 'upload_post',
  UPLOAD_POST_API_KEY: 'up-key',
  STORAGE_DRIVER: 'r2',
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'media',
  TRANSCRIPTION_PROVIDER: 'chain',
  WHISPER_URL: 'https://whisper.internal/v1',
  ASSEMBLYAI_API_KEY: 'aai',
}

function errorOf(env: Record<string, string | undefined>): AppError {
  try {
    loadConfig(env)
  } catch (e) {
    return e as AppError
  }
  throw new Error('expected loadConfig to throw')
}

describe('loadConfig', () => {
  it('defaults to a local development setup', () => {
    const c = loadConfig({})
    expect(c).toMatchObject({
      NODE_ENV: 'development',
      APP_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      MCP_RESOURCE_URL: 'http://localhost:3000/api/mcp',
      LOG_LEVEL: 'info',
      DEV_AUTH: false,
      POSTING_PROVIDER: 'fake',
      STORAGE_DRIVER: 'fs',
      TRANSCRIPTION_PROVIDER: 'fake',
      WORKER_TYPES: ['posting', 'media'],
      WORKER_CONCURRENCY: 2,
      OAUTH_ACCESS_TOKEN_TTL_SEC: 3600,
    })
    expect(Object.isFrozen(c)).toBe(true)
  })

  it('accepts a full production config and derives URLs', () => {
    const c = loadConfig(prodEnv)
    expect(c.APP_URL).toBe('https://app.example.com')
    expect(c.MCP_RESOURCE_URL).toBe('https://app.example.com/api/mcp')
    expect(c.R2_ENDPOINT).toBe('https://acc.r2.cloudflarestorage.com')
  })

  it('treats empty strings as unset and coerces numbers and flags', () => {
    const c = loadConfig({ DATABASE_URL: '', WORKER_CONCURRENCY: '4', DEV_AUTH: 'true', SESSION_SECRET: 's'.repeat(32), WORKER_TYPES: 'media, media' })
    expect(c.DATABASE_URL).toBeUndefined()
    expect(c.WORKER_CONCURRENCY).toBe(4)
    expect(c.DEV_AUTH).toBe(true)
    expect(c.WORKER_TYPES).toEqual(['media'])
    expect(loadConfig({ DEV_AUTH: '0' }).DEV_AUTH).toBe(false)
  })

  it('production refuses dev settings and missing secrets', () => {
    const e = errorOf({ ...prodEnv, DEV_AUTH: '1', DATABASE_URL: undefined, POSTING_PROVIDER: 'fake', APP_URL: 'http://x.test' })
    expect(e).toBeInstanceOf(AppError)
    expect(e.message).toContain('DEV_AUTH must be off in production.')
    expect(e.message).toContain('DATABASE_URL is required in production.')
    expect(e.message).toContain('POSTING_PROVIDER=fake is not allowed in production.')
    expect(e.message).toContain('APP_URL must be https in production.')
  })

  it('requires the variables of the selected drivers', () => {
    const e = errorOf({ POSTING_PROVIDER: 'upload_post', STORAGE_DRIVER: 'r2', TRANSCRIPTION_PROVIDER: 'chain', DEV_AUTH: '1' })
    for (const key of ['UPLOAD_POST_API_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ACCOUNT_ID', 'WHISPER_URL', 'ASSEMBLYAI_API_KEY', 'SESSION_SECRET']) {
      expect(e.message).toContain(key)
    }
    expect(e.details?.keys).toEqual(expect.arrayContaining(['UPLOAD_POST_API_KEY', 'SESSION_SECRET']))
  })

  it('rejects bad values without echoing them', () => {
    const e = errorOf({ TOKEN_ENCRYPTION_KEYS: 'v1:c2VjcmV0', LOG_LEVEL: 'loud', WORKER_TYPES: 'gpu', SESSION_SECRET: 'tooshort-secret' })
    expect(e.message).toContain('TOKEN_ENCRYPTION_KEYS')
    expect(e.message).toContain('LOG_LEVEL')
    expect(e.message).toContain('WORKER_TYPES')
    expect(e.message).toContain('SESSION_SECRET')
    expect(e.message).not.toContain('c2VjcmV0')
    expect(e.message).not.toContain('tooshort-secret')
  })

  it('lists every key', () => {
    expect(CONFIG_KEYS).toEqual(expect.arrayContaining(['DATABASE_URL', 'TOKEN_ENCRYPTION_KEYS', 'UPLOAD_POST_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'CRON_SECRET', 'WORKER_TYPES']))
  })
})

describe('requireConfig', () => {
  it('returns the config when keys are present and throws unavailable otherwise', () => {
    const c = testConfig({ STRIPE_SECRET_KEY: 'sk_test_x' })
    expect(requireConfig(c, ['STRIPE_SECRET_KEY']).STRIPE_SECRET_KEY).toBe('sk_test_x')
    let err: unknown
    try {
      requireConfig(c, ['STRIPE_WEBHOOK_SECRET'])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('unavailable')
    expect((err as AppError).message).toContain('STRIPE_WEBHOOK_SECRET')
  })
})

describe('optional billing and provider keys', () => {
  it('accepts Stripe price ids and a profile prefix, and refuses malformed ones by name', () => {
    const c = loadConfig({ STRIPE_PRICE_PRO: 'price_ABC123xyz', UPLOAD_POST_PROFILE_PREFIX: 'stg_' })
    expect(c.STRIPE_PRICE_PRO).toBe('price_ABC123xyz')
    expect(c.STRIPE_PRICE_PLUS).toBeUndefined()
    expect(c.UPLOAD_POST_PROFILE_PREFIX).toBe('stg_')
    const err = errorOf({ STRIPE_PRICE_STARTER: 'prod_123456', UPLOAD_POST_PROFILE_PREFIX: 'bad prefix!' })
    expect(err.message).toContain('STRIPE_PRICE_STARTER')
    expect(err.message).toContain('UPLOAD_POST_PROFILE_PREFIX')
    expect(err.message).not.toContain('prod_123456')
  })
})

describe('owner and legal keys', () => {
  it('are empty by default', () => {
    const c = loadConfig({})
    for (const key of ['OWNER_EMAIL', 'SUPPORT_EMAIL', 'LEGAL_ENTITY_NAME', 'LEGAL_JURISDICTION', 'LEGAL_EFFECTIVE_DATE'] as const) {
      expect(c[key]).toBeUndefined()
    }
    expect(loadConfig({ SUPPORT_EMAIL: '   ' }).SUPPORT_EMAIL).toBeUndefined()
  })

  it('trims them, lower-cases the owner email and never fails on odd values', () => {
    const c = loadConfig({
      OWNER_EMAIL: '  Owner@Example.COM ',
      SUPPORT_EMAIL: ' help@example.com ',
      LEGAL_ENTITY_NAME: 'Acme\nStudio LLC',
      LEGAL_JURISDICTION: 'the State of Delaware, United States',
      LEGAL_EFFECTIVE_DATE: 'not a date',
    })
    expect(c.OWNER_EMAIL).toBe('owner@example.com')
    expect(c.SUPPORT_EMAIL).toBe('help@example.com')
    expect(c.LEGAL_ENTITY_NAME).toBe('Acme Studio LLC')
    expect(c.LEGAL_EFFECTIVE_DATE).toBe('not a date')
    expect(loadConfig({ LEGAL_ENTITY_NAME: 'x'.repeat(500) }).LEGAL_ENTITY_NAME).toHaveLength(200)
  })
})

describe('.env.example', () => {
  const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
  const env = Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )

  it('documents every config key and nothing else', () => {
    expect(Object.keys(env).sort()).toEqual([...CONFIG_KEYS].sort())
  })

  it('parses as a valid development config', () => {
    expect(() => loadConfig(env)).not.toThrow()
  })
})

describe('withHostDefaults', () => {
  it('uses the Vercel production domain when APP_URL is empty', () => {
    expect(withHostDefaults({ VERCEL_PROJECT_PRODUCTION_URL: 'clipcast.vercel.app' }).APP_URL).toBe('https://clipcast.vercel.app')
    expect(withHostDefaults({ APP_URL: '', VERCEL_PROJECT_PRODUCTION_URL: 'clipcast.vercel.app' }).APP_URL).toBe(
      'https://clipcast.vercel.app',
    )
  })

  it('keeps an explicit APP_URL, and changes nothing off Vercel', () => {
    expect(withHostDefaults({ APP_URL: 'https://app.example.com', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }).APP_URL).toBe(
      'https://app.example.com',
    )
    expect(withHostDefaults({}).APP_URL).toBeUndefined()
  })

  it('is applied by loadConfig', () => {
    const c = loadConfig({ ...testConfigEnv(), APP_URL: '', VERCEL_PROJECT_PRODUCTION_URL: 'clipcast.vercel.app' })
    expect(c.APP_URL).toBe('https://clipcast.vercel.app')
    expect(c.MCP_RESOURCE_URL).toBe('https://clipcast.vercel.app/api/mcp')
  })
})

function testConfigEnv(): Record<string, string> {
  return { TOKEN_ENCRYPTION_KEYS: TEST_TOKEN_ENCRYPTION_KEYS, SESSION_SECRET: 'x'.repeat(40) }
}
