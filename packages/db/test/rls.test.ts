import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_ERROR } from '../src/errors'
import * as analytics from '../src/repos/analytics'
import * as approvalNonces from '../src/repos/approvalNonces'
import * as audit from '../src/repos/audit'
import * as clips from '../src/repos/clips'
import * as jobs from '../src/repos/jobs'
import * as oauth from '../src/repos/oauth'
import * as pastPosts from '../src/repos/pastPosts'
import * as stripeEvents from '../src/repos/stripeEvents'
import * as transcripts from '../src/repos/transcripts'
import * as usage from '../src/repos/usage'
import * as voice from '../src/repos/voice'
import * as accounts from '../src/repos/accounts'
import { asAnon, asUser, createTestDb, createTestScheduledPost, createTestSourceVideo, seedTenant } from '../src/testing'
import type { Db } from '../src/types'
import { expectDbError } from './helpers'

const OWNER_TABLES = [
  'brands',
  'connected_accounts',
  'media_assets',
  'transcripts',
  'clips',
  'drafts',
  'draft_variants',
  'posts',
  'voice_profiles',
  'past_posts',
  'analytics_snapshots',
] as const

const SERVICE_TABLES = [
  'usage_ledger',
  'jobs',
  'oauth_clients',
  'oauth_codes',
  'oauth_tokens',
  'approval_nonces',
  'stripe_events',
  'audit_log',
  'schema_migrations',
] as const

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let db: Db
let a: string
let b: string

/** One row in every table for a tenant. */
async function seedEverything(): Promise<string> {
  const tenant = await seedTenant(db)
  const userId = tenant.user.id
  await accounts.setCredentials(db, userId, tenant.account.id, new Uint8Array([1, 2, 3]))
  const { draft, post } = await createTestScheduledPost(db, tenant)
  const src = await createTestSourceVideo(db, userId, { brandId: tenant.brand.id })
  await transcripts.save(db, userId, { mediaId: src.id, engine: 'fake', durationMs: 600_000, text: 'hi', words: [], segments: [] })
  await clips.create(db, userId, { brandId: tenant.brand.id, sourceMediaId: src.id, startMs: 0, endMs: 10_000 })
  await voice.save(db, userId, tenant.brand.id, { profile: { tone: 'warm' }, source: 'manual' })
  const past = await pastPosts.upsert(db, userId, tenant.brand.id, { platform: 'instagram', externalPostId: `ext-${randomUUID()}` })
  await analytics.insert(db, userId, { brandId: tenant.brand.id, platform: 'instagram', scope: 'post', postId: post.id, metrics: { views: 1 } })
  await analytics.insert(db, userId, { brandId: tenant.brand.id, platform: 'instagram', scope: 'post', pastPostId: past.id, metrics: { views: 2 } })
  await usage.record(db, userId, {
    meter: 'clip_seconds',
    kind: 'reserve',
    amount: 600,
    periodStart: new Date('2026-10-01T00:00:00Z'),
    idempotencyKey: `reserve-${src.id}`,
  })
  await jobs.enqueue(db, { type: 'transcribe', userId, payload: { mediaId: src.id } })
  const clientId = `client-${randomUUID()}`
  await oauth.createClient(db, { clientId, redirectUris: ['https://claude.ai/api/mcp/auth_callback'] })
  await oauth.createCode(db, {
    codeHash: sha(randomUUID()),
    clientId,
    userId,
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    scope: 'social',
    expiresAt: new Date(Date.now() + 60_000),
  })
  await oauth.createToken(db, {
    tokenHash: sha(randomUUID()),
    kind: 'access',
    familyId: randomUUID(),
    clientId,
    userId,
    scope: 'social',
    expiresAt: new Date(Date.now() + 60_000),
  })
  await approvalNonces.create(db, userId, { nonceHash: sha(randomUUID()), draftId: draft.id, revision: draft.revision, expiresAt: new Date(Date.now() + 60_000) })
  await stripeEvents.record(db, { id: `evt_${randomUUID().replace(/-/g, '')}`, type: 'customer.subscription.updated' })
  await audit.record(db, { userId, actor: 'web', action: 'draft.approved', subjectType: 'draft', subjectId: draft.id })
  return userId
}

beforeAll(async () => {
  db = await createTestDb()
  a = await seedEverything()
  b = await seedEverything()
})
afterAll(async () => {
  await db.close()
})

