// The job queue as the runner sees it: claim / complete / fail / release / extend lease / requeue
// stale. Backed by services.jobs (validation, scrubbed errors, attempts, dead after max_attempts),
// with every time taken from the app clock.

import type { Clock, JobRow, JobType } from '@app/core'
import type { Db } from '@app/db'
import type { Services } from '@app/services'

export interface ClaimRequest {
  workerId: string
  types: readonly JobType[]
  leaseSec: number
  limit: number
}

export interface JobQueue {
  claim(request: ClaimRequest): Promise<JobRow[]>
  /** False when this worker no longer holds the job. */
  complete(jobId: string, workerId: string, result: unknown): Promise<boolean>
  /** The updated row (`failed` with a later run_at, or `dead`), or null when the lease was lost. */
  fail(jobId: string, workerId: string, error: unknown, options: { retryInMs?: number; permanent?: boolean }): Promise<JobRow | null>
  /** Puts a running job back without using up its attempt (graceful shutdown). */
  release(jobId: string, workerId: string): Promise<boolean>
  /** False when the lease was lost (the job was requeued and maybe claimed by another worker). */
  extendLease(jobId: string, workerId: string, leaseSec: number): Promise<boolean>
  /** Expired leases (crashed workers) → retry now, or dead when out of attempts. */
  requeueStale(): Promise<{ requeued: number; dead: number }>
}

export interface ServicesQueueDeps {
  services: Pick<Services, 'jobs'>
  /** Unused (kept for callers that pass it); every call goes through services.jobs. */
  db?: Db
  clock: Clock
}

/** The production queue: services.jobs on the app database, times from the app clock. */
export function createServicesQueue({ services, clock }: ServicesQueueDeps): JobQueue {
  return {
    async claim(request) {
      return services.jobs.claim({ ...request, now: clock.now() })
    },
    async complete(jobId, workerId, result) {
      return (await services.jobs.complete(jobId, workerId, result === undefined ? null : result)) !== null
    },
    async fail(jobId, workerId, error, options) {
      return services.jobs.fail(jobId, workerId, error, { ...options, now: clock.now() })
    },
    async release(jobId, workerId) {
      return services.jobs.release(jobId, workerId, clock.now())
    },
    async extendLease(jobId, workerId, leaseSec) {
      return services.jobs.extendLease(jobId, workerId, leaseSec, clock.now())
    },
    async requeueStale() {
      return services.jobs.requeueStale(clock.now())
    },
  }
}
