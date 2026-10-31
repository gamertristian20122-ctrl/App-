// Migration 0005: app_settings (owner's /setup values, secrets stored sealed) and
// worker_heartbeats (workers upsert every minute; /setup reads their age by the database clock).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PG_ERROR } from '../src/errors'
import * as appSettings from '../src/repos/appSettings'
import * as workerHeartbeats from '../src/repos/workerHeartbeats'
import { bindRepos } from '../src/repos'
import { createTestDb, resetTestDb } from '../src/testing'
import type { Db } from '../src/types'
import { expectDbError, tick } from './helpers'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetTestDb(db)
})

describe('appSettings', () => {
  it('sets, replaces, reads and removes a value', async () => {
    expect(await appSettings.get(db, 'stripe.webhook_secret.test')).toBeNull()
    const first = await appSettings.set(db, 'stripe.webhook_secret.test', 'v1:sealed-one', { encrypted: true })
    expect(first).toMatchObject({ key: 'stripe.webhook_secret.test', value: 'v1:sealed-one', encrypted: true })
    await tick()
    const second = await appSettings.set(db, 'stripe.webhook_secret.test', 'v1:sealed-two', { encrypted: true })
    expect(second.value).toBe('v1:sealed-two')
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime())
    expect(second.createdAt).toEqual(first.createdAt)
    const plain = await bindRepos(db).appSettings.set('stripe.portal_configuration.test', 'bpc_123')
    expect(plain.encrypted).toBe(false)
    expect(await appSettings.remove(db, 'stripe.webhook_secret.test')).toBe(true)
    expect(await appSettings.remove(db, 'stripe.webhook_secret.test')).toBe(false)
  })

  it('refuses malformed keys and empty values', async () => {
    await expect(appSettings.set(db, 'Bad Key', 'x')).rejects.toThrow(/Invalid setting key/)
    await expectDbError(db.query(`insert into public.app_settings (key, value) values ('ok.key', '')`), PG_ERROR.checkViolation)
    await expectDbError(db.query(`insert into public.app_settings (key, value) values ('Bad Key', 'x')`), PG_ERROR.checkViolation)
  })
})

describe('workerHeartbeats', () => {
  it('upserts one row per worker and lists them newest first with their age', async () => {
    await workerHeartbeats.beat(db, { workerId: 'posting-1', types: ['posting'], version: 'abc123' })
    await tick()
    await workerHeartbeats.beat(db, { workerId: 'media-1', types: ['media', 'media'] })
    const before = await workerHeartbeats.list(db)
    expect(before.map((r) => [r.workerId, r.types])).toEqual([
      ['media-1', ['media']],
      ['posting-1', ['posting']],
    ])
    expect(before[1]).toMatchObject({ version: 'abc123' })
    expect(before.every((r) => r.ageSec >= 0 && r.ageSec < 60)).toBe(true)

    // a later beat moves the row up and keeps started_at
    await tick()
    await workerHeartbeats.beat(db, { workerId: 'posting-1', types: ['posting', 'media'], version: 'def456' })
    const after = await workerHeartbeats.list(db)
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({ workerId: 'posting-1', types: ['posting', 'media'], version: 'def456' })
    expect(after[0]?.startedAt).toEqual(before[1]?.startedAt)
    expect(after[0]!.lastSeenAt.getTime()).toBeGreaterThan(before[1]!.lastSeenAt.getTime())
  })

  it('reports age by the database clock, forgets day-old workers and removes on shutdown', async () => {
    await workerHeartbeats.beat(db, { workerId: 'old', types: ['media'] })
    await db.query(`update public.worker_heartbeats set last_seen_at = now() - interval '90 seconds' where worker_id = 'old'`)
    expect((await workerHeartbeats.list(db))[0]?.ageSec).toBeGreaterThanOrEqual(90)
    await db.query(`update public.worker_heartbeats set last_seen_at = now() - interval '25 hours' where worker_id = 'old'`)
    await workerHeartbeats.beat(db, { workerId: 'new', types: ['posting'] })
    expect((await workerHeartbeats.list(db)).map((r) => r.workerId)).toEqual(['new'])
    await workerHeartbeats.remove(db, 'new')
    expect(await workerHeartbeats.list(db)).toEqual([])
  })

  it('accepts only the posting and media groups', async () => {
    await expectDbError(
      db.query(`insert into public.worker_heartbeats (worker_id, types) values ('x', array['cron']::text[])`),
      PG_ERROR.checkViolation,
    )
    await expectDbError(db.query(`insert into public.worker_heartbeats (worker_id, types) values ('x', array[]::text[])`), PG_ERROR.checkViolation)
  })
})
