// proxy.ts (formerly middleware.ts): Supabase session refresh on navigations, security headers on the consent and
// approval pages, and machine endpoints (/api/mcp, /oauth/token, webhooks) left untouched.

import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'
import { handleEdgeRequest, shouldSkip } from '@/lib/server/edge-session'
import { config as middlewareConfig } from '@/proxy'

const SUPABASE_URL = 'https://proj.supabase.co'
const deps = (fetch: typeof globalThis.fetch) => ({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: 'anon-key', fetch })

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.c2ln`

function sessionCookie(expiresAt: number): string {
  const user = { id: '0b8a1c52-2f1e-4b8a-9c6d-0e1f2a3b4c5d', aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
  const session = {
    access_token: jwt({ sub: user.id, exp: expiresAt, aud: 'authenticated', role: 'authenticated' }),
    refresh_token: 'old-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user,
  }
  return `sb-proj-auth-token=base64-${b64url(JSON.stringify(session))}`
}

describe('middleware', () => {
  it('leaves machine endpoints alone', async () => {
    for (const path of ['/api/mcp', '/oauth/token', '/oauth/register', '/oauth/revoke', '/api/stripe/webhook', '/api/webhooks/upload-post', '/api/cron/cleanup', '/.well-known/oauth-protected-resource']) {
      expect(shouldSkip(path), path).toBe(true)
    }
    for (const path of ['/app', '/oauth/authorize', '/approve/abc', '/api/uploads']) expect(shouldSkip(path), path).toBe(false)
    const fetchMock = vi.fn()
    const res = await handleEdgeRequest(new NextRequest('http://localhost:3000/api/mcp', { headers: { cookie: sessionCookie(1) } }), deps(fetchMock))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('has a matcher that excludes /api/mcp and /oauth/token', () => {
    const pattern = new RegExp(`^${middlewareConfig.matcher[0]}$`)
    expect(pattern.test('/api/mcp')).toBe(false)
    expect(pattern.test('/oauth/token')).toBe(false)
    expect(pattern.test('/app/brands')).toBe(true)
    expect(pattern.test('/oauth/authorize')).toBe(true)
  })

  it('adds anti-framing and no-referrer headers to the consent, approval and setup pages', async () => {
    for (const path of ['/oauth/authorize?client_id=x', '/approve/abcdef', '/setup']) {
      const res = await handleEdgeRequest(new NextRequest(`http://localhost:3000${path}`))
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
    const plain = await handleEdgeRequest(new NextRequest('http://localhost:3000/app'))
    expect(plain.headers.get('x-frame-options')).toBeNull()
  })

  it('does nothing without a Supabase session cookie', async () => {
    const fetchMock = vi.fn()
    await handleEdgeRequest(new NextRequest('http://localhost:3000/app'), deps(fetchMock))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes an expired Supabase session and writes the rotated cookies', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        return Response.json({
          access_token: jwt({ sub: '0b8a1c52-2f1e-4b8a-9c6d-0e1f2a3b4c5d', exp: now + 3600, aud: 'authenticated', role: 'authenticated' }),
          refresh_token: 'new-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: now + 3600,
          user: { id: '0b8a1c52-2f1e-4b8a-9c6d-0e1f2a3b4c5d', aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
        })
      }
      if (url.pathname === '/auth/v1/user') {
        return Response.json({ id: '0b8a1c52-2f1e-4b8a-9c6d-0e1f2a3b4c5d', aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' })
      }
      return Response.json({}, { status: 404 })
    })
    const req = new NextRequest('http://localhost:3000/app', { headers: { cookie: sessionCookie(now - 60) } })
    const res = await handleEdgeRequest(req, deps(fetchMock as unknown as typeof fetch))
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('grant_type=refresh_token'))).toBe(true)
    const written = res.cookies.get('sb-proj-auth-token')?.value ?? ''
    expect(written.startsWith('base64-')).toBe(true)
    expect(Buffer.from(written.slice(7), 'base64url').toString('utf8')).toContain('new-refresh-token')
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})
