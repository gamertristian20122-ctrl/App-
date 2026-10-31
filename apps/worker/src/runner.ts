// The job runner: claims due jobs of the enabled types (FOR UPDATE SKIP LOCKED in the queue), runs
// up to `concurrency` handlers at once, renews leases of long jobs, completes or fails them
// (exponential backoff with jitter; `dead` after max_attempts, decided by the queue), requeues
// stale leases of crashed workers on start and periodically, and shuts down gracefully: stop
// claiming, let running jobs finish, then abort and release whatever is still running.

import type { JobRow, JobType, Logger } from '@app/core'
import { DEFAULT_BACKOFF, JobAbortedError, PermanentJobError, classifyFailure, safeErrorMessage, type BackoffPolicy } from './errors'
import type { JobQueue } from './queue'
import type { Handler, WorkerContext } from './types'

export interface RunnerOptions {
  queue: JobQueue
  /** Handlers by job type; only these types are claimed. */
  handlers: Partial<Record<JobType, Handler>>
  /** Base context passed to every handler (the runner adds a per-job signal and logger). */
  context: WorkerContext
  /** Jobs run at once. */
  concurrency: number
  /** Sleep between claims while the queue is empty. */
  pollIntervalMs: number
  /** Lease length per claim / renewal. Default 120 s. */
  leaseSec?: number
  /** How often a running job's lease is renewed. Default a third of the lease. */
  leaseRenewMs?: number
  /** How often expired leases are requeued. Default 60 s. */
  staleSweepMs?: number
  /** Retry delays for failed attempts. */
  backoff?: BackoffPolicy
  /** On stop: how long running jobs may take to finish before they are aborted. Default 25 s. */
  shutdownGraceMs?: number
  /** After aborting: how long handlers get to settle before their jobs are released anyway. Default 5 s. */
  abortGraceMs?: number
}

export type RunnerState = 'idle' | 'running' | 'stopping' | 'stopped'

export interface RunnerStatus {
  state: RunnerState
  workerId: string
  types: JobType[]
  concurrency: number
  active: number
  startedAt: string | null
  /** Last successful claim query (the loop is alive). */
  lastPollAt: string | null
  /** Last time at least one job was claimed. */
  lastClaimAt: string | null
  counts: { succeeded: number; failed: number; dead: number; released: number; lost: number }
}

interface ActiveJob {
  job: JobRow
  controller: AbortController
  promise: Promise<void>
  /** The lease renewal found the job taken away: drop its result. */
  leaseLost: boolean
  /** Released during shutdown while the handler was still running: drop its result. */
  released: boolean
  stopRenewal: () => void
}

const DEFAULT_LEASE_SEC = 120
const MAX_CLAIM_ERROR_SLEEP_MS = 30_000

export class Runner {
  readonly types: JobType[]
  private readonly queue: JobQueue
  private readonly handlers: Partial<Record<JobType, Handler>>
  private readonly context: WorkerContext
  private readonly log: Logger
  private readonly concurrency: number
  private readonly pollIntervalMs: number
  private readonly leaseSec: number
  private readonly leaseRenewMs: number
  private readonly staleSweepMs: number
  private readonly backoff: BackoffPolicy
  private readonly shutdownGraceMs: number
  private readonly abortGraceMs: number

  private state: RunnerState = 'idle'
  private readonly active = new Map<string, ActiveJob>()
  private loopPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private wake: (() => void) | null = null
  private stopSignal!: Promise<void>
  private resolveStop!: () => void
  private startedAt: Date | null = null
  private lastPollAt: Date | null = null
  private lastClaimAt: Date | null = null
  private readonly counts = { succeeded: 0, failed: 0, dead: 0, released: 0, lost: 0 }

