// Builds the WorkerContext every job handler receives: the services (all business rules) plus the
// raw ports a media/posting handler needs (provider, storage, transcriber), config, logger, clock,
// worker id and scratch directory. One instance per process.

import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { createLogger, loadConfig, type EnvSource } from '@app/core'
import { createServices, createServicesFromEnv, servicesConfigFromAppConfig, type ServicesConfig, type ServicesFromEnvOptions } from '@app/services'
import type { WorkerContext } from './types'

/**
 * Status polls the worker allows before services mark a post failed. Polls back off from 30 s to
 * 10 min, so 150 polls cover about 24 h (the services default of 60 gives up after ~9 h).
 */
export const STATUS_POLL_BUDGET = 150

/** Services settings the worker changes from the shared defaults (they only affect worker flows). */
export const WORKER_SERVICES_OVERRIDES: Readonly<Partial<ServicesConfig>> = Object.freeze({
  statusPollMaxPolls: STATUS_POLL_BUDGET,
})

/** What the worker process adds to the per-job WorkerContext. */
export interface WorkerServicesContext {
  /** Closes the database pool (call on shutdown). */
  close(): Promise<void>
}

export type FullWorkerContext = WorkerContext & WorkerServicesContext

export interface CreateWorkerContextOptions extends Omit<ServicesFromEnvOptions, 'withoutTranscriber'> {
  workerId?: string
  signal?: AbortSignal
}

export async function createWorkerContext(env: EnvSource = process.env, options: CreateWorkerContextOptions = {}): Promise<FullWorkerContext> {
  const { workerId: givenId, signal, ...wiring } = options
  // validated once here for the log level; createServicesFromEnv validates the same env again
  const logLevel = loadConfig(env).LOG_LEVEL
  const runtime = await createServicesFromEnv(env, { logger: createLogger({ name: 'worker', level: logLevel }), ...wiring })
  const transcriber = runtime.transcriber
  if (!transcriber) throw new Error('The worker needs a transcriber (TRANSCRIPTION_PROVIDER).')
  const workerId = (givenId ?? runtime.config.WORKER_ID ?? `${hostname()}:${process.pid}`).slice(0, 200)
  const logger = runtime.log.child({ worker: workerId })
  // Same ports, worker-specific knobs (see WORKER_SERVICES_OVERRIDES).
  const services = createServices({
    db: runtime.db,
    provider: runtime.provider,
    storage: runtime.storage,
    clock: runtime.clock,
    config: { ...servicesConfigFromAppConfig(runtime.config, env), ...WORKER_SERVICES_OVERRIDES },
    log: runtime.log.child({ component: 'services' }),
  })
  return {
    workerId,
    logger,
    log: logger,
    clock: runtime.clock,
    ...(signal ? { signal } : {}),
    services,
    provider: runtime.provider,
    storage: runtime.storage,
    transcriber,
    config: runtime.config,
    db: runtime.db,
    tmpDir: resolve(runtime.config.MEDIA_TMP_DIR),
    close: runtime.close,
  }
}
