// Periodic fan-out for the posting group. Every tick (default each minute) it makes sure that:
// - a `cleanup` job exists for the current UTC hour (idempotency key per hour),
// - today's account-analytics pulls are queued (services: one job per active brand per UTC day),
// - due posts whose publish job was lost are re-queued (every few minutes).
// Idempotency keys live in the database, so any number of worker replicas can run this safely:
// the first replica creates the jobs, the others hit the existing keys.

import type { Clock, Logger } from '@app/core'
import type { Services } from '@app/services'
import { safeErrorMessage } from './errors'

export interface SchedulerOptions {
  services: Pick<Services, 'jobs' | 'analytics' | 'posts'>
  clock: Clock
  logger: Logger
  /** Tick interval. Default 60 s. */
  intervalMs?: number
  /** How often lost publish jobs are swept. Default 5 min. */
  dueSweepMs?: number
}

export interface SchedulerTick {
  cleanupQueued: boolean
  analyticsQueued: number
  duePostsQueued: number
  errors: number
}

/** "2026-11-02T12" (UTC hour bucket). */
export const hourBucket = (at: Date): string => at.toISOString().slice(0, 13)
/** "2026-11-02" (UTC day bucket). */
export const dayBucket = (at: Date): string => at.toISOString().slice(0, 10)
export const cleanupJobKey = (at: Date): string => `cleanup:hourly:${hourBucket(at)}`

export class Scheduler {
  private readonly services: SchedulerOptions['services']
  private readonly clock: Clock
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly dueSweepMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<SchedulerTick> | null = null
  private lastCleanupHour: string | null = null
  private lastAnalyticsDay: string | null = null
  private lastDueSweepMs: number | null = null

  constructor(options: SchedulerOptions) {
    this.services = options.services
    this.clock = options.clock
    this.log = options.logger.child({ component: 'scheduler' })
    this.intervalMs = Math.max(1, options.intervalMs ?? 60_000)
    this.dueSweepMs = Math.max(1, options.dueSweepMs ?? 5 * 60_000)
  }

  /** Runs one tick now, then every intervalMs. */
  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  /** Stops ticking and waits for a tick in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.running) await this.running.catch(() => undefined)
  }

  /** One pass (overlapping calls share the pass in progress). */
  tick(): Promise<SchedulerTick> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async pass(): Promise<SchedulerTick> {
    const now = this.clock.now()
    const out: SchedulerTick = { cleanupQueued: false, analyticsQueued: 0, duePostsQueued: 0, errors: 0 }

    const hour = hourBucket(now)
    if (hour !== this.lastCleanupHour) {
      try {
        const { created } = await this.services.jobs.enqueue({
          type: 'cleanup',
          payload: { task: 'all' },
          runAt: now,
          idempotencyKey: cleanupJobKey(now),
        })
        out.cleanupQueued = created
        this.lastCleanupHour = hour
      } catch (error) {
        out.errors += 1
        this.log.error('queueing cleanup failed', { error: safeErrorMessage(error) })
      }
    }

    const day = dayBucket(now)
    if (day !== this.lastAnalyticsDay) {
      try {
        out.analyticsQueued = await this.services.analytics.enqueueDailyAccountPulls(now)
        this.lastAnalyticsDay = day
        if (out.analyticsQueued > 0) this.log.info('queued daily account analytics', { jobs: out.analyticsQueued, day })
      } catch (error) {
        out.errors += 1
        this.log.error('queueing account analytics failed', { error: safeErrorMessage(error) })
      }
    }

    if (this.lastDueSweepMs === null || now.getTime() - this.lastDueSweepMs >= this.dueSweepMs) {
      try {
        out.duePostsQueued = await this.services.posts.enqueueDue(now)
        this.lastDueSweepMs = now.getTime()
        if (out.duePostsQueued > 0) this.log.warn('re-queued lost publish jobs', { jobs: out.duePostsQueued })
      } catch (error) {
        out.errors += 1
        this.log.error('sweeping due posts failed', { error: safeErrorMessage(error) })
      }
    }
    return out
  }
}
