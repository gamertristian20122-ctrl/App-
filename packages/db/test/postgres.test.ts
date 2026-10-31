// Runs against a real Postgres when TEST_DATABASE_URL is set (any database on a server where the
// role may CREATE DATABASE; a throwaway database is created and dropped). Skipped otherwise.
// Covers what PGlite (single session) cannot: postgres.js, cross-session SKIP LOCKED, row locks.
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm -F @app/db test

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findMigrationsDir, migrate } from '../src/migrate'
import { createPostgresDb } from '../src/postgres'
import * as drafts from '../src/repos/drafts'
import * as jobs from '../src/repos/jobs'
import * as posts from '../src/repos/posts'
import * as usage from '../src/repos/usage'
import { installSupabaseShim } from '../src/supabase-shim'
import { approveTestDraft, asUser, createTestDraft, createTestScheduledPost, createTestUser, seedTenant } from '../src/testing'
import type { Db } from '../src/types'
import { driverContract } from './driver-contract'

const ADMIN_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!ADMIN_URL)('real Postgres (postgres.js driver)', () => {
  let admin: Db
  let db: Db
  const name = `app_db_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`

  beforeAll(async () => {
    admin = createPostgresDb(ADMIN_URL as string, { max: 1 })
    await admin.exec(`create database ${name}`)
    const url = new URL(ADMIN_URL as string)
    url.pathname = `/${name}`
    db = createPostgresDb(url.toString(), { max: 6 })
    await installSupabaseShim(db)
    await migrate(db, findMigrationsDir())
  }, 60_000)

  afterAll(async () => {
    await db?.close()
    await admin?.exec(`drop database if exists ${name} with (force)`)
    await admin?.close()
  }, 60_000)

  driverContract(() => db)

  it('runs on Postgres 15 or newer (ON DELETE SET NULL column lists)', async () => {
    const row = await db.one<{ v: number }>(`select current_setting('server_version_num')::int as v`)
    expect(row?.v).toBeGreaterThanOrEqual(150000)
  })

  it('SKIP LOCKED: a job locked by an open claim transaction goes to nobody else', async () => {
    const first = (await jobs.enqueue(db, { type: 'pg_skip_locked', runAt: new Date(Date.now() - 2000) })).job
    const second = (await jobs.enqueue(db, { type: 'pg_skip_locked', runAt: new Date(Date.now() - 1000) })).job
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let claimedA: string[] = []
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    const txA = db.tx(async (tx) => {
      claimedA = (await jobs.claim(tx, { types: ['pg_skip_locked'], workerId: 'A', leaseSec: 30 })).map((j) => j.id)
      markReady()
      await held
    })
    await ready
    const claimedB = (await jobs.claim(db, { types: ['pg_skip_locked'], workerId: 'B', leaseSec: 30 })).map((j) => j.id)
    release()
    await txA
    expect(claimedA).toEqual([first.id])
    expect(claimedB).toEqual([second.id])
    expect(await jobs.claim(db, { types: ['pg_skip_locked'], workerId: 'C', leaseSec: 30 })).toEqual([])
  })

  it('concurrent workers drain the queue with every job claimed exactly once', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 40; i++) ids.add((await jobs.enqueue(db, { type: 'pg_drain', runAt: new Date(Date.now() - 1000) })).job.id)
    const worker = async (w: number) => {
      const got: string[] = []
      for (;;) {
        const batch = await jobs.claim(db, { types: ['pg_drain'], workerId: `w${w}`, leaseSec: 30, limit: 3 })
        if (batch.length === 0) return got
        got.push(...batch.map((j) => j.id))
      }
    }
    const results = await Promise.all([0, 1, 2, 3, 4].map(worker))
    const all = results.flat()
    expect(all.length).toBe(40)
    expect(new Set(all)).toEqual(ids)
  })

  it('reserveWithinLimit never overdraws under concurrency', async () => {
    const user = await createTestUser(db)
    const periodStart = new Date('2026-11-01T00:00:00Z')
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        usage.reserveWithinLimit(db, user.id, { meter: 'clip_seconds', amount: 3600, periodStart, limit: 3 * 3600, idempotencyKey: `c-${user.id}-${i}` }),
      ),
    )
    expect(results.filter((r) => r.ok).length).toBe(3)
    expect((await usage.totals(db, user.id, 'clip_seconds', periodStart)).used).toBe(3 * 3600)
  })

  it('a draft edit racing a post insert waits for it, then cancels the post', async () => {
    const tenant = await seedTenant(db)
    const created = await createTestDraft(db, tenant.user.id, tenant.brand.id)
    const approved = await approveTestDraft(db, tenant.user.id, created.draft.id)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let markInserted!: () => void
    const inserted = new Promise<void>((resolve) => {
      markInserted = resolve
    })
    let postId = ''
    const txA = db.tx(async (tx) => {
      const post = await posts.create(tx, tenant.user.id, {
        brandId: tenant.brand.id,
        draftId: approved.id,
        variantId: created.variants[0]!.id,
        connectedAccountId: tenant.account.id,
        platform: 'instagram',
        scheduledFor: new Date(Date.now() + 3_600_000),
        approvedRevision: approved.revision,
        provider: 'fake',
      })
      postId = post.id
      markInserted()
      await held
    })
    await inserted
    let editDone = false
    const edit = drafts.updateVariant(db, tenant.user.id, created.variants[0]!.id, { text: 'racing edit' }).then(() => {
      editDone = true
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(editDone).toBe(false) // blocked by the FOR SHARE lock of the post insert
    release()
    await txA
    await edit
    expect((await posts.get(db, tenant.user.id, postId))?.status).toBe('canceled')
    expect((await drafts.get(db, tenant.user.id, created.draft.id))?.revision).toBe(2)
  })

  it('bumps the draft revision once per transaction and forgets rolled-back savepoints', async () => {
    const tenant = await seedTenant(db)
    const created = await createTestDraft(db, tenant.user.id, tenant.brand.id)
    expect(created.draft.revision).toBe(1)
    const variantId = created.variants[0]!.id
    await db.tx(async (tx) => {
      await drafts.updateVariant(tx, tenant.user.id, variantId, { text: 'a' })
      await drafts.upsertVariant(tx, tenant.user.id, created.draft.id, { platform: 'x', text: 'b' })
    })
    expect((await drafts.get(db, tenant.user.id, created.draft.id))?.revision).toBe(2)
    await db.tx(async (tx) => {
      await expect(
        tx.tx(async (sp) => {
          await drafts.updateVariant(sp, tenant.user.id, variantId, { text: 'rolled back' })
          throw new Error('undo')
        }),
      ).rejects.toThrow('undo')
      await drafts.updateVariant(tx, tenant.user.id, variantId, { text: 'kept' })
    })
    expect((await drafts.get(db, tenant.user.id, created.draft.id))?.revision).toBe(3)
  })

  it('RLS isolates tenants for the authenticated role', async () => {
    const a = await seedTenant(db)
    const b = await seedTenant(db)
    await createTestScheduledPost(db, a)
    await createTestScheduledPost(db, b)
    const seen = await asUser(db, a.user.id, (tx) => tx.query<{ user_id: string }>('select user_id from public.posts'))
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen.map((r) => r.user_id))).toEqual(new Set([a.user.id]))
    await expect(asUser(db, a.user.id, (tx) => tx.query('select 1 from public.jobs'))).rejects.toMatchObject({ code: '42501' })
  })
})
