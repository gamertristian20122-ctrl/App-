// Shared setup for the route tests: PGlite-backed services built from a test environment (fake
// posting provider, in-memory storage, manual clock), installed through the lib/server test seam;
// helpers for signed-in requests. Nothing here touches the network.

import { manualClock, type ManualClock } from '@app/core/time'
import { silentLogger } from '@app/core/log'
import type { Db } from '@app/db'
import { createTestDb, createTestUser, type TestUserOptions } from '@app/db/testing'
import { createServicesFromEnv, type ServicesFromEnv } from '@app/services'
import { DEV_SESSION_COOKIE, devUserId, signDevSession } from '@/lib/auth'
import { setServerOverridesForTests, type ServerOverrides } from '@/lib/server/deps'
import { resetRateLimitsForTests } from '@/lib/server/rate-limit'
import { resetUploadPostDeliveriesForTests } from '@/lib/server/upload-post-webhook'

export const BASE = 'http://localhost:3000'
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef'
export const CRON_SECRET = 'cron-secret-0123456789abcdef'
export const STRIPE_WEBHOOK_SECRET = 'whsec_test_0123456789abcdef'
export const UPLOAD_POST_SECRET = 'upload-post-webhook-secret-0123'

export type Env = Record<string, string | undefined>

export function testEnv(extra: Env = {}): Env {
  return {
    APP_ENV: 'test',
    NODE_ENV: 'test',
    APP_URL: BASE,
    DEV_AUTH: '1',
    SESSION_SECRET,
    STORAGE_DRIVER: 'memory',
    POSTING_PROVIDER: 'fake',
    TRANSCRIPTION_PROVIDER: 'fake',
    CRON_SECRET,
    STRIPE_WEBHOOK_SECRET,
    UPLOAD_POST_WEBHOOK_SECRET: UPLOAD_POST_SECRET,
    LOG_LEVEL: 'error',
    ...extra,
  }
}

export interface Harness {
  rt: ServicesFromEnv
  db: Db
  env: Env
  clock: ManualClock
  /** Re-installs the overrides (after a test swapped them). */
  install(extra?: Partial<ServerOverrides>): void
  /** Creates auth + app user for `email` (dev-login id) and returns it. */
  createUser(email: string, options?: TestUserOptions): Promise<{ id: string; email: string }>
  /** Cookie header value of a dev session for `email`. */
  cookie(email: string): string
  close(): Promise<void>
}

export async function createHarness(options: { env?: Env; overrides?: Partial<ServerOverrides> } = {}): Promise<Harness> {
  const env = testEnv(options.env)
  const db = await createTestDb()
  const clock = manualClock(new Date())
  const rt = await createServicesFromEnv(env, { db, clock, logger: silentLogger, withoutTranscriber: true })
  const install = (extra: Partial<ServerOverrides> = {}) =>
    setServerOverridesForTests({ runtime: rt, env, stripe: null, ...options.overrides, ...extra })
  install()
  resetRateLimitsForTests()
  resetUploadPostDeliveriesForTests()
  return {
    rt,
    db,
    env,
    clock,
    install,
    async createUser(email, userOptions = {}) {
      const id = devUserId(email)
      await createTestUser(db, { id, email: email.toLowerCase(), ...userOptions })
      return { id, email: email.toLowerCase() }
    },
    cookie(email) {
      return `${DEV_SESSION_COOKIE}=${signDevSession(email, SESSION_SECRET)}`
    },
    async close() {
      setServerOverridesForTests(null)
      await db.close()
    },
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  cookie?: string
  json?: unknown
  form?: Record<string, string>
}

/** A Request to our app (same-origin by default for cookie-authenticated calls). */
export function request(path: string, options: RequestOptions = {}): Request {
  const headers: Record<string, string> = { ...options.headers }
  let body: string | undefined = options.body
  if (options.json !== undefined) {
    body = JSON.stringify(options.json)
    headers['content-type'] ??= 'application/json'
  }
  if (options.form !== undefined) {
    body = new URLSearchParams(options.form).toString()
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
  }
  if (options.cookie) headers.cookie = options.cookie
  const method = options.method ?? (body !== undefined ? 'POST' : 'GET')
  return new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) })
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** Route context for dynamic segments. */
export const params = <T extends Record<string, string | string[]>>(p: T) => ({ params: Promise.resolve(p) })
