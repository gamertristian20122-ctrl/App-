// Builds the WorkerContext every job handler receives: the services (all business rules) plus the
// raw ports a media/posting handler needs (provider, storage, transcriber), config, logger, clock,
// worker id and scratch directory. One instance per process.

import { hostname } from 'node:os'
import { resolve } from 'node:path'
import type { Config, EnvSource } from '@app/core'
import type { Clock, Logger, ObjectStorage, PostingProvider, Transcriber } from '@app/core'
import type { Db } from '@app/db'
import { createServicesFromEnv, type Services, type ServicesFromEnvOptions } from '@app/services'
import type { WorkerContext } from './types'

/** What the services wiring adds to the base WorkerContext. */
export interface WorkerServicesContext {
  services: Services
  provider: PostingProvider
  storage: ObjectStorage
  transcriber: Transcriber
  config: Config
  db: Db
  /** Same logger as `logger` (short alias). */
  log: Logger
  /** Absolute scratch directory for media work (MEDIA_TMP_DIR). */
  tmpDir: string
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
  const runtime = await createServicesFromEnv(env, wiring)
  const transcriber = runtime.transcriber
  if (!transcriber) throw new Error('The worker needs a transcriber (TRANSCRIPTION_PROVIDER).')
  const workerId = (givenId ?? runtime.config.WORKER_ID ?? `${hostname()}:${process.pid}`).slice(0, 200)
  const logger = runtime.log.child({ worker: workerId })
  const clock: Clock = runtime.clock
  return {
    workerId,
    logger,
    log: logger,
    clock,
    ...(signal ? { signal } : {}),
    services: runtime.services,
    provider: runtime.provider,
    storage: runtime.storage,
    transcriber,
    config: runtime.config,
    db: runtime.db,
    tmpDir: resolve(runtime.config.MEDIA_TMP_DIR),
    close: runtime.close,
  }
}
