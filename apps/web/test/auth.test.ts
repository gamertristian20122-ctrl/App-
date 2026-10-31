import { describe, expect, it, vi } from 'vitest'
import {
  DEV_SESSION_COOKIE,
  createDevSessionCookie,
  devUserId,
  getUserFromRequest,
  isValidEmail,
  signDevSession,
  verifyDevSession,
} from '@/lib/auth'

const SECRET = 'test-session-secret-0123456789abcdef'
const devEnv = { APP_ENV: 'test', DEV_AUTH: '1', SESSION_SECRET: SECRET }

const req = (cookie?: string) => new Request('http://localhost:3000/api/x', { headers: cookie ? { cookie } : {} })

describe('dev sessions', () => {
  it('derives a stable UUID from the normalised email', () => {
    expect(devUserId('Alice@Example.com ')).toBe(devUserId('alice@example.com'))
    expect(devUserId('alice@example.com')).not.toBe(devUserId('bob@example.com'))
    expect(devUserId('alice@example.com')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('signs and verifies', () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const value = signDevSession('Alice@Example.com', SECRET, now)
    expect(verifyDevSession(value, SECRET, now)).toEqual({ id: devUserId('alice@example.com'), email: 'alice@example.com' })
  })

  it('rejects tampering, wrong secrets, expiry and junk', () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const value = signDevSession('alice@example.com', SECRET, now, 60)
    const [payload, sig] = value.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ email: 'mallory@example.com', exp: 9e9 })).toString('base64url')
    expect(verifyDevSession(`${forged}.${sig}`, SECRET, now)).toBeNull()
    expect(verifyDevSession(`${payload}.${sig}x`, SECRET, now)).toBeNull()
    expect(verifyDevSession(value, `${SECRET}-other`, now)).toBeNull()
    expect(verifyDevSession(value, SECRET, new Date(now.getTime() + 61_000))).toBeNull()
    for (const junk of [undefined, '', 'abc', '.', 'a.b.c', 'x'.repeat(5000)]) expect(verifyDevSession(junk, SECRET, now)).toBeNull()
    expect(() => signDevSession('not-an-email', SECRET)).toThrow()
    expect(isValidEmail('a@b.co')).toBe(true)
    expect(isValidEmail('a@b')).toBe(false)
  })

  it('builds the cookie only when DEV_AUTH is on', () => {
    const cookie = createDevSessionCookie('alice@example.com', devEnv)
    expect(cookie.name).toBe(DEV_SESSION_COOKIE)
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' })
    expect(() => createDevSessionCookie('alice@example.com', { APP_ENV: 'test' })).toThrow('Dev login is disabled.')
  })
})

describe('getUserFromRequest', () => {
  it('reads the dev session cookie when DEV_AUTH is on', async () => {
    const value = signDevSession('alice@example.com', SECRET)
    const user = await getUserFromRequest(req(`other=1; ${DEV_SESSION_COOKIE}=${value}`), { env: devEnv })
    expect(user).toEqual({ id: devUserId('alice@example.com'), email: 'alice@example.com' })
  })

  it('ignores the dev cookie when DEV_AUTH is off', async () => {
    const value = signDevSession('alice@example.com', SECRET)
    expect(await getUserFromRequest(req(`${DEV_SESSION_COOKIE}=${value}`), { env: { SESSION_SECRET: SECRET } })).toBeNull()
  })

  it('returns null without cookies and without calling Supabase', async () => {
    const fetchMock = vi.fn()
    const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon' }
    expect(await getUserFromRequest(req(), { env, fetch: fetchMock as unknown as typeof fetch })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks Supabase for the user behind the auth cookie (mocked HTTP)', async () => {
    const session = {
      access_token: 'access-abc',
      refresh_token: 'refresh-abc',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'u-1', aud: 'authenticated', email: 'carol@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
    }
    const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      expect(url).toBe('https://proj.supabase.co/auth/v1/user')
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      expect(headers.get('authorization')).toBe('Bearer access-abc')
      return new Response(JSON.stringify({ ...session.user, id: '7d1f2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b', email: 'Carol@Example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon' }
    const user = await getUserFromRequest(req(`sb-proj-auth-token=${value}`), { env, fetch: fetchMock as unknown as typeof fetch })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(user).toEqual({ id: '7d1f2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b', email: 'carol@example.com' })
  })

  it('returns null when Supabase rejects the session', async () => {
    const value = `base64-${Buffer.from(JSON.stringify({ access_token: 'bad', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u' } })).toString('base64url')}`
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 401, msg: 'invalid JWT' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon' }
    expect(await getUserFromRequest(req(`sb-proj-auth-token=${value}`), { env, fetch: fetchMock as unknown as typeof fetch })).toBeNull()
  })
})
