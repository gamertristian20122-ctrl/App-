import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestAccount, createTestBrand, createTestUser } from '@app/db/testing'
import { Scheduler, cleanupJobKey } from '../src/scheduler'
import { DAY, HOUR, MINUTE, START, createWorkerHarness, jobsOfType, resetWorkerHarness, scheduledPost, tenant, type WorkerHarness } from './helpers'

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

const replica = () => new Scheduler({ services: h.services, clock: h.clock, logger: h.logger })

async function activeBrand() {
  const user = await createTestUser(h.db)
  const brand = await createTestBrand(h.db, user.id, { providerProfileRef: `fake_brand_${user.id.slice(0, 8)}` })
  await createTestAccount(h.db, user.id, brand.id, { platform: 'instagram' })
  return brand
}

describe('scheduler', () => {
  it('queues one cleanup per hour across replicas', async () => {
    const a = replica()
    const b = replica()
    expect((await a.tick()).cleanupQueued).toBe(true)
    expect((await b.tick()).cleanupQueued).toBe(false) // the other replica's key exists
    expect((await a.tick()).cleanupQueued).toBe(false) // same hour, nothing to do
    let cleanups = await jobsOfType(h, 'cleanup')
    expect(cleanups).toHaveLength(1)
    expect(cleanups[0]).toMatchObject({ idempotencyKey: cleanupJobKey(START), payload: { task: 'all' } })
    expect(cleanups[0]?.runAt.toISOString()).toBe(START.toISOString())

    h.clock.advance(HOUR)
    await a.tick()
    await b.tick()
    cleanups = await jobsOfType(h, 'cleanup')
    expect(cleanups.map((j) => j.idempotencyKey)).toEqual(['cleanup:hourly:2026-11-02T12', 'cleanup:hourly:2026-11-02T13'])
  })

  it('queues daily account analytics once per brand per day across replicas', async () => {
    const one = await activeBrand()
    const two = await activeBrand()
    const a = replica()
    const b = replica()
    expect((await a.tick()).analyticsQueued).toBe(2)
    expect((await b.tick()).analyticsQueued).toBe(0)
    h.clock.advance(6 * HOUR)
    expect((await a.tick()).analyticsQueued).toBe(0)
    let pulls = await jobsOfType(h, 'analytics_pull')
    expect(pulls.map((j) => j.payload.brandId).sort()).toEqual([one.id, two.id].sort())
    expect(pulls.every((j) => j.payload.scope === 'account')).toBe(true)

    h.clock.advance(DAY)
    await a.tick()
    await b.tick()
    pulls = await jobsOfType(h, 'analytics_pull')
    expect(pulls).toHaveLength(4)
  })

  it('re-queues lost publish jobs every few minutes', async () => {
    const t = await tenant(h, 'x')
    const { post } = await scheduledPost(h, t, { platform: 'x', text: 'Lost job' }, new Date(START.getTime() + MINUTE).toISOString())
    // the publish job vanished (e.g. pruned or dead)
    await h.db.query(`delete from public.jobs where type = 'publish_post'`)
    const s = replica()
    expect((await s.tick()).duePostsQueued).toBe(0) // not due yet
    h.clock.advance(10 * MINUTE)
    expect((await s.tick()).duePostsQueued).toBe(1)
    const [job] = await jobsOfType(h, 'publish_post')
    expect(job?.payload.postId).toBe(post.id)
    // within the sweep interval nothing is swept again
    h.clock.advance(MINUTE)
    expect((await s.tick()).duePostsQueued).toBe(0)
  })

  it('retries a failed step on the next tick', async () => {
    const s = new Scheduler({
      services: {
        ...h.services,
        jobs: { ...h.services.jobs, enqueue: async () => Promise.reject(new Error('database is down')) },
      },
      clock: h.clock,
      logger: h.logger,
    })
    const first = await s.tick()
    expect(first).toMatchObject({ cleanupQueued: false, errors: 1 })
    const ok = replica()
    expect((await ok.tick()).cleanupQueued).toBe(true)
    expect(h.logger.lines.some((l) => l.msg === 'queueing cleanup failed')).toBe(true)
  })

  it('start() ticks immediately and stop() halts it', async () => {
    const s = new Scheduler({ services: h.services, clock: h.clock, logger: h.logger, intervalMs: 10 })
    s.start()
    await s.tick()
    await s.stop()
    expect(await jobsOfType(h, 'cleanup')).toHaveLength(1)
  })
})
