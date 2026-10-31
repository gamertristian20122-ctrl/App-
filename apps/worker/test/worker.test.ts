// The wired process: startWorker (registry + runner + scheduler + health) and createWorkerContext.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TEST_SESSION_SECRET, TEST_TOKEN_ENCRYPTION_KEYS } from '@app/core/testing'
import { createWorkerContext, STATUS_POLL_BUDGET } from '../src/context'
import { startWorker } from '../src/worker'
import { createWorkerHarness, jobsOfType, type WorkerHarness } from './helpers'

let h: WorkerHarness
beforeAll(async () => {
  h = await createWorkerHarness()
})
afterAll(async () => {
  await h.db.close()
})

describe('startWorker', () => {
  it('runs the scheduler’s cleanup job, serves health, and stops gracefully', async () => {
    const worker = await startWorker({}, { context: h.context, healthPort: 0, runner: { pollIntervalMs: 5 } })
    try {
      expect(worker.registry.types).toEqual(expect.arrayContaining(['publish_post', 'check_post_status', 'analytics_pull', 'import_past_posts', 'cleanup']))
      expect(worker.scheduler).not.toBeNull()
      await vi.waitFor(async () => {
        const [cleanup] = await jobsOfType(h, 'cleanup')
        expect(cleanup?.status).toBe('succeeded')
      })
      const res = await fetch(`http://127.0.0.1:${worker.health?.port}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; lastClaimAt: string | null }
      expect(body.ok).toBe(true)
      expect(body.lastClaimAt).not.toBeNull()
    } finally {
      await worker.stop()
    }
    expect(worker.runner.status().state).toBe('stopped')
    await worker.stop() // idempotent
  })

  it('a media-only worker has no scheduler and claims no posting jobs', async () => {
    const context = { ...h.context, config: { ...h.context.config, WORKER_TYPES: ['media' as const] } }
    const worker = await startWorker({}, { context, healthPort: null, handlerSets: { posting: {}, media: {} } })
    try {
      expect(worker.scheduler).toBeNull()
      expect(worker.runner.types).toEqual([])
      expect(worker.health).toBeNull()
    } finally {
      await worker.stop()
    }
  })
})

describe('createWorkerContext', () => {
  it('builds services from the environment with the worker’s poll budget', async () => {
    const env = {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      APP_URL: 'http://localhost:3000',
      LOG_LEVEL: 'error',
      PGLITE_DATA_DIR: 'memory',
      SESSION_SECRET: TEST_SESSION_SECRET,
      TOKEN_ENCRYPTION_KEYS: TEST_TOKEN_ENCRYPTION_KEYS,
      POSTING_PROVIDER: 'fake',
      STORAGE_DRIVER: 'memory',
      TRANSCRIPTION_PROVIDER: 'fake',
      WORKER_TYPES: 'posting',
      WORKER_ID: 'railway-posting-1',
      MEDIA_TMP_DIR: '/tmp/app-worker-media',
    }
    const ctx = await createWorkerContext(env)
    try {
      expect(ctx.workerId).toBe('railway-posting-1')
      expect(ctx.config.WORKER_TYPES).toEqual(['posting'])
      expect(ctx.services.deps.config.statusPollMaxPolls).toBe(STATUS_POLL_BUDGET)
      expect(ctx.provider.name).toBe('fake')
      expect(ctx.tmpDir).toBe('/tmp/app-worker-media')
      expect(await ctx.services.jobs.claim({ workerId: ctx.workerId, types: ['cleanup'] })).toEqual([])
    } finally {
      await ctx.close()
    }
  }, 60_000)
})
