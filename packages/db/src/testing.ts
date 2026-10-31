// Test harness ("@app/db/testing"): fresh PGlite databases with the Supabase stand-ins and the
// real migrations, RLS helpers and seed helpers. Server code must never import this module.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { Actor, Platform, PlanTier, SubscriptionStatus } from '@app/core/types'
import { findMigrationsDir, migrate, readMigrations } from './migrate'
import { wrapPglite } from './pglite'
import { createPostgresDb } from './postgres'
import * as accounts from './repos/accounts'
import * as brands from './repos/brands'
import * as drafts from './repos/drafts'
import * as media from './repos/media'
import * as posts from './repos/posts'
import * as users from './repos/users'
import { installSupabaseShim, SUPABASE_SHIM_SQL } from './supabase-shim'
import type { Db } from './types'

// ---------------------------------------------------------------------------------------------
// Fresh databases
// ---------------------------------------------------------------------------------------------

let templatePromise: Promise<Blob> | null = null

function pgliteFingerprint(): string {
  try {
    const entry = createRequire(import.meta.url).resolve('@electric-sql/pglite')
    const wasm = join(dirname(entry), 'pglite.wasm')
    const st = statSync(wasm)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'unknown'
  }
}

function templateKey(migrationsDir: string): string {
  const hash = createHash('sha256')
  hash.update(SUPABASE_SHIM_SQL)
  for (const file of readMigrations(migrationsDir)) hash.update(`${file.name}:${file.checksum}\n`)
  hash.update(pgliteFingerprint())
  return hash.digest('hex').slice(0, 32)
}

async function buildTemplate(): Promise<Blob> {
  const migrationsDir = findMigrationsDir()
  const useCache = process.env.APP_DB_TEST_CACHE !== '0'
  const cacheDir = join(tmpdir(), 'app-db-test-template')
  const cacheFile = join(cacheDir, `${templateKey(migrationsDir)}.tar`)
  if (useCache && existsSync(cacheFile)) {
    try {
      const blob = new Blob([readFileSync(cacheFile)])
      // prove the cached dump loads before trusting it
      const probe = await PGlite.create({ loadDataDir: blob })
      await probe.query('select 1 from public.schema_migrations limit 1')
      await probe.close()
      return blob
    } catch {
      // fall through and rebuild
    }
  }
  const pg = await PGlite.create()
  const db = wrapPglite(pg)
  await installSupabaseShim(db)
  await migrate(db, migrationsDir)
  const dump = await pg.dumpDataDir('none')
  await pg.close()
  const bytes = new Uint8Array(await dump.arrayBuffer())
  if (useCache) {
    try {
      mkdirSync(cacheDir, { recursive: true })
      const tmp = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(tmp, bytes)
      renameSync(tmp, cacheFile)
    } catch {
      // the cache is an optimisation only
    }
  }
  return new Blob([bytes])
}

function template(): Promise<Blob> {
  if (!templatePromise) {
    templatePromise = buildTemplate().catch((error: unknown) => {
      templatePromise = null
      throw error
    })
  }
  return templatePromise
}

/**
 * A fresh in-memory PGlite database with the Supabase stand-ins (roles anon, authenticated,
 * service_role; auth.users; auth.uid()) and every migration applied. The migrated template is
 * built once per process (and cached on disk by migration checksum), so each call costs a
 * load of the template only. Close it after the test (`await db.close()`).
 */
export async function createTestDb(): Promise<Db> {
  const pgUrl = process.env.APP_DB_TEST_POSTGRES_URL
  if (pgUrl) return createPostgresTestDb(pgUrl)
  const blob = await template()
  const pg = await PGlite.create({ loadDataDir: blob })
  return wrapPglite(pg)
}

/**
 * APP_DB_TEST_POSTGRES_URL=postgres://...: every createTestDb() is a throwaway database on that
 * server (created, given the stand-ins and migrations, dropped on close). Lets the PGlite suites
 * run unchanged against a real Postgres.
 */
async function createPostgresTestDb(adminUrl: string): Promise<Db> {
  const name = `app_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const admin = createPostgresDb(adminUrl, { max: 1 })
  await admin.exec(`create database ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const inner = createPostgresDb(url.toString(), { max: 4 })
  await installSupabaseShim(inner)
  await migrate(inner, findMigrationsDir())
  return {
    ...inner,
    async close() {
      await inner.close()
      await admin.exec(`drop database if exists ${name} with (force)`)
      await admin.close()
    },
  }
}

