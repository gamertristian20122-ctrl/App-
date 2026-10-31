// `pnpm -F @app/db migrate`: applies supabase/migrations to DATABASE_URL (use the direct or
// session-pooler URL), or to the local PGlite data dir when DATABASE_URL is empty.
// `pnpm -F @app/db migrate --local-shim`: for a plain local Postgres (not Supabase), first
// installs the Supabase stand-ins (auth schema, roles). Never use it against Supabase.

import { findMigrationsDir, migrate } from './migrate'
import { openDb } from './open'
import { createPostgresDb } from './postgres'
import { installSupabaseShim } from './supabase-shim'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim() || null
  const dir = process.env.MIGRATIONS_DIR?.trim() || findMigrationsDir()
  const log = (message: string) => process.stdout.write(`${message}\n`)
  if (url) {
    const db = createPostgresDb(url, { max: 1 })
    try {
      if (process.argv.includes('--local-shim')) {
        await installSupabaseShim(db)
      } else {
        const auth = await db.one(`select 1 as ok from pg_namespace where nspname = 'auth'`)
        if (!auth) {
          throw new Error('schema "auth" not found: not a Supabase database (for a plain local Postgres, add --local-shim)')
        }
      }
      const result = await migrate(db, dir, { log })
      log(`applied ${result.applied.length}, already applied ${result.skipped.length}`)
    } finally {
      await db.close()
    }
    return
  }
  const db = await openDb({ pgliteDataDir: process.env.PGLITE_DATA_DIR?.trim() || '.data/pglite', migrationsDir: dir, log })
  await db.close()
  log('local PGlite database is up to date')
}

main().catch((error: unknown) => {
  // Error messages from the driver never include parameters or the connection string.
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exit(1)
})