describe('owner policies (role authenticated)', () => {
  it('sees only its own users row', async () => {
    const rows = await asUser(db, a, (tx) => tx.query<{ id: string }>('select id from public.users'))
    expect(rows.map((r) => r.id)).toEqual([a])
  })

  it.each(OWNER_TABLES)('%s: sees its own rows and none of the other tenant\'s', async (table) => {
    const totalA = await db.one<{ n: number }>(`select count(*)::int as n from public.${table} where user_id = $1`, [a])
    const totalB = await db.one<{ n: number }>(`select count(*)::int as n from public.${table} where user_id = $1`, [b])
    expect(totalA?.n).toBeGreaterThan(0)
    expect(totalB?.n).toBeGreaterThan(0)

    const asA = await asUser(db, a, (tx) => tx.query<{ user_id: string }>(`select user_id from public.${table}`))
    expect(asA.length).toBe(totalA?.n)
    expect(new Set(asA.map((r) => r.user_id))).toEqual(new Set([a]))

    const asB = await asUser(db, b, (tx) => tx.query<{ user_id: string }>(`select user_id from public.${table}`))
    expect(new Set(asB.map((r) => r.user_id))).toEqual(new Set([b]))

    // explicit filter on the other tenant: still nothing
    const peek = await asUser(db, a, (tx) => tx.query(`select 1 from public.${table} where user_id = $1`, [b]))
    expect(peek).toEqual([])
  })

  it.each(OWNER_TABLES)('%s: cannot insert, update or delete', async (table) => {
    await expectDbError(
      asUser(db, a, (tx) => tx.query(`update public.${table} set user_id = user_id where user_id = $1`, [a])),
      PG_ERROR.insufficientPrivilege,
    )
    await expectDbError(
      asUser(db, a, (tx) => tx.query(`delete from public.${table} where user_id = $1`, [a])),
      PG_ERROR.insufficientPrivilege,
    )
    await expectDbError(
      asUser(db, a, (tx) => tx.query(`insert into public.${table} (user_id) values ($1)`, [a])),
      PG_ERROR.insufficientPrivilege,
    )
  })

  it('cannot read connected_accounts.encrypted_credentials (column grant), but can read the other columns', async () => {
    const rows = await asUser(db, a, (tx) =>
      tx.query<{ handle: string; status: string }>('select id, handle, status, platform, scopes from public.connected_accounts'),
    )
    expect(rows.length).toBeGreaterThan(0)
    await expectDbError(
      asUser(db, a, (tx) => tx.query('select encrypted_credentials from public.connected_accounts')),
      PG_ERROR.insufficientPrivilege,
    )
    await expectDbError(asUser(db, a, (tx) => tx.query('select * from public.connected_accounts')), PG_ERROR.insufficientPrivilege)
  })

  it('without a user id in the claims sees nothing', async () => {
    const rows = await db.tx(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`)
      await tx.query('set local role authenticated')
      return tx.query('select id from public.brands')
    })
    expect(rows).toEqual([])
  })

  it('restores the privileged role after asUser inside an outer transaction', async () => {
    await db.tx(async (tx) => {
      await asUser(tx, a, (inner) => inner.query('select 1 from public.brands'))
      const role = await tx.one<{ r: string }>('select current_user as r')
      expect(role?.r).toBe('postgres')
      const all = await tx.one<{ n: number }>('select count(*)::int as n from public.brands where user_id = any($1::uuid[])', [[a, b]])
      expect(all?.n).toBe(2)
    })
  })
})

describe('service-only tables (no policy, no grant)', () => {
  it.each(SERVICE_TABLES)('%s: authenticated is denied', async (table) => {
    await expectDbError(asUser(db, a, (tx) => tx.query(`select 1 from public.${table} limit 1`)), PG_ERROR.insufficientPrivilege)
  })

  it.each(SERVICE_TABLES)('%s: has RLS enabled and no policies', async (table) => {
    const row = await db.one<{ rls: boolean; policies: number }>(
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
         from pg_class c where c.oid = ('public.' || $1)::regclass`,
      [table],
    )
    expect(row).toEqual({ rls: true, policies: 0 })
  })

  it('denies even with an explicit grant, because RLS has no policy (defense in depth)', async () => {
    await db.tx(async (tx) => {
      await tx.query('grant select on public.jobs to authenticated')
      const rows = await asUser(tx, a, (inner) => inner.query('select id from public.jobs'))
      expect(rows).toEqual([])
      await tx.query('revoke select on public.jobs from authenticated')
    })
  })
})

describe('anon', () => {
  it.each([...OWNER_TABLES, 'users', ...SERVICE_TABLES])('%s: denied', async (table) => {
    await expectDbError(asAnon(db, (tx) => tx.query(`select 1 from public.${table} limit 1`)), PG_ERROR.insufficientPrivilege)
  })

  it('cannot call the private helper functions', async () => {
    await expectDbError(
      asAnon(db, (tx) => tx.query(`select private.draft_content_hash(gen_random_uuid(), gen_random_uuid())`)),
      PG_ERROR.insufficientPrivilege,
    )
    await expectDbError(
      asUser(db, a, (tx) => tx.query(`select private.first_touch_in_tx(gen_random_uuid())`)),
      PG_ERROR.insufficientPrivilege,
    )
  })
})

describe('policy inventory', () => {
  it('has exactly one SELECT policy for authenticated per owner table, using (select auth.uid())', async () => {
    const rows = await db.query<{ tablename: string; cmd: string; roles: string[]; qual: string }>(
      `select tablename, cmd, roles::text[] as roles, qual from pg_policies where schemaname = 'public' order by tablename`,
    )
    expect(rows.map((r) => r.tablename).sort()).toEqual([...OWNER_TABLES, 'users'].sort())
    for (const row of rows) {
      expect(row.cmd).toBe('SELECT')
      expect(row.roles).toEqual(['authenticated'])
      expect(row.qual).toMatch(/SELECT auth\.uid\(\)/)
    }
  })
})
