import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ACCOUNT_STATUSES,
  ACTORS,
  BRAND_STATUSES,
  CLIP_STATUSES,
  DRAFT_STATUSES,
  JOB_STATUSES,
  MEDIA_KINDS,
  MEDIA_ORIGINS,
  MEDIA_STATUSES,
  PLAN_TIERS,
  PLATFORMS,
  POST_STATUSES,
  SUBSCRIPTION_STATUSES,
  USAGE_KINDS,
  USAGE_METERS,
} from '@app/core/types'
import { createPgliteDb } from '../src/pglite'
import { findMigrationsDir, migrate, readMigrations } from '../src/migrate'
import { installSupabaseShim } from '../src/supabase-shim'
import { createTestDb } from '../src/testing'
import type { Db } from '../src/types'

const TABLES = [
  'users',
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
  'usage_ledger',
  'jobs',
  'oauth_clients',
  'oauth_codes',
  'oauth_tokens',
  'approval_nonces',
  'stripe_events',
  'audit_log',
]

describe('migrations on a fresh database', () => {
  let db: Db

  beforeAll(async () => {
    db = await createPgliteDb()
    await installSupabaseShim(db)
  })
  afterAll(async () => {
    await db.close()
  })

  it('applies every migration once, then nothing on a second run', async () => {
    const first = await migrate(db, findMigrationsDir())
    expect(first.applied).toEqual(readMigrations(findMigrationsDir()).map((m) => m.name))
    expect(first.applied).toContain('0001_init')
    const second = await migrate(db, findMigrationsDir())
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(first.applied)
    const rows = await db.query<{ version: string; checksum: string }>('select version, checksum from public.schema_migrations')
    expect(rows.map((r) => r.version)).toContain('0001')
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a migration that changed after it was applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'))
    try {
      writeFileSync(join(dir, '0001_init.sql'), 'select 1;')
      await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies new files in version order and rolls back a failing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'))
    try {
      const init = readMigrations(findMigrationsDir())[0]
      writeFileSync(join(dir, '0001_init.sql'), init?.sql ?? '')
      writeFileSync(join(dir, '0100_b.sql'), 'create table public._mig_b (id int); alter table public._mig_b enable row level security;')
      writeFileSync(join(dir, '0090_a.sql'), 'create table public._mig_a (id int); alter table public._mig_a enable row level security;')
      writeFileSync(join(dir, '0101_bad.sql'), 'create table public._mig_c (id int); select 1/0;')
      writeFileSync(join(dir, 'README.md'), 'not a migration')
      await expect(migrate(db, dir)).rejects.toThrow(/division by zero/)
      const versions = await db.query<{ version: string }>('select version from public.schema_migrations order by version')
      // the real 0002+ migrations were applied by the test template; the temp dir adds 0090 and 0100
      expect(versions.map((v) => v.version).filter((v) => v === '0001' || Number(v) >= 90)).toEqual(['0001', '0090', '0100'])
      const c = await db.one(`select to_regclass('public._mig_c') as t`)
      expect(c?.t).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await db.exec('drop table if exists public._mig_a; drop table if exists public._mig_b;')
      await db.query(`delete from public.schema_migrations where version in ('0090', '0100')`)
    }
  })

  it('rejects duplicate versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'))
    try {
      writeFileSync(join(dir, '0001_a.sql'), 'select 1;')
      writeFileSync(join(dir, '0001_b.sql'), 'select 1;')
      expect(() => readMigrations(dir)).toThrow(/Duplicate migration version/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('schema shape', () => {
  let db: Db
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('creates exactly the 20 tables of the data model (plus schema_migrations)', async () => {
    const rows = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    )
    expect(rows.map((r) => r.tablename).sort()).toEqual([...TABLES, 'schema_migrations'].sort())
  })

  it('enables RLS on every public table', async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')`,
    )
    expect(rows.length).toBe(TABLES.length + 1)
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true)
  })

  it('defines the enums exactly as packages/core/src/types.ts (same order)', async () => {
    const expected: Record<string, readonly string[]> = {
      plan_tier: PLAN_TIERS,
      subscription_status: SUBSCRIPTION_STATUSES,
      platform: PLATFORMS,
      brand_status: BRAND_STATUSES,
      account_status: ACCOUNT_STATUSES,
      media_kind: MEDIA_KINDS,
      media_origin: MEDIA_ORIGINS,
      media_status: MEDIA_STATUSES,
      clip_status: CLIP_STATUSES,
      draft_status: DRAFT_STATUSES,
      post_status: POST_STATUSES,
      job_status: JOB_STATUSES,
      usage_meter: USAGE_METERS,
      usage_kind: USAGE_KINDS,
      actor: ACTORS,
    }
    const rows = await db.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
         from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' group by t.typname`,
    )
    const actual = Object.fromEntries(rows.map((r) => [r.typname, r.labels]))
    expect(actual).toEqual(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, [...v]])))
  })

  it('gives mutable tables an updated_at column and every table created_at', async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and column_name in ('created_at', 'updated_at')`,
    )
    const has = (t: string, c: string) => rows.some((r) => r.table_name === t && r.column_name === c)
    for (const t of TABLES) expect(has(t, 'created_at'), `${t}.created_at`).toBe(true)
    const mutable = ['users', 'brands', 'connected_accounts', 'media_assets', 'transcripts', 'clips', 'drafts', 'draft_variants', 'posts', 'past_posts', 'jobs']
    for (const t of mutable) expect(has(t, 'updated_at'), `${t}.updated_at`).toBe(true)
    const triggers = await db.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgname like '%_updated_at' and not tgisinternal`,
    )
    expect(triggers.map((t) => t.tgname).sort()).toEqual(mutable.map((t) => `${t}_updated_at`).sort())
  })

  it('pins search_path on every function it defines (and on any SECURITY DEFINER one)', async () => {
    const rows = await db.query<{ proname: string; nspname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `select p.proname, n.nspname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')`,
    )
    expect(rows.length).toBeGreaterThan(5)
    for (const fn of rows) {
      expect(fn.proconfig ?? [], `${fn.nspname}.${fn.proname}`).toContain('search_path=""')
    }
  })

  it('has an index led by the referencing column for every foreign key', async () => {
    const rows = await db.query<{ conname: string; table: string; first_col: string; indexed: boolean }>(
      `select c.conname, c.conrelid::regclass::text as table, a.attname as first_col,
              exists (
                select 1 from pg_index i
                 where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
              ) as indexed
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
    )
    expect(rows.length).toBeGreaterThan(30)
    const missing = rows.filter((r) => !r.indexed).map((r) => `${r.table}.${r.first_col} (${r.conname})`)
    expect(missing).toEqual([])
  })

  it('indexes job claiming and has the partial unique indexes of the data model', async () => {
    const rows = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    )
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? ''
    expect(def('jobs_status_run_at_idx')).toMatch(/\(status, run_at\)/)
    expect(def('jobs_claim_idx')).toMatch(/WHERE/)
    expect(def('connected_accounts_live_platform_uidx')).toMatch(/UNIQUE.*\(brand_id, platform\).*WHERE/)
    expect(def('posts_active_variant_uidx')).toMatch(/UNIQUE.*\(variant_id\).*WHERE/)
    expect(def('brands_user_active_idx')).toMatch(/\(user_id\).*WHERE.*active/)
  })
})
