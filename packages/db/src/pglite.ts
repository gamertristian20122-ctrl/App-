import { mkdirSync } from 'node:fs'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { normalizeDbError } from './errors'
import type { Db, Row } from './types'

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw normalizeDbError(error)
  }
}

function params(values: readonly unknown[] | undefined): unknown[] {
  return values ? values.map((v) => (v === undefined ? null : v)) : []
}

function wrapTx(tx: Transaction, depth: number): Db {
  const db: Db = {
    driver: 'pglite',
    async query<T = Row>(text: string, values?: readonly unknown[]): Promise<T[]> {
      const res = await run(() => tx.query<T>(text, params(values)))
      return res.rows
    },
    async one<T = Row>(text: string, values?: readonly unknown[]): Promise<T | null> {
      const rows = await db.query<T>(text, values)
      return rows[0] ?? null
    },
    async exec(script: string): Promise<void> {
      await run(() => tx.exec(script))
    },
    async tx<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
      const name = `sp_${depth + 1}`
      await run(() => tx.query(`savepoint ${name}`))
      try {
        const result = await fn(wrapTx(tx, depth + 1))
        await run(() => tx.query(`release savepoint ${name}`))
        return result
      } catch (error) {
        await run(() => tx.query(`rollback to savepoint ${name}`))
        throw normalizeDbError(error)
      }
    },
    async close(): Promise<void> {
      throw new Error('close() cannot be called on a transaction handle')
    },
  }
  return db
}

/** Wraps an existing PGlite instance (tests use this with clones of a migrated template). */
export function wrapPglite(pg: PGlite): Db {
  const db: Db = {
    driver: 'pglite',
    async query<T = Row>(text: string, values?: readonly unknown[]): Promise<T[]> {
      const res = await run(() => pg.query<T>(text, params(values)))
      return res.rows
    },
    async one<T = Row>(text: string, values?: readonly unknown[]): Promise<T | null> {
      const rows = await db.query<T>(text, values)
      return rows[0] ?? null
    },
    async exec(script: string): Promise<void> {
      await run(() => pg.exec(script))
    },
    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return run(() => pg.transaction((t) => fn(wrapTx(t, 0))))
    },
    async close(): Promise<void> {
      if (!pg.closed) await pg.close()
    },
  }
  return db
}

/**
 * In-process Postgres (WASM). dataDir: a directory for a persistent database, or undefined /
 * "memory" for an in-memory one. One process at a time may open a data directory.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const inMemory = dataDir === undefined || dataDir === '' || dataDir === 'memory' || dataDir.startsWith('memory://')
  if (!inMemory) mkdirSync(dataDir, { recursive: true })
  const pg = await PGlite.create(inMemory ? undefined : dataDir)
  return wrapPglite(pg)
}
