import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './types'

export interface MigrationFile {
  /** Leading digits of the file name, e.g. "0001". */
  version: string
  /** File name without .sql, e.g. "0001_init". */
  name: string
  path: string
  sql: string
  /** SHA-256 (hex) of the file contents. */
  checksum: string
}

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

export interface MigrateOptions {
  log?: (message: string) => void
}

const FILE_PATTERN = /^(\d+)_([a-z0-9_]+)\.sql$/

/** Reads `<version>_<name>.sql` files from dir, sorted by version. */
export function readMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort((a, b) => {
      const va = BigInt(FILE_PATTERN.exec(a)?.[1] ?? '0')
      const vb = BigInt(FILE_PATTERN.exec(b)?.[1] ?? '0')
      return va < vb ? -1 : va > vb ? 1 : a.localeCompare(b)
    })
  const seen = new Set<string>()
  return files.map((file) => {
    const match = FILE_PATTERN.exec(file)
    const version = match?.[1] ?? ''
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version} in ${dir}`)
    seen.add(version)
    const path = join(dir, file)
    const sql = readFileSync(path, 'utf8')
    return {
      version,
      name: file.replace(/\.sql$/, ''),
      path,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    }
  })
}

/**
 * Finds supabase/migrations: next to this package in the repo, else by walking up from start.
 */
export function findMigrationsDir(start: string = process.cwd()): string {
  const candidates: string[] = []
  try {
    candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations'))
  } catch {
    // bundlers may rewrite import.meta.url; fall back to the cwd walk
  }
  let dir = resolve(start)
  for (;;) {
    candidates.push(join(dir, 'supabase', 'migrations'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '0001_init.sql'))) return candidate
  }
  throw new Error('supabase/migrations not found; pass the directory explicitly')
}

const BOOKKEEPING_SQL = `
create table if not exists public.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.schema_migrations from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.schema_migrations from authenticated';
  end if;
end
$$;
`

/**
 * Applies pending migrations from dir in version order, each in its own transaction under an
 * advisory lock (safe to run from several processes). Fails if an applied file has changed.
 */
export async function migrate(db: Db, dir: string = findMigrationsDir(), options: MigrateOptions = {}): Promise<MigrateResult> {
  const log = options.log ?? (() => {})
  const files = readMigrations(dir)
  const result: MigrateResult = { applied: [], skipped: [] }

  await db.tx(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtext('app.schema_migrations'))`)
    await tx.exec(BOOKKEEPING_SQL)
  })

  for (const file of files) {
    await db.tx(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext('app.schema_migrations'))`)
      const existing = await tx.one<{ checksum: string }>(
        'select checksum from public.schema_migrations where version = $1',
        [file.version],
      )
      if (existing) {
        if (existing.checksum !== file.checksum) {
          throw new Error(`Migration ${file.name} was changed after it was applied (checksum mismatch)`)
        }
        result.skipped.push(file.name)
        return
      }
      log(`applying ${file.name}`)
      await tx.exec(file.sql)
      await tx.query('insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)', [
        file.version,
        file.name,
        file.checksum,
      ])
      result.applied.push(file.name)
    })
  }
  return result
}
