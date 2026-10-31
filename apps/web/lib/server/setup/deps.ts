// What the /setup checks and actions run against: the configuration, the database, the ports the
// services runtime already built (storage, posting provider), a Stripe admin client, fetch (for
// Supabase) and the transcription health check. Built from the runtime, overridable for tests
// through setServerOverridesForTests. Server-only.

import type { Config } from '@app/core/config'
import type { Logger } from '@app/core/log'
import type { ObjectStorage, PostingProvider } from '@app/core/ports'
import type { Db } from '@app/db'
import { transcriptionHealthFromConfig, type EngineHealth, type Services, type ServicesFromEnv } from '@app/services'
import { serverOverrides } from '../deps'
import { getStripeAdmin, type StripeAdminApi } from '../stripe-admin'

export interface SetupDeps {
  config: Config
  db: Db
  services: Services
  storage: ObjectStorage
  provider: PostingProvider
  /** null when STRIPE_SECRET_KEY is not set. */
  stripe: StripeAdminApi | null
  fetch: typeof fetch
  transcriptionHealth: (config: Config) => Promise<EngineHealth[]>
  now: () => Date
  log: Logger
}

export function setupDepsFromRuntime(rt: ServicesFromEnv): SetupDeps {
  const o = serverOverrides()
  const fetchFn: typeof fetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
  return {
    config: rt.config,
    db: rt.db,
    services: rt.services,
    storage: rt.storage,
    provider: rt.provider,
    stripe: getStripeAdmin(rt.config),
    fetch: fetchFn,
    transcriptionHealth: o.transcriptionHealth ?? ((config) => transcriptionHealthFromConfig(config, { fetch: fetchFn })),
    now: () => rt.clock.now(),
    log: rt.log,
  }
}
