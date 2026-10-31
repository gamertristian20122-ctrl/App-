import type { Clock, JobRow, Logger } from '@app/core'

export type { JobRow }

/**
 * What every job handler receives besides the job. Placeholder: the worker agent extends it
 * (services, storage, provider, transcriber, config, scratch dir, abort signal, ...).
 */
export interface WorkerContext {
  workerId: string
  logger: Logger
  clock: Clock
  signal?: AbortSignal
}

/** A job handler. Its resolved value is stored in jobs.result; throwing fails the attempt (retried with backoff). */
export type Handler = (job: JobRow, ctx: WorkerContext) => Promise<unknown>
