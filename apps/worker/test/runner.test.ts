import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@app/core'
import { jobs as jobsRepo } from '@app/db'
import { createTestUser } from '@app/db/testing'
import { JobAbortedError, PermanentJobError, RetryJobError } from '../src/errors'
import type { Handler } from '../src/types'
import { HOUR, MINUTE, SECOND, START, createWorkerHarness, deferred, getJob, makeRunner, resetWorkerHarness, type WorkerHarness } from './helpers'

let h: WorkerHarness
beforeAll(async () => {
  h = await createWorkerHarness()
})
afterAll(async () => {
  await h.db.close()
})
beforeEach(async () => {
  await resetWorkerHarness(h)
})

const at = (ms: number) => new Date(START.getTime() + ms)
const enqueueCleanup = async (key: string, extra: { maxAttempts?: number; runAt?: Date } = {}) =>
  (await h.services.jobs.enqueue({ type: 'cleanup', payload: {}, idempotencyKey: key, runAt: extra.runAt ?? START, ...(extra.maxAttempts ? { maxAttempts: extra.maxAttempts } : {}) })).job

describe('runner: claim, complete, fail', () => {
  it('claims only its job types and stores the handler result', async () => {
    const job = await enqueueCleanup('c1')
    const user = await createTestUser(h.db)
    const other = (await h.services.jobs.enqueue({ type: 'transcribe', payload: { userId: user.id, mediaId: '22222222-2222-4222-8222-222222222222' }, runAt: START })).job
    const runner = makeRunner(h, { cleanup: async () => ({ done: true }) })
    expect(await runner.drain()).toBe(1)
    const done = await getJob(h, job.id)
    expect(done).toMatchObject({ status: 'succeeded', attempts: 1, result: { done: true }, lockedBy: null })
    expect((await getJob(h, other.id)).status).toBe('queued')
    expect(runner.status().lastClaimAt).toBe(START.toISOString())
    expect(runner.status().counts.succeeded).toBe(1)
  })

  it('does not run jobs before run_at', async () => {
    const job = await enqueueCleanup('later', { runAt: at(HOUR) })
    const runner = makeRunner(h, { cleanup: async () => 'ok' })
    expect(await runner.drain()).toBe(0)
    h.clock.advance(HOUR)
    expect(await runner.drain()).toBe(1)
    expect((await getJob(h, job.id)).status).toBe('succeeded')
  })

  it('fails with exponential backoff and a scrubbed error, then succeeds on retry', async () => {
    const job = await enqueueCleanup('flaky')
    let calls = 0
    const handler: Handler = async () => {
      calls += 1
      if (calls < 3) throw new Error('upstream broke with Bearer abc.def.ghi')
      return 'fine'
    }
    const runner = makeRunner(h, { cleanup: handler })
    await runner.drain()
    let row = await getJob(h, job.id)
    expect(row.status).toBe('failed')
    expect(row.runAt.toISOString()).toBe(at(30 * SECOND).toISOString()) // backoff(1) = 30 s
    expect(row.lastError).not.toContain('abc.def.ghi')
    expect(h.logger.text()).not.toContain('abc.def.ghi')

    // not due yet
    expect(await runner.drain()).toBe(0)
    h.clock.advance(30 * SECOND)
    await runner.drain()
    row = await getJob(h, job.id)
    expect(row.runAt.toISOString()).toBe(at(30 * SECOND + 60 * SECOND).toISOString()) // backoff(2) = 60 s
    h.clock.advance(60 * SECOND)
    await runner.drain()
    row = await getJob(h, job.id)
    expect(row).toMatchObject({ status: 'succeeded', attempts: 3, result: 'fine', lastError: null })
  })

  it('adds jitter to the backoff', async () => {
    const job = await enqueueCleanup('jitter')
    const runner = makeRunner(h, { cleanup: async () => Promise.reject(new Error('nope')) }, { backoff: { baseMs: 40_000, maxMs: HOUR, jitter: 0.5, random: () => 1 } })
    await runner.drain()
    expect((await getJob(h, job.id)).runAt.toISOString()).toBe(at(20_000).toISOString())
  })

  it('goes dead after max_attempts', async () => {
    const job = await enqueueCleanup('doomed', { maxAttempts: 2 })
    const runner = makeRunner(h, { cleanup: async () => Promise.reject(new AppError('unavailable', 'still down')) })
    await runner.drain()
    expect((await getJob(h, job.id)).status).toBe('failed')
    h.clock.advance(HOUR)
    await runner.drain()
    const row = await getJob(h, job.id)
    expect(row).toMatchObject({ status: 'dead', attempts: 2, lastError: 'still down' })
    expect(row.finishedAt).toBeInstanceOf(Date)
    expect(runner.status().counts).toMatchObject({ failed: 1, dead: 1 })
    expect(h.logger.lines.some((l) => l.msg === 'job dead')).toBe(true)
  })

  it('sends permanent errors straight to dead', async () => {
    const a = await enqueueCleanup('perm-a')
    const b = await enqueueCleanup('perm-b')
    let n = 0
    const runner = makeRunner(h, {
      cleanup: async () => {
        n += 1
        throw n === 1 ? new PermanentJobError('cannot ever work') : new AppError('validation', 'bad input')
      },
    })
    await runner.drain()
    expect((await getJob(h, a.id)).status).toBe('dead')
    expect((await getJob(h, b.id)).status).toBe('dead')
  })

  it('honours a retry delay from RetryJobError or a provider retry-after', async () => {
    const a = await enqueueCleanup('retry-a')
    const b = await enqueueCleanup('retry-b')
    const runner = makeRunner(
      h,
      {
        cleanup: async (job) => {
          if (job.id === a.id) throw new RetryJobError('later', 5 * MINUTE)
          throw new AppError('rate_limited', 'slow down', { provider: 'fake', reason: 'rate_limited', retryAfterSec: 120 })
        },
      },
      { concurrency: 1 },
    )
    await runner.drain()
    expect((await getJob(h, a.id)).runAt.toISOString()).toBe(at(5 * MINUTE).toISOString())
    expect((await getJob(h, b.id)).runAt.toISOString()).toBe(at(120 * SECOND).toISOString())
  })

  it('fails a job type it has no handler for as permanent', async () => {
    const job = await enqueueCleanup('nohandler')
    const runner = makeRunner(h, { cleanup: undefined as unknown as Handler, analytics_pull: async () => 'x' })
    expect(runner.types).toEqual(['analytics_pull'])
    expect(await runner.drain()).toBe(0)
    expect((await getJob(h, job.id)).status).toBe('queued')
  })
})

