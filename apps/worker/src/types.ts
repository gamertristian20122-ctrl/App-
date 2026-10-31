import type { Clock, Config, JobRow, Logger, ObjectStorage, PostingProvider, Transcriber } from '@app/core'
import type { Db } from '@app/db'
import type { Services } from '@app/services'

export type { JobRow }

/**
 * What every job handler receives besides the job: the services (all business rules) plus the
 * raw ports a handler needs (provider, storage, transcriber), config, logger, clock, worker id and
 * scratch directory. The runner passes a per-job copy whose `signal` aborts when the job loses its
 * lease or the worker shuts down, and whose `logger` carries the job id and type.
 */
export interface WorkerContext {
  workerId: string
  logger: Logger
  /** Same logger as `logger` (short alias). */
  log: Logger
  clock: Clock
  /** Aborted when the job lost its lease or the worker is shutting down. */
  signal?: AbortSignal
  services: Services
  provider: PostingProvider
  storage: ObjectStorage
  transcriber: Transcriber
  config: Config
  db: Db
  /** Absolute scratch directory for media work (MEDIA_TMP_DIR). */
  tmpDir: string
}

/** A job handler. Its resolved value is stored in jobs.result; throwing fails the attempt (retried with backoff). */
export type Handler = (job: JobRow, ctx: WorkerContext) => Promise<unknown>