const RESET_SQL = `
do $$
declare
  v_tables text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ')
    into v_tables
    from pg_tables
   where (schemaname = 'public' and tablename <> 'schema_migrations') or (schemaname = 'auth' and tablename = 'users');
  if v_tables is not null then
    execute 'truncate ' || v_tables || ' cascade';
  end if;
end
$$;
`

/** Empties every table (keeps the schema): a fast alternative to a new database per test. */
export async function resetTestDb(db: Db): Promise<void> {
  await db.exec(RESET_SQL)
}

// ---------------------------------------------------------------------------------------------
// RLS helpers
// ---------------------------------------------------------------------------------------------

/**
 * Runs fn as the Supabase role `authenticated` with JWT claims for userId (what PostgREST does
 * for a browser request), inside a transaction or savepoint. RLS policies and grants apply.
 */
export async function asUser<T>(db: Db, userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return asRole(db, 'authenticated', { sub: userId, role: 'authenticated' }, fn)
}

/** Runs fn as the Supabase role `anon` (no user). */
export async function asAnon<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  return asRole(db, 'anon', { role: 'anon' }, fn)
}

async function asRole<T>(
  db: Db,
  role: 'authenticated' | 'anon',
  claims: Record<string, unknown>,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return db.tx(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await tx.query(`set local role ${role}`)
    const result = await fn(tx)
    // a savepoint release keeps SET LOCAL; restore for the enclosing transaction
    await tx.query('reset role')
    await tx.query(`select set_config('request.jwt.claims', '', true)`)
    return result
  })
}

// ---------------------------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------------------------

export interface TestUserOptions {
  id?: string
  email?: string
  displayName?: string | null
  plan?: PlanTier | null
  subscriptionStatus?: SubscriptionStatus
  currentPeriodStart?: Date | null
  currentPeriodEnd?: Date | null
  trialEndsAt?: Date | null
  extraBrands?: number
  extraClipHours?: number
  stripeCustomerId?: string | null
}

/** Creates auth.users + public.users. Defaults: plan starter, subscription active. */
export async function createTestUser(db: Db, options: TestUserOptions = {}): Promise<users.UserRow> {
  const id = options.id ?? randomUUID()
  const email = options.email ?? `user-${id.slice(0, 8)}@example.test`
  await users.devEnsureAuthUser(db, id, email)
  await users.ensure(db, id, { email, displayName: options.displayName ?? null })
  const row = await users.updateBilling(db, id, {
    plan: options.plan === undefined ? 'starter' : options.plan,
    subscriptionStatus: options.subscriptionStatus ?? 'active',
    currentPeriodStart: options.currentPeriodStart ?? null,
    currentPeriodEnd: options.currentPeriodEnd ?? null,
    trialEndsAt: options.trialEndsAt ?? null,
    extraBrands: options.extraBrands ?? 0,
    extraClipHours: options.extraClipHours ?? 0,
    ...(options.stripeCustomerId !== undefined ? { stripeCustomerId: options.stripeCustomerId } : {}),
  })
  if (!row) throw new Error('test user not created')
  return row
}

export async function createTestBrand(
  db: Db,
  userId: string,
  options: { name?: string; timezone?: string; status?: brands.BrandRow['status']; providerProfileRef?: string | null } = {},
): Promise<brands.BrandRow> {
  let brand = await brands.create(db, userId, { name: options.name ?? 'Test Brand', timezone: options.timezone ?? 'UTC' })
  if (options.status && options.status !== 'active') {
    brand = (await brands.setStatus(db, userId, brand.id, options.status)) ?? brand
  }
  if (options.providerProfileRef !== undefined) {
    brand = (await brands.setProviderProfileRef(db, userId, brand.id, options.providerProfileRef)) ?? brand
  }
  return brand
}

