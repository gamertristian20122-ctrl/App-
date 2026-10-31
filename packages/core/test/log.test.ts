import { describe, expect, it } from 'vitest'
import { REDACTED, createLogger, isLogLevel, redact, scrubString, silentLogger } from '../src/log'
import { memoryLogger } from '../src/testing'

describe('redact', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({
      user: 'u1',
      accessToken: 'abc',
      nested: { deeper: { client_secret: 's', apiKey: 'k', 'api-key': 'k2', API_KEY: 'k3', password: 'p' } },
      headers: { Authorization: 'Bearer xyz', cookie: 'sid=1', 'set-cookie': 'a=b' },
      list: [{ refresh_token: 'r' }, { code_verifier: 'v' }],
      encrypted_credentials: 'blob',
      tokenCount: null,
    })
    expect(out).toEqual({
      user: 'u1',
      accessToken: REDACTED,
      nested: { deeper: { client_secret: REDACTED, apiKey: REDACTED, 'api-key': REDACTED, API_KEY: REDACTED, password: REDACTED } },
      headers: { Authorization: REDACTED, cookie: REDACTED, 'set-cookie': REDACTED },
      list: [{ refresh_token: REDACTED }, { code_verifier: REDACTED }],
      encrypted_credentials: REDACTED,
      tokenCount: null,
    })
  })

  it('scrubs secrets inside strings', () => {
    expect(scrubString('Authorization: Bearer abc.def-123')).toBe(`Authorization: Bearer ${REDACTED}`)
    expect(scrubString('Apikey sk-live-123456')).toBe(`Apikey ${REDACTED}`)
    expect(scrubString('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig_nature')).toBe(`token ${REDACTED}`)
    expect(scrubString('GET /cb?code=abc123&state=ok')).toBe(`GET /cb?code=${REDACTED}&state=ok`)
    expect(scrubString('https://r2/x?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA')).toBe(
      `https://r2/x?X-Amz-Signature=${REDACTED}&X-Amz-Credential=${REDACTED}`,
    )
    expect(scrubString('password=hunter2 next')).toBe(`password=${REDACTED} next`)
    expect(scrubString('key sk_live_abcdefgh12345')).toBe(`key ${REDACTED}`)
    expect(scrubString('nothing to see')).toBe('nothing to see')
    expect(scrubString('Basic configuration loaded; bearer token refresh failed')).toBe(
      'Basic configuration loaded; bearer token refresh failed',
    )
    expect(scrubString('Authorization: Basic dXNlcjpwYXNz')).toBe(`Authorization: Basic ${REDACTED}`)
    expect(scrubString('Bearer abcdefghijklmnopqrstuvwxyz')).toBe(`Bearer ${REDACTED}`)
  })

  it('handles errors, cycles, binary, headers, maps and odd values', () => {
    const err = Object.assign(new Error('failed with Bearer abc123def'), { status: 401, apiKey: 'k' })
    const cyclic: Record<string, unknown> = { name: 'c' }
    cyclic.self = cyclic
    const out = redact({
      err,
      cyclic,
      bin: new Uint8Array(5),
      headers: new Headers({ authorization: 'Bearer x', 'content-type': 'json' }),
      map: new Map([['secret', 1], ['ok', 2]]),
      set: new Set([1]),
      big: 10n,
      fn: () => 1,
      date: new Date('2026-01-01T00:00:00Z'),
      url: new URL('https://x.test/a?token=abc'),
    }) as Record<string, any>
    expect(out.err.message).toBe(`failed with Bearer ${REDACTED}`)
    expect(out.err.status).toBe(401)
    expect(out.err.apiKey).toBe(REDACTED)
    expect(out.err.stack).toBeTypeOf('string')
    expect(out.cyclic).toEqual({ name: 'c', self: '[Circular]' })
    expect(out.bin).toBe('[binary 5 bytes]')
    expect(out.headers).toEqual({ authorization: REDACTED, 'content-type': 'json' })
    expect(out.map).toEqual({ secret: REDACTED, ok: 2 })
    expect(out.set).toEqual([1])
    expect(out.big).toBe('10')
    expect('fn' in out).toBe(false)
    expect(out.date).toBe('2026-01-01T00:00:00.000Z')
    expect(out.url).toBe(`https://x.test/a?token=${REDACTED}`)
  })

  it('limits depth and array length', () => {
    let deep: Record<string, unknown> = { v: 1 }
    for (let i = 0; i < 20; i++) deep = { d: deep }
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]')
    const arr = redact(Array.from({ length: 250 }, (_, i) => i)) as unknown[]
    expect(arr).toHaveLength(201)
    expect(arr[200]).toBe('…[50 more]')
  })
})

describe('createLogger', () => {
  it('writes JSON lines with level, time, name and fields', () => {
    const lines: string[] = []
    const log = createLogger({ name: 'web', sink: (l) => lines.push(l), now: () => new Date('2026-01-01T00:00:00Z') })
    log.info('hello', { userId: 'u1' })
    expect(JSON.parse(lines[0]!)).toEqual({ level: 'info', time: '2026-01-01T00:00:00.000Z', name: 'web', msg: 'hello', userId: 'u1' })
  })

  it('filters by level', () => {
    const log = memoryLogger('warn')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(log.lines.map((l) => l.level)).toEqual(['warn', 'error'])
    expect(log.isLevelEnabled('info')).toBe(false)
  })

  it('never writes secrets, even in messages, bindings or errors', () => {
    const log = memoryLogger().child({ requestId: 'r1', apiKey: 'top-secret-key' })
    log.info('calling with Bearer supersecret123', { headers: { authorization: 'Bearer supersecret123' }, token: 'tok-999' })
    log.error('boom', new Error('upstream said password=hunter22'))
    const text = log.text()
    for (const s of ['top-secret-key', 'supersecret123', 'tok-999', 'hunter22']) expect(text).not.toContain(s)
    expect(log.lines[0]).toMatchObject({ requestId: 'r1', apiKey: REDACTED })
    expect(log.lines[1]?.err).toMatchObject({ name: 'Error' })
  })

  it('child bindings cannot override level/time/msg', () => {
    const log = memoryLogger().child({ msg: 'spoof', level: 'debug' })
    log.info('real')
    expect(log.lines[0]).toMatchObject({ msg: 'real', level: 'info' })
  })

  it('silentLogger and isLogLevel', () => {
    expect(() => silentLogger.error('x')).not.toThrow()
    expect(isLogLevel('warn')).toBe(true)
    expect(isLogLevel('trace')).toBe(false)
  })
})