describe('runner: loop, concurrency, leases', () => {
  it('runs at most `concurrency` jobs at once and picks up new jobs while running', async () => {
    for (let i = 0; i < 3; i++) await enqueueCleanup(`conc-${i}`)
    const gate = deferred()
    let running = 0
    let peak = 0
    const runner = makeRunner(h, {
      cleanup: async () => {
        running += 1
        peak = Math.max(peak, running)
        await gate.promise
        running -= 1
        return 'ok'
      },
    })
    await runner.start()
    await vi.waitFor(() => expect(running).toBe(2))
    await new Promise((r) => setTimeout(r, 30))
    expect(peak).toBe(2)
    gate.resolve()
    await vi.waitFor(async () => expect(runner.status().counts.succeeded).toBe(3))
    // a job enqueued later is picked up by the polling loop
    const late = await enqueueCleanup('late')
    await vi.waitFor(async () => expect((await getJob(h, late.id)).status).toBe('succeeded'))
    await runner.stop()
    expect(runner.status().state).toBe('stopped')
  })

  it('renews the lease of a long job (fake clock)', async () => {
    const job = await enqueueCleanup('long')
    const gate = deferred()
    const started = deferred()
    const runner = makeRunner(h, { cleanup: async () => (started.resolve(), await gate.promise, 'done') }, { leaseSec: 30, leaseRenewMs: 10 })
    const run = runner.drain()
    await started.promise
    expect((await getJob(h, job.id)).lockedUntil?.toISOString()).toBe(at(30 * SECOND).toISOString())
    // ten minutes pass on the app clock while the job runs: the lease keeps moving with it
    h.clock.advance(10 * MINUTE)
    await vi.waitFor(async () => expect((await getJob(h, job.id)).lockedUntil?.toISOString()).toBe(at(10 * MINUTE + 30 * SECOND).toISOString()))
    expect(await h.queue.requeueStale()).toEqual({ requeued: 0, dead: 0 })
    gate.resolve()
    await run
    expect((await getJob(h, job.id)).status).toBe('succeeded')
  })

  it('aborts a job whose lease was lost and drops its outcome', async () => {
    const job = await enqueueCleanup('lost')
    const started = deferred()
    let aborted = false
    const runner = makeRunner(
      h,
      {
        cleanup: async (_job, ctx) => {
          started.resolve()
          await new Promise<void>((resolve) => ctx.signal?.addEventListener('abort', () => resolve()))
          aborted = true
          throw new JobAbortedError()
        },
      },
      { leaseSec: 30, leaseRenewMs: 10 },
    )
    const run = runner.drain()
    await started.promise
    // another worker's sweep, an hour later by its clock, finds the lease expired and requeues it
    await jobsRepo.requeueStale(h.db, at(HOUR))
    await run
    expect(aborted).toBe(true)
    const row = await getJob(h, job.id)
    expect(row).toMatchObject({ status: 'failed', lastError: 'lease expired (worker stopped)' })
    expect(runner.status().counts.lost).toBe(1)
  })

  it('requeues stale leases on start and runs them', async () => {
    const job = await enqueueCleanup('orphan')
    // a worker claimed it and died
    const [claimed] = await h.queue.claim({ workerId: 'dead-worker', types: ['cleanup'], leaseSec: 30, limit: 1 })
    expect(claimed?.id).toBe(job.id)
    h.clock.advance(MINUTE)
    const runner = makeRunner(h, { cleanup: async () => 'recovered' })
    await runner.start()
    await vi.waitFor(async () => expect((await getJob(h, job.id)).status).toBe('succeeded'))
    await runner.stop()
    expect((await getJob(h, job.id)).attempts).toBe(2)
    expect(h.logger.lines.some((l) => l.msg === 'requeued jobs with expired leases')).toBe(true)
  })

  it('requeues stale leases periodically', async () => {
    const job = await enqueueCleanup('orphan-later')
    await h.queue.claim({ workerId: 'dead-worker', types: ['cleanup'], leaseSec: 30, limit: 1 })
    const runner = makeRunner(h, { analytics_pull: async () => 'x' }, { staleSweepMs: 10 })
    await runner.start()
    h.clock.advance(MINUTE)
    await vi.waitFor(async () => expect((await getJob(h, job.id)).status).toBe('failed'))
    await runner.stop()
  })
})

