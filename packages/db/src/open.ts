import { findMigrationsDir, migrate } from './migrate'
import { createPgliteDb } from './pglite'
import { createPostgresDb } from './postgres'
import { installSupabaseShim } from './supabase-shim'
import type { Db } from './types'

export interface OpenDbOptions {
  /** DATABASE_URL. When set, connects with postgres.js (Supabase pooler). */
  url?: string | null
  /** DATABASE_POOL_MAX. */
  poolMax?: number
  /** PGLITE_DATA_DIR for local dev without DATABASE_URL ("memory" = in-memory). */
  pgliteDataDir?: string
  /** PGlite only: where the migrations live (default: found from the repo). */
  migrationsDir?: string
  log?: (message: string) => void
}

/**
 * Opens the app database from config: postgres.js when a URL is given (migrations are applied
 * by `pnpm -F @app/db migrate`, not here), else a local PGlite with the Supabase stand-ins and
 * all migrations applied.
 */
export async function openDb(options: OpenDbOptions): Promise<Db> {
  if (options.url) {
    return createPostgresDb(options.url, options.poolMax !== undefined ? { max: options.poolMax } : {})
  }
  const db = await createPgliteDb(options.pgliteDataDir)
  await installSupabaseShim(db)
  await migrate(db, options.migrationsDir ?? findMigrationsDir(), options.log ? { log: options.log } : {})
  return db
}
