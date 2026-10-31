import postgres from 'postgres'
import { normalizeDbError } from './errors'
import type { Db, Row } from './types'

export interface PostgresDbOptions {
  /** Pool size (DATABASE_POOL_MAX). Default 5. */
  max?: number
  /** Seconds before an idle connection is closed. Default 20. */
  idleTimeoutSec?: number
  /** Seconds to wait for a connection. Default 10. */
  connectTimeoutSec?: number
  /** Passed to postgres.js; default: from the URL (sslmode), else off. */
  ssl?: boolean | 'require' | 'allow' | 'prefer' | 'verify-full'
}

// The slice of postgres.js used here (its generic types are awkward to thread through).
type Pending = PromiseLike<readonly unknown[]> & { simple(): PromiseLike<unknown> }
interface Handle {
  unsafe(query: string, params?: unknown[]): Pending
}
interface TxSql extends Handle {
  savepoint<T>(fn: (sql: TxSql) => Promise<T>): Promise<T>
}
interface Sql extends Handle {
  begin<T>(fn: (sql: TxSql) => Promise<T>): Promise<T>
  end(options?: { timeout?: number }): Promise<void>
}

// int8 (bigint) as a JS number when it is safe, else BigInt: the same rule PGlite uses, so code
// behaves identically on both drivers. postgres.js would return strings.
const int8: postgres.PostgresType = {
  to: 20,
  from: [20],
  serialize: (x: unknown) => String(x),
  parse: (x: string) => {
    const n = Number(x)
    return Number.isSafeInteger(n) ? n : BigInt(x)
  },
}

function toParams(params: readonly unknown[] | undefined): unknown[] {
  if (!params) return []
  return params.map((p) => (p === undefined ? null : p))
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw normalizeDbError(error)
  }
}

function wrap(sql: Sql | TxSql, depth: number, root: Sql | null): Db {
  const db: Db = {
    driver: 'postgres',
    async query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]> {
      const rows = await run(async () => await sql.unsafe(text, toParams(params)))
      return Array.from(rows) as T[]
    },
    async one<T = Row>(text: string, params?: readonly unknown[]): Promise<T | null> {
      const rows = await db.query<T>(text, params)
      return rows[0] ?? null
    },
    async exec(script: string): Promise<void> {
      await run(async () => await sql.unsafe(script).simple())
    },
    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (depth === 0) {
        return run(() => (sql as Sql).begin((t) => fn(wrap(t, 1, null))))
      }
      return run(() => (sql as TxSql).savepoint((s) => fn(wrap(s, depth + 1, null))))
    },
    async close(): Promise<void> {
      if (!root) throw new Error('close() cannot be called on a transaction handle')
      await root.end({ timeout: 5 })
    },
  }
  return db
}

/**
 * postgres.js pool. Prepared statements are off so it works through the Supabase transaction
 * pooler (port 6543). Errors are normalised to DbError.
 */
export function createPostgresDb(url: string, options: PostgresDbOptions = {}): Db {
  const sql = postgres(url, {
    prepare: false,
    max: options.max ?? 5,
    idle_timeout: options.idleTimeoutSec ?? 20,
    connect_timeout: options.connectTimeoutSec ?? 10,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
    onnotice: () => {},
    types: { int8 },
    transform: { undefined: null },
  }) as unknown as Sql
  return wrap(sql, 0, sql)
}
