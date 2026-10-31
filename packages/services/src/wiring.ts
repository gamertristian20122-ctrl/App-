// Production wiring: builds the database, posting provider, object storage, transcriber, clock and
// logger from the environment, then the services. Used by apps/web (lib/services.ts) and
// apps/worker (src/context.ts).

import { loadConfig, type Config, type EnvSource } from '@app/core/config'
import { AppError } from '@app/core/errors'
import { createLogger, type Logger } from '@app/core/log'
import type { Clock, ObjectStorage, PostingProvider, Transcriber } from '@app/core/ports'
import { systemClock } from '@app/core/time'
import { openDb, type Db } from '@app/db'
import { createPostingProviderFromConfig } from '@app/posting'
import { createStorageFromConfig } from '@app/storage'
import { createTranscriberFromConfig } from '@app/transcription'
import { servicesConfigFromAppConfig } from './config'
import { createServices, type Services } from './services'

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ServicesFromEnvOptions {
  /** HTTP client for the provider and transcription adapters (tests pass a mock). Default: global fetch. */
  fetch?: FetchFn
  logger?: Logger
  clock?: Clock
  /** Overrides (tests, or a shared instance). */
  db?: Db
  provider?: PostingProvider
  storage?: ObjectStorage
  transcriber?: Transcriber
  /** Skip building the transcriber (the web app does not transcribe). Default false. */
  withoutTranscriber?: boolean
}

export interface ServicesFromEnv {
  services: Services
  config: Config
  db: Db
  provider: PostingProvider
  storage: ObjectStorage
  /** null when built with `withoutTranscriber`. */
  transcriber: Transcriber | null
  clock: Clock
  log: Logger
  /** Closes the database pool. */
  close(): Promise<void>
}

/** "pglite:" alone or "pglite:memory" = in memory; "pglite:<dir>" = a local data directory. */
export function pgliteDirFromUrl(url: string): string | null {
  if (!url.startsWith('pglite:')) return null
  const rest = url.slice('pglite:'.length).replace(/^\/\//, '')
  return rest === '' ? 'memory' : rest
}

export async function openDbFromConfig(config: Config): Promise<Db> {
  const url = config.DATABASE_URL
  if (url) {
    const dir = pgliteDirFromUrl(url)
    if (dir !== null) {
      if (config.APP_ENV === 'production') {
        throw new AppError('internal', 'Invalid configuration: DATABASE_URL must be a Postgres URL in production.', { keys: ['DATABASE_URL'] })
      }
      return openDb({ pgliteDataDir: dir })
    }
    return openDb({ url, poolMax: config.DATABASE_POOL_MAX })
  }
  return openDb({ pgliteDataDir: config.PGLITE_DATA_DIR })
}

/**
 * Validates the environment (loadConfig) and builds everything. Secrets stay inside the adapters;
 * nothing here logs configuration values.
 */
export async function createServicesFromEnv(
  env: EnvSource = process.env,
  options: ServicesFromEnvOptions = {},
): Promise<ServicesFromEnv> {
  const config = loadConfig(env)
  const clock = options.clock ?? systemClock
  const log = options.logger ?? createLogger({ name: 'services', level: config.LOG_LEVEL })
  const db = options.db ?? (await openDbFromConfig(config))
  const provider =
    options.provider ??
    createPostingProviderFromConfig(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      clock,
      logger: log.child({ component: 'posting' }),
    })
  const storage = options.storage ?? createStorageFromConfig(config, { logger: log.child({ component: 'storage' }), clock })
  const transcriber = options.withoutTranscriber
    ? null
    : (options.transcriber ??
      createTranscriberFromConfig(config, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        logger: log.child({ component: 'transcription' }),
      }))
  const services = createServices({
    db,
    provider,
    storage,
    clock,
    config: servicesConfigFromAppConfig(config, env),
    log: log.child({ component: 'services' }),
  })
  return {
    services,
    config,
    db,
    provider,
    storage,
    transcriber,
    clock,
    log,
    close: () => (options.db ? Promise.resolve() : db.close()),
  }
}
