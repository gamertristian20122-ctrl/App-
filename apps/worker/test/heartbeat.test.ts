// The worker heartbeat (worker_heartbeats, migration 0005) that the owner's /setup page reads.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { workerHeartbeats } from '@app/db'
import { Heartbeat, workerVersion } from '../src/heartbeat'
import { startWorker } from '../src/worker'
import { createWorkerHarness, resetWorkerHarness, type WorkerHarness } from './helpers'

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

describe('Heartbeat', () => {
  it('upserts this worker’s row with its groups and version, then removes it on stop', async () => {
    const beat = new Heartbeat({ db: h.db, workerId: 'railway-posting-1', groups: ['posting'], version: 'abc123def456', logger: h.logger })
    expect(await beat.beat()).toBe(true)
    expect(await beat.beat()).toBe(true)
    const rows = await workerHeartbeats.list(h.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ workerId: 'railway-posting-1', types: ['posting'], version: 'abc123def456' })
    expect(rows[0]!.ageSec).toBeLessThan(5)
    await beat.stop()
    expect(await workerHeartbeats.list(h.db)).toEqual([])
  })

  it('keeps the worker running when a beat fails, and warns once per failure streak', async () => {
    const failing = { ...h.db, query: vi.fn(async () => Promise.reject(new Error('relation "worker_heartbeats" does not exist'))) }
    const beat = new Heartbeat({ db: failing, workerId: 'w', groups: ['media'], logger: h.logger })
    expect(await beat.beat()).toBe(false)
    expect(await beat.beat()).toBe(false)
    expect(h.logger.lines.filter((l) => l.msg === 'recording the heartbeat failed')).toHaveLength(1)
    await beat.stop()
  })

  it('beats on start and every interval', async () => {
    const beat = new Heartbeat({ db: h.db, workerId: 'tick', groups: ['posting', 'media'], logger: h.logger, intervalMs: 20 })
    const spy = vi.spyOn(beat, 'beat')
    beat.start()
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3))
    await beat.stop()
    const after = spy.mock.calls.length
    await new Promise((r) => setTimeout(r, 60))
    expect(spy.mock.calls.length).toBe(after)
  })

  it('reads the version from Railway’s commit sha only', () => {
    expect(workerVersion({ RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef0123' })).toBe('0123456789ab')
    expect(workerVersion({ RAILWAY_GIT_COMMIT_SHA: 'not a sha!' })).toBeNull()
    expect(workerVersion({})).toBeNull()
  })
})

describe('startWorker heartbeat', () => {
  it('records the worker while it runs and removes it when it stops', async () => {
    const worker = await startWorker({ RAILWAY_GIT_COMMIT_SHA: 'feedface1234' }, { context: h.context, healthPort: null, scheduler: false, runner: { pollIntervalMs: 5 } })
    try {
      await vi.waitFor(async () => {
        const rows = await workerHeartbeats.list(h.db)
        expect(rows).toEqual([expect.objectContaining({ workerId: 'test-worker', types: ['posting', 'media'], version: 'feedface1234' })])
      })
      expect(worker.heartbeat).not.toBeNull()
    } finally {
      await worker.stop()
    }
    expect(await workerHeartbeats.list(h.db)).toEqual([])
  })

  it('can be turned off', async () => {
    const worker = await startWorker({}, { context: h.context, healthPort: null, scheduler: false, heartbeat: false })
    try {
      expect(worker.heartbeat).toBeNull()
      expect(await workerHeartbeats.list(h.db)).toEqual([])
    } finally {
      await worker.stop()
    }
  })
})
