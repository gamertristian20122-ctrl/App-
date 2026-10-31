// Shared pieces for the /setup tests: SetupDeps over a PGlite-backed runtime (fake posting,
// memory storage), an R2Storage over a scripted S3 client, and a fetch mock. Nothing touches the
// network.

import { vi } from 'vitest'
import { loadConfig, type Config } from '@app/core/config'
import { silentLogger } from '@app/core/log'
import type { ObjectStorage, PostingProvider } from '@app/core/ports'
import { TEST_TOKEN_ENCRYPTION_KEYS } from '@app/core/testing'
import type { EngineHealth } from '@app/services'
import { R2Storage } from '@app/storage'
import type { SetupDeps } from '@/lib/server/setup/deps'
import type { StripeAdminApi } from '@/lib/server/stripe-admin'
import type { Harness } from '../api/harness'

export const PROD_URL = 'https://app.example.com'

export function config(env: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    APP_ENV: 'test',
    NODE_ENV: 'test',
    APP_URL: PROD_URL,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    TOKEN_ENCRYPTION_KEYS: TEST_TOKEN_ENCRYPTION_KEYS,
    CRON_SECRET: 'cron-secret-0123456789abcdef',
    POSTING_PROVIDER: 'fake',
    STORAGE_DRIVER: 'memory',
    TRANSCRIPTION_PROVIDER: 'fake',
    LOG_LEVEL: 'error',
    ...env,
  })
}

export interface DepsOptions {
  env?: Record<string, string | undefined>
  stripe?: StripeAdminApi | null
  storage?: ObjectStorage
  provider?: PostingProvider
  fetch?: typeof fetch
  transcriptionHealth?: (config: Config) => Promise<EngineHealth[]>
}

export function setupDeps(h: Harness, options: DepsOptions = {}): SetupDeps {
  const c = config(options.env)
  return {
    config: c,
    db: h.rt.db,
    services: h.rt.services,
    storage: options.storage ?? h.rt.storage,
    provider: options.provider ?? h.rt.provider,
    stripe: options.stripe === undefined ? null : options.stripe,
    fetch: options.fetch ?? (vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch),
    transcriptionHealth: options.transcriptionHealth ?? (async () => [{ engine: 'fake', ok: true, detail: 'Test mode.' }]),
    now: () => new Date('2026-11-02T15:00:00.000Z'),
    log: silentLogger,
  }
}

export class S3Error extends Error {
  readonly $metadata: { httpStatusCode: number }
  constructor(name: string, status: number) {
    super(`${name} happened`)
    this.name = name
    this.$metadata = { httpStatusCode: status }
  }
}

type Command = { constructor: { name: string }; input: Record<string, unknown> }

/** An R2Storage whose S3 client keeps a CORS policy in memory; `fail` scripts errors per command. */
export function scriptedR2(options: { cors?: Array<Record<string, unknown>> | null; fail?: Record<string, S3Error> } = {}) {
  let cors: Array<Record<string, unknown>> | null = options.cors ?? null
  const fail = { ...options.fail }
  const send = vi.fn(async (command: Command) => {
    const name = command.constructor.name
    const error = fail[name]
    if (error) throw error
    switch (name) {
      case 'HeadBucketCommand':
        return {}
      case 'HeadObjectCommand':
        throw new S3Error('NotFound', 404)
      case 'GetBucketCorsCommand':
        if (!cors) throw new S3Error('NoSuchCORSConfiguration', 404)
        return { CORSRules: cors }
      case 'PutBucketCorsCommand':
        cors = (command.input.CORSConfiguration as { CORSRules: Array<Record<string, unknown>> }).CORSRules
        return {}
      default:
        throw new Error(`unexpected ${name}`)
    }
  })
  const storage = new R2Storage(
    { accountId: 'abc123', accessKeyId: 'AKIASETUPTEST', secretAccessKey: 'r2-secret-for-setup-tests-0123456789', bucket: 'media-bucket' },
    { client: { send } },
  )
  return { storage, send, cors: () => cors, fail }
}

export const R2_ENV = {
  STORAGE_DRIVER: 'r2',
  R2_ACCOUNT_ID: 'abc123',
  R2_ACCESS_KEY_ID: 'AKIASETUPTEST',
  R2_SECRET_ACCESS_KEY: 'r2-secret-for-setup-tests-0123456789',
  R2_BUCKET: 'media-bucket',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
