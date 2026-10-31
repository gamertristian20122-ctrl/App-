import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import { APP_SQLSTATE, DbError, PG_ERROR, dbErrorToAppError, isCheckViolation, isForeignKeyViolation, isRetryableDbError, normalizeDbError } from '../src/errors'
import { openDb } from '../src/open'
import { createPgliteDb } from '../src/pglite'
import { createPostgresDb } from '../src/postgres'
import { json, setClause, stripSecretKeys, truncate } from '../src/sql'
import type { Db } from '../src/types'
import { driverContract } from './driver-contract'

describe('PGlite driver', () => {
  let db: Db
  beforeAll(async () => {
    db = await createPgliteDb()
  })
  afterAll(async () => {
    await db.close()
  })
  driverContract(() => db)

  it('reports its driver and closes idempotently', async () => {
    const other = await createPgliteDb('memory')
    expect(other.driver).toBe('pglite')
    await other.close()
    await other.close()
  })
})

describe('openDb', () => {
  it('opens a persistent local PGlite with the Supabase stand-ins and migrations, and reopens it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pglite-open-'))
    try {
      const db = await openDb({ pgliteDataDir: join(dir, 'data') })
      const row = await db.one<{ n: number }>('select count(*)::int as n from public.schema_migrations')
      expect(row?.n).toBeGreaterThanOrEqual(1)
      await db.query(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa', 'a@example.test')`)
      await db.close()
      const again = await openDb({ pgliteDataDir: join(dir, 'data') })
      expect(await again.one(`select email from auth.users`)).toEqual({ email: 'a@example.test' })
      await again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns a postgres.js pool when a URL is given (no connection until the first query)', async () => {
    const db = await openDb({ url: 'postgres://user:pass@127.0.0.1:1/none', poolMax: 1 })
    expect(db.driver).toBe('postgres')
    await db.close()
    const direct = createPostgresDb('postgres://user:pass@127.0.0.1:1/none', { connectTimeoutSec: 1 })
    expect(direct.driver).toBe('postgres')
    await direct.close()
  })
})

describe('error helpers', () => {
  it('normalises postgres.js-shaped and PGlite-shaped errors', () => {
    const pgjs = normalizeDbError(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'c1', table_name: 't1', parameters: ['secret'] }))
    expect(pgjs).toBeInstanceOf(DbError)
    expect(pgjs).toMatchObject({ code: '23505', constraint: 'c1', table: 't1' })
    expect(JSON.stringify(pgjs)).not.toContain('secret')
    const lite = normalizeDbError(Object.assign(new Error('fk'), { code: '23503', constraint: 'c2', table: 't2', params: ['secret'] }))
    expect(isForeignKeyViolation(lite, 'c2')).toBe(true)
    const plain = new Error('not a db error')
    expect(normalizeDbError(plain)).toBe(plain)
    expect(normalizeDbError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).not.toBeInstanceOf(DbError)
    expect(normalizeDbError('str')).toBe('str')
    expect(isCheckViolation(new DbError('c', { code: '23514', constraint: 'k' }), 'k')).toBe(true)
    expect(isRetryableDbError(new DbError('s', { code: '40001' }))).toBe(true)
    expect(isRetryableDbError(new DbError('s', { code: '23505' }))).toBe(false)
  })

  it('maps database errors to AppError codes', () => {
    const map = (code: string) => dbErrorToAppError(new DbError('m', { code }))?.code
    expect(map(PG_ERROR.uniqueViolation)).toBe('conflict')
    expect(map(PG_ERROR.foreignKeyViolation)).toBe('not_found')
    expect(map(PG_ERROR.checkViolation)).toBe('validation')
    expect(map(APP_SQLSTATE.notApproved)).toBe('conflict')
    expect(map(APP_SQLSTATE.mismatch)).toBe('validation')
    expect(map(APP_SQLSTATE.immutable)).toBe('conflict')
    expect(map(APP_SQLSTATE.invalidTransition)).toBe('conflict')
    expect(map(APP_SQLSTATE.appendOnly)).toBe('conflict')
    expect(map(APP_SQLSTATE.invalidState)).toBe('conflict')
    expect(map(PG_ERROR.insufficientPrivilege)).toBe('forbidden')
    expect(map('XX000')).toBeUndefined()
    expect(dbErrorToAppError(new DbError('m', { code: '23505', constraint: 'k' }))).toBeInstanceOf(AppError)
  })
})

describe('sql helpers', () => {
  it('builds SET clauses from defined keys only, with casts and json', () => {
    expect(setClause({}, { a: 'a' }, 1)).toBeNull()
    const set = setClause({ a: 1, b: undefined, c: null, d: { x: 1 } }, { a: 'col_a', b: 'col_b', c: { column: 'col_c', cast: 'uuid' }, d: { column: 'col_d', json: true } }, 3)
    expect(set).toEqual({ sql: 'col_a = $3, col_c = $4::uuid, col_d = $5::text::jsonb', params: [1, null, '{"x":1}'] })
  })

  it('truncates, serialises and strips credential-like keys', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
    expect(truncate(undefined, 4)).toBeNull()
    expect(json(undefined)).toBe('null')
    expect(stripSecretKeys({ a: 1, token: 'x', list: [{ apiKey: 'k', ok: 2 }], when: new Date(0) })).toEqual({
      a: 1,
      list: [{ ok: 2 }],
      when: new Date(0),
    })
  })
})