describe('runner: graceful shutdown', () => {
  it('lets running jobs finish and claims nothing new', async () => {
    const a = await enqueueCleanup('finish-a')
    const gate = deferred()
    const started = deferred()
    const runner = makeRunner(h, { cleanup: async () => (started.resolve(), await gate.promise, 'finished') }, { concurrency: 1 })
    await runner.start()
    await started.promise
    const b = await enqueueCleanup('finish-b')
    const stopping = runner.stop()
    expect(runner.status().state).toBe('stopping')
    setTimeout(() => gate.resolve(), 20)
    await stopping
    expect((await getJob(h, a.id)).status).toBe('succeeded')
    expect((await getJob(h, b.id)).status).toBe('queued')
  })

  it('aborts jobs that outlive the grace period and releases them without using up an attempt', async () => {
    const job = await enqueueCleanup('slow')
    const started = deferred()
    const runner = makeRunner(
      h,
      {
        cleanup: async (_job, ctx) => {
          started.resolve()
          await new Promise<void>((resolve) => ctx.signal?.addEventListener('abort', () => resolve()))
          throw new JobAbortedError()
        },
      },
      { shutdownGraceMs: 20, abortGraceMs: 1_000 },
    )
    await runner.start()
    await started.promise
    await runner.stop()
    const row = await getJob(h, job.id)
    expect(row).toMatchObject({ status: 'queued', attempts: 0, lockedBy: null })
    expect(runner.status().counts.released).toBe(1)
  })

  it('releases jobs whose handler ignores the abort, and drops their late outcome', async () => {
    const job = await enqueueCleanup('stubborn')
    const started = deferred()
    const gate = deferred()
    const runner = makeRunner(h, { cleanup: async () => (started.resolve(), await gate.promise, 'late') }, { shutdownGraceMs: 10, abortGraceMs: 10 })
    await runner.start()
    await started.promise
    await runner.stop()
    expect((await getJob(h, job.id)).status).toBe('queued')
    gate.resolve()
    await new Promise((r) => setTimeout(r, 20))
    // the late result did not overwrite the released job
    expect((await getJob(h, job.id)).status).toBe('queued')
  })

  it('stop() on a runner that never started is a no-op', async () => {
    const runner = makeRunner(h, { cleanup: async () => 'x' })
    await runner.stop()
    expect(runner.status().state).toBe('stopped')
  })
})
