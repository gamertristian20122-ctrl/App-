// The Db contract both drivers must satisfy (run by drivers.test.ts on PGlite and by
// postgres.test.ts on a real Postgres when TEST_DATABASE_URL is set).

import { expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import { DbError, PG_ERROR, dbErrorToAppError, isUniqueViolation } from '../src/errors'
import type { Db } from '../src/types'

export function driverContract(getDb: () => Db): void {
  it('runs parameterised queries and returns typed values consistently', async () => {
    const db = getDb()
    const row = await db.one<Record<string, unknown>>(
      `select $1::int as i, $2::text as t, $3::boolean as b, $4::timestamptz as ts, $5::uuid[] as ids,
              $6::text::jsonb as j, $7::bytea as bytes, 9007199254740993::bigint as big, 42::bigint as small,
              null::text as n, $8::text[] as empty`,
      [7, 'héllo', true, new Date('2026-01-02T03:04:05.678Z'), ['00000000-0000-0000-0000-000000000001'], JSON.stringify({ a: [1, 'x'] }), new Uint8Array([1, 2, 255]), []],
    )
    expect(row).not.toBeNull()
    expect(row?.i).toBe(7)
    expect(row?.t).toBe('héllo')
    expect(row?.b).toBe(true)
    expect((row?.ts as Date).toISOString()).toBe('2026-01-02T03:04:05.678Z')
    expect(row?.ids).toEqual(['00000000-0000-0000-0000-000000000001'])
    expect(row?.j).toEqual({ a: [1, 'x'] })
    expect(Array.from(row?.bytes as Uint8Array)).toEqual([1, 2, 255])
    expect(row?.big).toBe(9007199254740993n)
    expect(row?.small).toBe(42)
    expect(row?.n).toBeNull()
    expect(row?.empty).toEqual([])
    expect(await db.one('select 1 where false')).toBeNull()
    expect(await db.query('select generate_series(1, 3) as n')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    // undefined parameters are sent as NULL
    expect(await db.one('select $1::text as v', [undefined])).toEqual({ v: null })
  })

  it('exec runs multi-statement scripts', async () => {
    const db = getDb()
    await db.exec('create temp table if not exists _contract_exec (n int); insert into _contract_exec values (1), (2);')
    expect((await db.one<{ c: number }>('select count(*)::int as c from _contract_exec'))?.c).toBeGreaterThanOrEqual(2)
    await db.exec('drop table _contract_exec')
  })

  it('commits a transaction, rolls back on error, and nests with savepoints', async () => {
    const db = getDb()
    await db.exec('create table if not exists public._contract_tx (n int primary key); truncate public._contract_tx;')
    try {
      await db.tx(async (tx) => {
        await tx.query('insert into public._contract_tx values (1)')
      })
      await expect(
        db.tx(async (tx) => {
          await tx.query('insert into public._contract_tx values (2)')
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      const result = await db.tx(async (tx) => {
        await tx.query('insert into public._contract_tx values (3)')
        await expect(
          tx.tx(async (sp) => {
            await sp.query('insert into public._contract_tx values (4)')
            await sp.query('insert into public._contract_tx values (4)') // duplicate key
          }),
        ).rejects.toBeInstanceOf(DbError)
        // the outer transaction is still usable after the savepoint rolled back
        const inner = await tx.tx(async (sp) => {
          await sp.query('insert into public._contract_tx values (5)')
          return sp.tx(async (sp2) => {
            await sp2.query('insert into public._contract_tx values (6)')
            return 'nested'
          })
        })
        return inner
      })
      expect(result).toBe('nested')
      const rows = await db.query<{ n: number }>('select n from public._contract_tx order by n')
      expect(rows.map((r) => r.n)).toEqual([1, 3, 5, 6])
      await expect(db.tx(async (tx) => tx.close())).rejects.toThrow(/transaction handle/)
    } finally {
      await db.exec('drop table if exists public._contract_tx')
    }
  })

  it('normalises errors to DbError with code and constraint, without parameters', async () => {
    const db = getDb()
    await db.exec('create table if not exists public._contract_err (k text constraint _contract_err_k unique, n int check (n > 0))')
    try {
      await db.query('insert into public._contract_err values ($1, 1)', ['secret-value'])
      let caught: unknown
      try {
        await db.query('insert into public._contract_err values ($1, 1)', ['secret-value'])
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DbError)
      expect(isUniqueViolation(caught, '_contract_err_k')).toBe(true)
      const err = caught as DbError
      expect(err.table).toBe('_contract_err')
      expect(JSON.stringify({ ...err, message: err.message })).not.toMatch(/insert into/)
      expect(Object.keys(err)).not.toContain('params')
      expect(Object.keys(err)).not.toContain('parameters')
      const app = dbErrorToAppError(err)
      expect(app).toBeInstanceOf(AppError)
      expect(app?.code).toBe('conflict')
      await expect(db.query('insert into public._contract_err values ($1, 0)', ['x'])).rejects.toMatchObject({ code: PG_ERROR.checkViolation })
      await expect(db.query('select * from public._no_such_table')).rejects.toMatchObject({ code: '42P01' })
      expect(dbErrorToAppError(new Error('plain'))).toBeNull()
    } finally {
      await db.exec('drop table if exists public._contract_err')
    }
  })
}
