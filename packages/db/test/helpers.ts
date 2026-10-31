import { expect } from 'vitest'
import { DbError } from '../src/errors'

/** Asserts that promise rejects with a DbError of `code` (and constraint, when given). */
export async function expectDbError(promise: Promise<unknown>, code: string, constraint?: string): Promise<DbError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught, `expected DbError ${code}${constraint ? ` (${constraint})` : ''}`).toBeInstanceOf(DbError)
  const err = caught as DbError
  expect({ code: err.code, constraint: constraint === undefined ? undefined : err.constraint, message: err.message }).toMatchObject({
    code,
    constraint,
  })
  return err
}

export const HOUR = 3_600_000

export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * HOUR)
}

/** PGlite's clock has millisecond resolution: wait so consecutive rows get distinct created_at. */
export function tick(ms = 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
