// Wires one worker process: context (services + ports), handler registry for WORKER_TYPES, the
// runner, the scheduler (posting group only), and the health endpoint. main.ts adds signals.

import { mkdir } from 'node:fs/promises'
import type { EnvSource } from '@app/core'
import { createWorkerContext, type CreateWorkerContextOptions, type FullWorkerContext } from './context'
import { safeErrorMessage } from './errors'
import { startHealthServer, type HealthServer } from './health'
import { Heartbeat, workerVersion } from './heartbeat'
import { mediaHandlers } from './media'
import { postingHandlers } from './posting'
import { createServicesQueue, type JobQueue } from './queue'
import { buildRegistry, type HandlerSets, type HandlerRegistry } from './registry'
import { Runner, type RunnerOptions } from './runner'
import { Scheduler, type SchedulerOptions } from './scheduler'

export const DEFAULT_SHUTDOWN_GRACE_MS = 25_000
/** Time kept for aborting/releasing jobs and closing connections after the grace period. */
const SHUTDOWN_RESERVE_MS = 5_000

/**
 * How long running jobs may take to finish on SIGTERM. Railway kills the process
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS after SIGTERM (railway.toml sets it), so the grace period
 * ends a few seconds before that.
 */
export function shutdownGraceMs(env: EnvSource): number {
  const raw = env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS?.trim()
  if (!raw || !/^\d{1,5}$/.test(raw)) return DEFAULT_SHUTDOWN_GRACE_MS
  return Math.max(1_000, Number(raw) * 1_000 - 2 * SHUTDOWN_RESERVE_MS)
}

export interface StartWorkerOptions extends CreateWorkerContextOptions {
  /** A prebuilt context (tests); otherwise built from env. */
  context?: FullWorkerContext
  /** Handler sets per group. Default: posting handlers + ./media handlers. */
  handlerSets?: HandlerSets
  /** Queue override (tests). Default: services.jobs. */
  queue?: JobQueue
  runner?: Partial<Omit<RunnerOptions, 'queue' | 'handlers' | 'context'>>
  /** false disables the scheduler; default: on when the posting group is enabled. */
  scheduler?: Partial<Omit<SchedulerOptions, 'services' | 'clock' | 'logger'>> | false
  /** Health port; default config.PORT (none when unset). null disables it. */
  healthPort?: number | null
  /** Heartbeat for /setup (worker_heartbeats); false disables it. Default: every 60 s. */
  heartbeat?: { intervalMs?: number } | false
}

export interface WorkerHandle {
  context: FullWorkerContext
  registry: HandlerRegistry
  runner: Runner
  scheduler: Scheduler | null
  health: HealthServer | null
  heartbeat: Heartbeat | null
  /** Graceful stop: scheduler, runner (finish or release jobs), health server, database. Idempotent. */
  stop(): Promise<void>
}

export async function startWorker(env: EnvSource = process.env, options: StartWorkerOptions = {}): Promise<WorkerHandle> {
  const {
    context: given,
    handlerSets,
    queue: givenQueue,
    runner: runnerOptions,
    scheduler: schedulerOptions,
    healthPort,
    heartbeat: heartbeatOptions,
    ...contextOptions
  } = options
  const context = given ?? (await createWorkerContext(env, contextOptions))
  const { config, logger } = context
  const groups = config.WORKER_TYPES
  const registry = buildRegistry(groups, handlerSets ?? { posting: postingHandlers, media: mediaHandlers }, logger)
  if (groups.includes('media')) await mkdir(context.tmpDir, { recursive: true })

  const runner = new Runner({
    queue: givenQueue ?? createServicesQueue({ services: context.services, db: context.db, clock: context.clock }),
    handlers: registry.handlers,
    context,
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
    shutdownGraceMs: shutdownGraceMs(env),
    ...runnerOptions,
  })
  const scheduler =
    schedulerOptions !== false && groups.includes('posting')
      ? new Scheduler({ services: context.services, clock: context.clock, logger, ...(schedulerOptions ?? {}) })
      : null

  const heartbeat =
    heartbeatOptions === false
      ? null
      : new Heartbeat({
          db: context.db,
          workerId: context.workerId,
          groups,
          version: workerVersion(env),
          logger,
          ...(heartbeatOptions?.intervalMs ? { intervalMs: heartbeatOptions.intervalMs } : {}),
        })

  await runner.start()
  scheduler?.start()
  heartbeat?.start()
  const port = healthPort === undefined ? (config.PORT ?? null) : healthPort
  let health: HealthServer | null = null
  try {
    health = port === null ? null : await startHealthServer({ port, status: () => runner.status() })
  } catch (error) {
    await heartbeat?.stop()
    await scheduler?.stop()
    await runner.stop()
    throw error
  }
  logger.info('worker started', { groups, types: registry.types, concurrency: config.WORKER_CONCURRENCY, healthPort: health?.port ?? null })

  let stopping: Promise<void> | null = null
  const stop = () => {
    stopping ??= (async () => {
      try {
        await scheduler?.stop()
        await runner.stop()
      } finally {
        // keeps beating while jobs drain, then removes this worker's row
        await heartbeat?.stop()
        await health?.close().catch((error: unknown) => logger.warn('closing the health server failed', { error: safeErrorMessage(error) }))
        if (!given) await context.close()
        logger.info('worker stopped')
      }
    })()
    return stopping
  }
  return { context, registry, runner, scheduler, health, heartbeat, stop }
}