export async function createTestAccount(
  db: Db,
  userId: string,
  brandId: string,
  options: { platform?: Platform; status?: 'pending' | 'active' | 'needs_reauth'; provider?: string; handle?: string } = {},
): Promise<accounts.AccountRow> {
  const platform = options.platform ?? 'instagram'
  return accounts.upsertLive(db, userId, {
    brandId,
    platform,
    provider: options.provider ?? 'fake',
    externalAccountId: `ext-${platform}-${randomUUID().slice(0, 8)}`,
    handle: options.handle ?? `@test_${platform}`,
    displayName: `Test ${platform}`,
    status: options.status ?? 'active',
  })
}

/** An uploaded, ready image by default. */
export async function createTestMedia(
  db: Db,
  userId: string,
  options: Partial<media.CreateMediaInput> = {},
): Promise<media.MediaRow> {
  return media.create(db, userId, {
    kind: 'image',
    origin: 'upload',
    status: 'ready',
    storageKey: `test/${userId}/${randomUUID()}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 1024,
    width: 1080,
    height: 1350,
    ...options,
  })
}

/** An uploaded, ready, rights-attested 10-minute source video. */
export async function createTestSourceVideo(
  db: Db,
  userId: string,
  options: Partial<media.CreateMediaInput> = {},
): Promise<media.MediaRow> {
  return media.create(db, userId, {
    kind: 'video',
    origin: 'upload',
    status: 'ready',
    storageKey: `test/${userId}/${randomUUID()}.mp4`,
    mimeType: 'video/mp4',
    bytes: 50_000_000,
    durationMs: 600_000,
    width: 1920,
    height: 1080,
    rightsAttestedAt: new Date(),
    ...options,
  })
}

/** A draft with one Instagram variant unless variants are given. */
export async function createTestDraft(
  db: Db,
  userId: string,
  brandId: string,
  options: { variants?: drafts.VariantInput[]; createdVia?: Actor; notes?: string | null } = {},
): Promise<drafts.DraftWithVariants> {
  return drafts.create(db, userId, {
    brandId,
    createdVia: options.createdVia ?? 'mcp',
    notes: options.notes ?? null,
    variants: options.variants ?? [{ platform: 'instagram', text: 'Hello from a test draft' }],
  })
}

/** Approves the draft at its current revision (as a human would through the web). */
export async function approveTestDraft(db: Db, userId: string, draftId: string, via: Actor = 'web'): Promise<drafts.DraftRow> {
  const draft = await drafts.get(db, userId, draftId)
  if (!draft) throw new Error('draft not found')
  const approved = await drafts.approve(db, userId, draftId, { revision: draft.revision, via })
  if (!approved) throw new Error('draft could not be approved')
  return approved
}

export interface TestTenant {
  user: users.UserRow
  brand: brands.BrandRow
  account: accounts.AccountRow
}

/** A user with one brand and an active Instagram account. */
export async function seedTenant(db: Db, options: TestUserOptions & { platform?: Platform } = {}): Promise<TestTenant> {
  const user = await createTestUser(db, options)
  const brand = await createTestBrand(db, user.id)
  const account = await createTestAccount(db, user.id, brand.id, { platform: options.platform ?? 'instagram' })
  return { user, brand, account }
}

export interface TestScheduledPost {
  draft: drafts.DraftRow
  variant: drafts.VariantRow
  post: posts.PostRow
}

/**
 * A tenant's approved draft (one variant on the account's platform) and its scheduled post.
 */
export async function createTestScheduledPost(
  db: Db,
  tenant: TestTenant,
  options: { scheduledFor?: Date; text?: string } = {},
): Promise<TestScheduledPost> {
  const created = await createTestDraft(db, tenant.user.id, tenant.brand.id, {
    variants: [{ platform: tenant.account.platform, text: options.text ?? 'Scheduled from a test', connectedAccountId: tenant.account.id }],
  })
  const draft = await approveTestDraft(db, tenant.user.id, created.draft.id)
  const variant = created.variants[0]
  if (!variant) throw new Error('variant missing')
  const post = await posts.create(db, tenant.user.id, {
    brandId: tenant.brand.id,
    draftId: draft.id,
    variantId: variant.id,
    connectedAccountId: tenant.account.id,
    platform: tenant.account.platform,
    scheduledFor: options.scheduledFor ?? new Date(Date.now() + 3_600_000),
    approvedRevision: draft.revision,
    provider: 'fake',
  })
  return { draft, variant, post }
}
