// What the web app's route handlers, pages and server actions run against: the services runtime
// (lib/services.ts), the environment, a Stripe API client and the fetch used for Supabase Auth.
// Everything is overridable in one place for tests (setServerOverridesForTests), so route tests
// can run against PGlite-backed services, a fake Stripe and mocked HTTP without touching
// lib/services.ts or the network. Server-only.

import type { Config, EnvSource } from '@app/core/config'
import type { EngineHealth, ServicesFromEnv } from '@app/services'
import type { AuthDeps } from '@/lib/auth'
import { getServicesRuntime } from '@/lib/services'
import type { StripeApi } from './stripe'
import type { StripeAdminApi } from './stripe-admin'

export interface ServerOverrides {
  /** A prebuilt runtime (tests: createServicesFromEnv(env, { db: PGlite, provider: fake, ... })). */
  runtime?: ServicesFromEnv
  /** Environment for auth helpers and feature flags (default process.env). */
  env?: EnvSource
  /** Stripe API client; null = Stripe is not configured. Default: built from STRIPE_SECRET_KEY. */
  stripe?: StripeApi | null
  /** fetch used for Supabase Auth calls and the /setup checks (tests: a mock). */
  fetch?: typeof fetch
  /** Stripe account setup API for /setup; null = Stripe is not configured. Default: from STRIPE_SECRET_KEY. */
  stripeAdmin?: StripeAdminApi | null
  /** Transcription health for /setup (tests: a stub). Default: one cheap call per configured engine. */
  transcriptionHealth?: (config: Config) => Promise<EngineHealth[]>
}

const KEY = Symbol.for('app.web.server.overrides')

function holder(): { overrides: ServerOverrides | null } {
  const g = globalThis as typeof globalThis & { [KEY]?: { overrides: ServerOverrides | null } }
  g[KEY] ??= { overrides: null }
  return g[KEY]
}

/** Tests only: install overrides (or reset with null). Never used by application code. */
export function setServerOverridesForTests(overrides: ServerOverrides | null): void {
  holder().overrides = overrides
}

export function serverOverrides(): ServerOverrides {
  return holder().overrides ?? {}
}

/** The services runtime (services, config, db, storage, clock, log). */
export async function getRuntime(): Promise<ServicesFromEnv> {
  return serverOverrides().runtime ?? getServicesRuntime()
}

/** The environment the auth helpers read (DEV_AUTH, SESSION_SECRET, SUPABASE_*). */
export function serverEnv(): EnvSource {
  return serverOverrides().env ?? process.env
}

/** Dependencies for lib/auth.ts (env + the injectable fetch for Supabase). */
export function authDeps(): AuthDeps {
  const o = serverOverrides()
  return { env: serverEnv(), ...(o.fetch ? { fetch: o.fetch } : {}) }
}

/** fetch for Supabase clients built in this layer (undefined = global fetch). */
export function supabaseFetch(): typeof fetch | undefined {
  return serverOverrides().fetch
}
