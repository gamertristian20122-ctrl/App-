// Worker heartbeat: every minute this process upserts its row in worker_heartbeats (worker id,
// handler groups, version), so the owner's /setup page can say "posting worker last seen 20 seconds
// ago" or "not running". A failed beat is logged and retried on the next tick; it never stops the
// worker (for example before migration 0005 is applied). On a graceful stop the row is removed.

import type { Logger } from '@app/core'
import { workerHeartbeats, type Db, type WorkerGroupName } from '@app/db'
import { safeErrorMessage } from './errors'

export const HEARTBEAT_INTERVAL_MS = 60_000

export interface HeartbeatOptions {
  db: Db
  workerId: string
  groups: readonly WorkerGroupName[]
  /** Short build id shown on /setup (Railway's commit sha when available). */
  version?: string | null
  logger: Logger
  intervalMs?: number
}

/** The version shown on /setup: Railway's git commit (first 12 characters), if any. */
export function workerVersion(env: Readonly<Record<string, string | undefined>>): string | null {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim()
  return sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 12) : null
}

export class Heartbeat {
  private readonly db: Db
  private readonly workerId: string
  private readonly groups: WorkerGroupName[]
  private readonly version: string | null
  private readonly log: Logger
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<boolean> | null = null
  private failing = false

  constructor(options: HeartbeatOptions) {
    this.db = options.db
    this.workerId = options.workerId
    this.groups = [...new Set(options.groups)]
    this.version = options.version ?? null
    this.log = options.logger.child({ component: 'heartbeat' })
    this.intervalMs = Math.max(1, options.intervalMs ?? HEARTBEAT_INTERVAL_MS)
  }

  /** Beats now, then every intervalMs. */
  start(): void {
    if (this.timer || this.groups.length === 0) return
    void this.beat()
    this.timer = setInterval(() => void this.beat(), this.intervalMs)
    this.timer.unref?.()
  }

  /** One upsert (overlapping calls share it). Resolves false when it failed. */
  beat(): Promise<boolean> {
    this.running ??= (async () => {
      try {
        await workerHeartbeats.beat(this.db, { workerId: this.workerId, types: this.groups, version: this.version })
        if (this.failing) this.log.info('heartbeat recorded again')
        this.failing = false
        return true
      } catch (error) {
        // warn once per failure streak, not every minute
        if (!this.failing) this.log.warn('recording the heartbeat failed', { error: safeErrorMessage(error) })
        this.failing = true
        return false
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  /** Stops beating and removes this worker's row (best effort). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.running) await this.running
    try {
      await workerHeartbeats.remove(this.db, this.workerId)
    } catch (error) {
      this.log.warn('removing the heartbeat failed', { error: safeErrorMessage(error) })
    }
  }
}
