// Sign-in routes: dev login (DEV_AUTH), logout, the Supabase magic link and its callback
// (Supabase Auth HTTP is mocked; nothing leaves the process).

import { users as usersRepo } from '@app/db'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as devLogin } from '@/app/api/auth/dev-login/route'
import { POST as logout } from '@/app/api/auth/logout/route'
import { POST as magicLink } from '@/app/api/auth/magic-link/route'
import { GET as callback } from '@/app/auth/callback/route'
import { DEV_SESSION_COOKIE, devUserId, getUserFromRequest } from '@/lib/auth'
import { resetRateLimitsForTests } from '@/lib/server/rate-limit'
import { BASE, createHarness, readJson, request, testEnv, type Harness } from './harness'

const SUPABASE_URL = 'https://proj.supabase.co'
const supabaseEnv = { SUPABASE_URL, SUPABASE_ANON_KEY: 'anon-key-for-tests' }

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.close()
})
afterEach(() => {
  resetRateLimitsForTests()
  h.install()
})

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie()
}

/** "name=value" pairs from Set-Cookie headers (non-empty values only). */
function cookieHeaderFrom(res: Response): string {
  return setCookies(res)
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => !c.endsWith('='))
    .join('; ')
}

describe('POST /api/auth/dev-login', () => {
  it('creates the user, starts the trial and sets the session cookie (form → redirect)', async () => {
    const res = await devLogin(request('/api/auth/dev-login', { form: { email: 'New.Person@Example.com', next: '/app/brands' }, headers: { origin: BASE } }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/app/brands')
    const cookie = setCookies(res).find((c) => c.startsWith(`${DEV_SESSION_COOKIE}=`))
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    const id = devUserId('new.person@example.com')
    const row = await h.rt.services.users.get(id)
    expect(row.email).toBe('new.person@example.com')
    expect(row.subscriptionStatus).toBe('trialing')
    // the cookie signs the user in
    const who = await getUserFromRequest(request('/x', { cookie: cookieHeaderFrom(res) }), { env: h.env })
    expect(who).toEqual({ id, email: 'new.person@example.com' })
  })

  it('answers JSON for JSON requests and never redirects off-site', async () => {
    const res = await devLogin(request('/api/auth/dev-login', { json: { email: 'json@example.com', next: '//evil.example/x' } }))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ user: { email: 'json@example.com' }, next: '/app' })
  })

  it('validates the email and refuses cross-site posts', async () => {
    let res = await devLogin(request('/api/auth/dev-login', { json: { email: 'not-an-email' } }))
    expect(res.status).toBe(400)
    res = await devLogin(request('/api/auth/dev-login', { json: { email: 42 } }))
    expect(res.status).toBe(400)
    res = await devLogin(request('/api/auth/dev-login', { json: { email: 'a@example.com' }, headers: { origin: 'https://evil.example' } }))
    expect(res.status).toBe(403)
  })

  it('is 404 when DEV_AUTH is off', async () => {
    h.install({ env: testEnv({ DEV_AUTH: undefined }) })
    const res = await devLogin(request('/api/auth/dev-login', { json: { email: 'a@example.com' } }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/auth/logout', () => {
  it('clears the dev and Supabase cookies', async () => {
    const res = await logout(request('/api/auth/logout', { form: {}, cookie: `${h.cookie('a@example.com')}; sb-proj-auth-token=abc`, headers: { origin: BASE } }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    const cleared = setCookies(res)
    expect(cleared.some((c) => c.startsWith(`${DEV_SESSION_COOKIE}=;`) && c.includes('Max-Age=0'))).toBe(true)
    expect(cleared.some((c) => c.startsWith('sb-proj-auth-token=;'))).toBe(true)
  })

  it('refuses cross-site logout', async () => {
    const res = await logout(request('/api/auth/logout', { json: {}, headers: { origin: 'https://evil.example' } }))
    expect(res.status).toBe(403)
  })
})

describe('Supabase magic link', () => {
  const supaUser = { id: '7d3c1a52-2f1e-4b8a-9c6d-0e1f2a3b4c5d', email: 'magic@example.com' }

  function mockSupabase() {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.origin !== SUPABASE_URL) throw new Error(`unexpected host ${url.origin}`)
      if (url.pathname === '/auth/v1/otp') return Response.json({})
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { auth_code?: string; code_verifier?: string }
        if (body.auth_code !== 'good-code' || !body.code_verifier) return Response.json({ error: 'invalid_grant', error_description: 'bad code' }, { status: 400 })
        const now = Math.floor(Date.now() / 1000)
        return Response.json({
          access_token: 'header.payload.signature',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: now + 3600,
          refresh_token: 'refresh-token-value',
          user: { id: supaUser.id, aud: 'authenticated', role: 'authenticated', email: supaUser.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        })
      }
      return Response.json({ message: 'not mocked' }, { status: 404 })
    })
  }

  it('sends the link with a PKCE verifier cookie and a callback redirect', async () => {
    const fetchMock = mockSupabase()
    h.install({ env: testEnv(supabaseEnv), fetch: fetchMock as unknown as typeof fetch })
    const res = await magicLink(request('/api/auth/magic-link', { json: { email: 'Magic@Example.com', next: '/app/voice' } }))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ sent: true })
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/auth/v1/otp'))
    expect(call).toBeDefined()
    const otpUrl = new URL(String(call?.[0]))
    expect(otpUrl.searchParams.get('redirect_to')).toBe(`${BASE}/auth/callback?next=${encodeURIComponent('/app/voice')}`)
    const sent = JSON.parse(String(call?.[1]?.body)) as { email: string; code_challenge?: string; code_challenge_method?: string }
    expect(sent.email).toBe('magic@example.com')
    expect(sent.code_challenge).toBeTruthy()
    expect(setCookies(res).some((c) => c.startsWith('sb-proj-auth-token-code-verifier='))).toBe(true)
  })

  it('exchanges the code on /auth/callback, creates the app user and redirects to next', async () => {
    const fetchMock = mockSupabase()
    h.install({ env: testEnv(supabaseEnv), fetch: fetchMock as unknown as typeof fetch })
    // Supabase Auth owns auth.users; simulate the row it creates.
    await usersRepo.devEnsureAuthUser(h.db, supaUser.id, supaUser.email)
    const sent = await magicLink(request('/api/auth/magic-link', { json: { email: supaUser.email } }))
    const verifierCookie = cookieHeaderFrom(sent)
    const res = await callback(request(`/auth/callback?code=good-code&next=${encodeURIComponent('/app/connect')}`, { cookie: verifierCookie }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/app/connect')
    expect(setCookies(res).some((c) => c.startsWith('sb-proj-auth-token=') && !c.startsWith('sb-proj-auth-token=;'))).toBe(true)
    const row = await h.rt.services.users.get(supaUser.id)
    expect(row.email).toBe(supaUser.email)
    expect(row.subscriptionStatus).toBe('trialing')
  })

  it('sends failed or expired links back to /login', async () => {
    h.install({ env: testEnv(supabaseEnv), fetch: mockSupabase() as unknown as typeof fetch })
    let res = await callback(request('/auth/callback?code=bad-code'))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toMatch(/^\/login\?error=link_invalid/)
    res = await callback(request('/auth/callback?error=access_denied&error_code=otp_expired&next=//evil.example'))
    expect(res.headers.get('location')).toBe(`/login?error=link_expired&next=${encodeURIComponent('/app')}`)
    res = await callback(request('/auth/callback?type=bogus&token_hash=abc'))
    expect(res.headers.get('location')).toMatch(/^\/login\?error=link_invalid/)
  })

  it('reports when Supabase is not configured', async () => {
    let res = await magicLink(request('/api/auth/magic-link', { json: { email: 'a@example.com' } }))
    expect(res.status).toBe(503)
    res = await callback(request('/auth/callback?code=x'))
    expect(res.headers.get('location')).toMatch(/^\/login\?error=not_configured/)
  })

  it('validates input and rate-limits per IP', async () => {
    h.install({ env: testEnv(supabaseEnv), fetch: mockSupabase() as unknown as typeof fetch })
    expect((await magicLink(request('/api/auth/magic-link', { json: { email: 'nope' } }))).status).toBe(400)
    let last: Response | null = null
    for (let i = 0; i < 6; i++) last = await magicLink(request('/api/auth/magic-link', { json: { email: 'a@example.com' }, headers: { 'x-forwarded-for': '198.51.100.7' } }))
    expect(last?.status).toBe(429)
  })
})