  constructor(options: RunnerOptions) {
    this.queue = options.queue
    this.handlers = options.handlers
    this.types = (Object.keys(options.handlers) as JobType[]).filter((t) => typeof options.handlers[t] === 'function')
    this.context = options.context
    this.log = options.context.logger.child({ component: 'runner' })
    this.concurrency = Math.max(1, Math.floor(options.concurrency))
    this.pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs))
    this.leaseSec = Math.max(5, Math.floor(options.leaseSec ?? DEFAULT_LEASE_SEC))
    this.leaseRenewMs = Math.max(1, Math.floor(options.leaseRenewMs ?? (this.leaseSec * 1_000) / 3))
    this.staleSweepMs = Math.max(1, Math.floor(options.staleSweepMs ?? 60_000))
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 25_000)
    this.abortGraceMs = Math.max(0, options.abortGraceMs ?? 5_000)
    this.stopSignal = new Promise((resolve) => {
      this.resolveStop = resolve
    })
  }

  get workerId(): string {
    return this.context.workerId
  }

  status(): RunnerStatus {
    return {
      state: this.state,
      workerId: this.workerId,
      types: [...this.types],
      concurrency: this.concurrency,
      active: this.active.size,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastClaimAt: this.lastClaimAt?.toISOString() ?? null,
      counts: { ...this.counts },
    }
  }

  /** Starts the claim loop and the stale-lease sweeper. Returns once stale leases were requeued. */
  async start(): Promise<void> {
    if (this.state !== 'idle') throw new Error(`The runner is ${this.state}.`)
    this.state = 'running'
    this.startedAt = this.now()
    this.log.info('runner started', { types: this.types, concurrency: this.concurrency, leaseSec: this.leaseSec })
    await this.sweepStale()
    this.staleTimer = setInterval(() => void this.sweepStale(), this.staleSweepMs)
    this.loopPromise = this.loop()
  }

  /**
   * Graceful shutdown: stop claiming, wait up to shutdownGraceMs for running jobs, then abort them
   * and wait abortGraceMs; jobs still running after that are released for another worker.
   */
  stop(): Promise<void> {
    this.stopPromise ??= this.shutdown()
    return this.stopPromise
  }

  /**
   * Claims and runs due jobs until none are left or `maxJobs` ran (tests and one-off runs; do not
   * mix with start()). Returns how many jobs ran.
   */
  async drain(options: { maxJobs?: number } = {}): Promise<number> {
    const max = Math.max(1, options.maxJobs ?? 1_000)
    let ran = 0
    while (ran < max && this.state !== 'stopping' && this.state !== 'stopped') {
      const claimed = await this.claim(Math.min(this.concurrency, max - ran))
      if (claimed.length === 0) break
      await Promise.all(claimed.map((job) => this.launch(job).promise))
      ran += claimed.length
    }
    return ran
  }

  // --- loop ----------------------------------------------------------------------------------

  private async loop(): Promise<void> {
    let claimErrors = 0
    while (this.state === 'running') {
      const free = this.concurrency - this.active.size
      if (free <= 0) {
        await Promise.race([this.stopSignal, ...[...this.active.values()].map((a) => a.promise)])
        continue
      }
      let claimed: JobRow[]
      try {
        claimed = await this.claim(free)
        claimErrors = 0
      } catch (error) {
        claimErrors += 1
        this.log.error('claiming jobs failed', { error: safeErrorMessage(error), failures: claimErrors })
        await this.sleep(Math.min(MAX_CLAIM_ERROR_SLEEP_MS, this.pollIntervalMs * 2 ** Math.min(claimErrors, 10)))
        continue
      }
      if (this.state !== 'running') {
        // stop() arrived while claiming: hand the jobs straight back
        for (const job of claimed) await this.releaseJob(job)
        break
      }
      for (const job of claimed) this.launch(job)
      if (claimed.length < free) await this.sleep(this.pollIntervalMs)
    }
  }

  private async claim(limit: number): Promise<JobRow[]> {
    if (this.types.length === 0) return []
    const claimed = await this.queue.claim({ workerId: this.workerId, types: this.types, leaseSec: this.leaseSec, limit })
    const now = this.now()
    this.lastPollAt = now
    if (claimed.length > 0) this.lastClaimAt = now
    return claimed
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
    })
  }

  private async sweepStale(): Promise<void> {
    try {
      const result = await this.queue.requeueStale()
      if (result.requeued > 0 || result.dead > 0) this.log.warn('requeued jobs with expired leases', result)
    } catch (error) {
      this.log.error('requeueing stale jobs failed', { error: safeErrorMessage(error) })
    }
  }

  // --- one job -------------------------------------------------------------------------------

  private launch(job: JobRow): ActiveJob {
    const entry: ActiveJob = {
      job,
      controller: new AbortController(),
      promise: Promise.resolve(),
      leaseLost: false,
      released: false,
      stopRenewal: () => {},
    }
    this.active.set(job.id, entry)
    entry.promise = this.execute(entry).finally(() => {
      entry.stopRenewal()
      this.active.delete(job.id)
    })
    return entry
  }

  private async execute(entry: ActiveJob): Promise<void> {
    const { job, controller } = entry
    const log = this.context.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts })
    const startedMs = Date.now()
    entry.stopRenewal = this.renewLease(entry, log)
    let result: unknown
    try {
      const handler = this.handlers[job.type as JobType]
      if (!handler) throw new PermanentJobError(`This worker has no handler for ${job.type} jobs.`)
      log.debug('job started')
      result = await handler(job, { ...this.context, logger: log, log, signal: controller.signal })
    } catch (error) {
      entry.stopRenewal()
      await this.onFailure(entry, error, log, Date.now() - startedMs)
      return
    }
    entry.stopRenewal()
    if (this.dropped(entry, log)) return
    try {
      const ok = await this.queue.complete(job.id, this.workerId, result)
      if (ok) {
        this.counts.succeeded += 1
        log.info('job succeeded', { ms: Date.now() - startedMs })
      } else {
        this.counts.lost += 1
        log.warn('job finished but its lease was gone; the result was dropped', { ms: Date.now() - startedMs })
      }
    } catch (error) {
      // the lease runs out and requeueStale retries the job
      log.error('completing the job failed', { error: safeErrorMessage(error) })
    }
  }

  private async onFailure(entry: ActiveJob, error: unknown, log: Logger, ms: number): Promise<void> {
    const { job, controller } = entry
    if (this.dropped(entry, log)) return
    if (controller.signal.aborted && (this.state === 'stopping' || error instanceof JobAbortedError)) {
      await this.releaseJob(job, log)
      return
    }
    const decision = classifyFailure(error, job.attempts, this.backoff)
    try {
      const row = await this.queue.fail(job.id, this.workerId, decision.message, {
        permanent: decision.permanent,
        retryInMs: decision.retryInMs,
      })
      if (!row) {
        this.counts.lost += 1
        log.warn('job failed but its lease was gone', { error: decision.message, ms })
      } else if (row.status === 'dead') {
        this.counts.dead += 1
        log.error('job dead', { error: decision.message, attempts: row.attempts, maxAttempts: row.maxAttempts, permanent: decision.permanent, ms })
      } else {
        this.counts.failed += 1
        log.warn('job failed; retrying later', { error: decision.message, retryInMs: decision.retryInMs, runAt: row.runAt.toISOString(), ms })
      }
    } catch (failError) {
      log.error('recording the job failure failed', { error: safeErrorMessage(failError), jobError: decision.message })
    }
  }

  /** True (and logged) when the job's result must be dropped: lease lost or released at shutdown. */
  private dropped(entry: ActiveJob, log: Logger): boolean {
    if (entry.released) {
      log.warn('job settled after it was released at shutdown; outcome dropped')
      return true
    }
    if (entry.leaseLost) {
      this.counts.lost += 1
      log.warn('job settled after its lease was lost; outcome dropped')
      return true
    }
    return false
  }

  private async releaseJob(job: JobRow, log: Logger = this.log): Promise<void> {
    try {
      const ok = await this.queue.release(job.id, this.workerId)
      if (ok) this.counts.released += 1
      log.info(ok ? 'job released for another worker' : 'job release skipped (lease gone)', { jobId: job.id })
    } catch (error) {
      log.error('releasing the job failed; its lease will expire', { jobId: job.id, error: safeErrorMessage(error) })
    }
  }

  private renewLease(entry: ActiveJob, log: Logger): () => void {
    let busy = false
    let stopped = false
    const timer = setInterval(() => {
      if (busy || stopped) return
      busy = true
      this.queue
        .extendLease(entry.job.id, this.workerId, this.leaseSec)
        .then((held) => {
          if (held || stopped) return
          entry.leaseLost = true
          stop()
          log.warn('lease lost; aborting the job')
          entry.controller.abort(new JobAbortedError('The job lease was lost.'))
        })
        .catch((error: unknown) => log.warn('lease renewal failed; trying again', { error: safeErrorMessage(error) }))
        .finally(() => {
          busy = false
        })
    }, this.leaseRenewMs)
    const stop = () => {
      stopped = true
      clearInterval(timer)
    }
    return stop
  }

  // --- shutdown ------------------------------------------------------------------------------

  private async shutdown(): Promise<void> {
    if (this.state === 'idle') {
      this.state = 'stopped'
      return
    }
    this.state = 'stopping'
    this.log.info('runner stopping', { active: this.active.size })
    if (this.staleTimer) clearInterval(this.staleTimer)
    this.staleTimer = null
    this.resolveStop()
    this.wake?.()
    await this.loopPromise

    if (this.active.size > 0 && !(await this.settleWithin(this.shutdownGraceMs))) {
      this.log.warn('aborting running jobs', { active: this.active.size })
      for (const entry of this.active.values()) entry.controller.abort(new JobAbortedError('The worker is shutting down.'))
      if (!(await this.settleWithin(this.abortGraceMs))) {
        for (const entry of [...this.active.values()]) {
          entry.released = true
          entry.stopRenewal()
          await this.releaseJob(entry.job)
        }
      }
    }
    this.state = 'stopped'
    this.log.info('runner stopped', { counts: this.counts })
  }

  /** Whether every running job settled within `ms`. */
  private async settleWithin(ms: number): Promise<boolean> {
    const all = Promise.allSettled([...this.active.values()].map((a) => a.promise)).then(() => true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    try {
      return await Promise.race([all, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private now(): Date {
    return this.context.clock.now()
  }
}
