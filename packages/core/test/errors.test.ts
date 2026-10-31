import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AppError,
  ERROR_CODES,
  HTTP_STATUS_BY_CODE,
  ensure,
  fromZodError,
  isAppError,
  isErrorCode,
  notFound,
  parseOrThrow,
  toErrorBody,
  zodIssues,
} from '../src/errors'

describe('AppError', () => {
  it('carries code, details, status and cause', () => {
    const cause = new Error('db down')
    const e = new AppError('conflict', 'Already approved.', { draftId: 'd1' }, { cause })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('AppError')
    expect(e.code).toBe('conflict')
    expect(e.status).toBe(409)
    expect(e.details).toEqual({ draftId: 'd1' })
    expect(e.cause).toBe(cause)
    expect(e.toJSON()).toEqual({ code: 'conflict', message: 'Already approved.', details: { draftId: 'd1' } })
    expect(isAppError(e)).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
  })

  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) expect(HTTP_STATUS_BY_CODE[code]).toBeGreaterThanOrEqual(400)
    expect(new AppError('not_found', 'x').status).toBe(404)
    expect(new AppError('payment_required', 'x').status).toBe(402)
    expect(new AppError('cap_reached', 'x').status).toBe(429)
    expect(isErrorCode('validation')).toBe(true)
    expect(isErrorCode('nope')).toBe(false)
  })

  it('knows which errors are retryable', () => {
    expect(new AppError('rate_limited', 'x').retryable).toBe(true)
    expect(new AppError('validation', 'x').retryable).toBe(false)
  })

  it('has shorthands', () => {
    expect(notFound('Draft').message).toBe('Draft was not found.')
    expect(() => ensure(false, 'forbidden', 'no')).toThrow(AppError)
    expect(() => ensure(1, 'forbidden', 'no')).not.toThrow()
  })
})

describe('zod helpers', () => {
  const schema = z.strictObject({ name: z.string().min(2), age: z.number().int() })

  it('flattens issues with paths and no values', () => {
    const r = schema.safeParse({ name: 'x', age: 'secret-value' })
    expect(r.success).toBe(false)
    if (r.success) return
    const issues = zodIssues(r.error)
    expect(issues.map((i) => i.path).sort()).toEqual(['age', 'name'])
    const err = fromZodError(r.error, 'Draft')
    expect(err.code).toBe('validation')
    expect(err.message).toMatch(/^Draft is invalid\./)
    expect(err.message).not.toContain('secret-value')
  })

  it('summarises at most five issues', () => {
    const big = z.strictObject(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, z.string()])))
    const r = big.safeParse({})
    if (r.success) throw new Error('expected failure')
    expect(fromZodError(r.error).message).toContain('(and 2 more)')
  })

  it('parseOrThrow returns data or throws AppError', () => {
    expect(parseOrThrow(schema, { name: 'ab', age: 3 })).toEqual({ name: 'ab', age: 3 })
    expect(() => parseOrThrow(schema, {})).toThrow(AppError)
  })
})

describe('toErrorBody', () => {
  it('serialises AppError', () => {
    expect(toErrorBody(new AppError('forbidden', 'Nope.'))).toEqual({
      status: 403,
      body: { error: { code: 'forbidden', message: 'Nope.' } },
    })
  })

  it('hides unknown errors', () => {
    const r = toErrorBody(new Error('password=hunter2 leaked'))
    expect(r.status).toBe(500)
    expect(r.body.error.code).toBe('internal')
    expect(JSON.stringify(r)).not.toContain('hunter2')
  })
})
