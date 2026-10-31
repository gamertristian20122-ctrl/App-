// Unit tests for the web layer's own helpers (lib/server): redirects, origin checks, body
// limits, rate limits, OAuth challenge/metadata URLs, cookies and field checks.

import { afterEach, describe, expect, it } from 'vitest'
import { expireCookie, serializeCookie } from '@/lib/server/cookies'
import { checkCronAuth } from '@/lib/server/cron'
import { clientIp, isSameOrigin, readBody, readBodyText, safeNext } from '@/lib/server/http'
import { mcpAllowedOrigins, mcpCorsHeaders } from '@/lib/server/mcp'
import { authorizeQuery, mcpChallenge, pickAuthorizeParams, protectedResourceMetadataUrl, redirectUriProblem } from '@/lib/server/oauth'
import { hitRateLimit, resetRateLimitsForTests } from '@/lib/server/rate-limit'
import { enumField, quantityField, stringField } from '@/lib/server/validate'

afterEach(() => resetRateLimitsForTests())

describe('safeNext', () => {
  it('keeps same-site paths and refuses everything else', () => {
    expect(safeNext('/app/brands?x=1#y')).toBe('/app/brands?x=1#y')
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', 'app', '/a\nb', undefined, 42, `/${'a'.repeat(3000)}`]) {
      expect(safeNext(bad), String(bad)).toBe('/app')
    }
    expect(safeNext('nope', '/')).toBe('/')
  })
})

describe('isSameOrigin', () => {
  const app = 'https://app.example'
  const req = (headers: Record<string, string>) => new Request('https://app.example/api/x', { method: 'POST', headers })
  it('accepts our origin, same-origin fetches and header-less clients', () => {
    expect(isSameOrigin(req({ origin: 'https://app.example' }), app)).toBe(true)
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' }), app)).toBe(true)
    expect(isSameOrigin(req({}), app)).toBe(true)
  })
  it('refuses foreign and null origins and cross-site fetches', () => {
    expect(isSameOrigin(req({ origin: 'https://evil.example' }), app)).toBe(false)
    expect(isSameOrigin(req({ origin: 'null' }), app)).toBe(false)
    expect(isSameOrigin(req({ 'sec-fetch-site': 'cross-site' }), app)).toBe(false)
  })
})

describe('body reading', () => {
  it('enforces size limits (declared and actual)', async () => {
    expect(await readBodyText(new Request('http://x/', { method: 'POST', body: 'abc' }), 10)).toBe('abc')
    expect(await readBodyText(new Request('http://x/', { method: 'POST', body: 'x'.repeat(11) }), 10)).toBeNull()
    expect(await readBodyText(new Request('http://x/', { method: 'POST', body: 'abc', headers: { 'content-length': '999' } }), 10)).toBeNull()
  })
  it('parses JSON objects and forms, refuses other types', async () => {
    const json = await readBody(new Request('http://x/', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json; charset=utf-8' } }), 100)
    expect(json).toMatchObject({ ok: true, kind: 'json', data: { a: 1 } })
    const form = await readBody(new Request('http://x/', { method: 'POST', body: 'a=1&a=2&b=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 100)
    expect(form).toMatchObject({ ok: true, kind: 'form', data: { a: '1', b: 'x' } })
    const arr = await readBody(new Request('http://x/', { method: 'POST', body: '[1]', headers: { 'content-type': 'application/json' } }), 100)
    expect(arr.ok).toBe(false)
    const text = await readBody(new Request('http://x/', { method: 'POST', body: 'a', headers: { 'content-type': 'text/plain' } }), 100)
    expect(text.ok ? 0 : text.response.status).toBe(415)
  })
})

describe('clientIp', () => {
  it('uses the first x-forwarded-for entry, then x-real-ip', () => {
    expect(clientIp(new Request('http://x/', { headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' } }))).toBe('203.0.113.1')
    expect(clientIp(new Request('http://x/', { headers: { 'x-real-ip': '203.0.113.2' } }))).toBe('203.0.113.2')
    expect(clientIp(new Request('http://x/'))).toBe('unknown')
  })
})

describe('rate limits', () => {
  it('counts per key within a window and resets after it', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) expect(hitRateLimit('magicLink', 'ip1', t0).ok).toBe(true)
    const blocked = hitRateLimit('magicLink', 'ip1', t0 + 1000)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBe(59)
    expect(hitRateLimit('magicLink', 'ip2', t0).ok).toBe(true)
    expect(hitRateLimit('magicLink', 'ip1', t0 + 60_000).ok).toBe(true)
  })
})

describe('OAuth helpers', () => {
  it('derives the path-suffixed protected resource metadata URL', () => {
    expect(protectedResourceMetadataUrl({ MCP_RESOURCE_URL: 'https://app.example/api/mcp' })).toBe('https://app.example/.well-known/oauth-protected-resource/api/mcp')
    expect(protectedResourceMetadataUrl({ MCP_RESOURCE_URL: 'https://mcp.example' })).toBe('https://mcp.example/.well-known/oauth-protected-resource')
  })

  it('builds the 401 challenge', () => {
    const cfg = { MCP_RESOURCE_URL: 'https://app.example/api/mcp' }
    expect(mcpChallenge(cfg)).toBe('Bearer resource_metadata="https://app.example/.well-known/oauth-protected-resource/api/mcp", scope="social"')
    expect(mcpChallenge(cfg, 'invalid_token')).toContain(', error="invalid_token"')
  })

  it('allows https and loopback redirect URIs only', () => {
    for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback', 'http://127.0.0.1:5555/cb', 'http://[::1]:8080/cb']) {
      expect(redirectUriProblem(ok), ok).toBeNull()
    }
    // desktop AI clients (Cursor, VS Code) use their own scheme; other app schemes stay refused
    for (const app of ['cursor://anysphere.cursor-mcp/oauth/callback', 'vscode://vscode.github-authentication/did-authenticate']) {
      expect(redirectUriProblem(app), app).toBeNull()
    }
    for (const bad of ['http://example.com/cb', 'myapp://x/cb', 'javascript:alert(1)', 'data:text/html,x', 'relative/path', 42]) {
      expect(redirectUriProblem(bad), String(bad)).not.toBeNull()
    }
  })

  it('picks authorization parameters and flags repeats', () => {
    const q = new URLSearchParams('client_id=a&state=s&extra=1')
    expect(pickAuthorizeParams(q)).toEqual({ params: { client_id: 'a', state: 's' }, duplicate: false })
    expect(pickAuthorizeParams({ client_id: ['a', 'b'] }).duplicate).toBe(true)
    expect(authorizeQuery({ client_id: 'a b', state: 's' })).toBe('client_id=a+b&state=s')
  })
})

describe('MCP CORS', () => {
  it('reflects only allowed origins', () => {
    const cfg = { APP_URL: 'https://app.example', APP_ENV: 'production' as const }
    expect(mcpAllowedOrigins(cfg)).toEqual(['https://claude.ai', 'https://claude.com', 'https://chatgpt.com', 'https://chat.openai.com'])
    expect(mcpAllowedOrigins(cfg)).not.toContain('http://localhost:6274')
    expect(mcpCorsHeaders(new Request('https://app.example/api/mcp', { headers: { origin: 'https://app.example' } }), cfg)['access-control-allow-origin']).toBe('https://app.example')
    expect(mcpCorsHeaders(new Request('https://app.example/api/mcp', { headers: { origin: 'http://localhost:6274' } }), cfg)).toEqual({})
    expect(mcpCorsHeaders(new Request('https://app.example/api/mcp'), cfg)).toEqual({})
  })
})

describe('cron auth', () => {
  it('needs the exact bearer secret', () => {
    const req = (auth?: string) => new Request('http://x/', auth ? { headers: { authorization: auth } } : {})
    expect(checkCronAuth(req('Bearer s3cret-s3cret-s3cret'), 's3cret-s3cret-s3cret')).toBeNull()
    expect(checkCronAuth(req('Bearer nope'), 's3cret-s3cret-s3cret')?.status).toBe(401)
    expect(checkCronAuth(req(), 's3cret-s3cret-s3cret')?.status).toBe(401)
    expect(checkCronAuth(req('Bearer x'), undefined)?.status).toBe(503)
  })
})

describe('cookies and fields', () => {
  it('serialises cookies', () => {
    expect(serializeCookie('a', 'b c', { httpOnly: true, secure: true, maxAge: 60, sameSite: 'lax' })).toBe('a=b%20c; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure')
    expect(expireCookie('a')).toContain('Max-Age=0')
  })
  it('checks fields', () => {
    expect(stringField(' a ', { max: 3, trim: true })).toEqual({ ok: true, value: 'a' })
    expect(stringField('abcd', { max: 3 }).ok).toBe(false)
    expect(stringField(undefined, { max: 3, optional: true })).toEqual({ ok: true, value: undefined })
    expect(stringField(5, { max: 3 }).ok).toBe(false)
    expect(enumField(undefined, ['a', 'b'] as const, 'a')).toEqual({ ok: true, value: 'a' })
    expect(enumField('c', ['a', 'b'] as const).ok).toBe(false)
    expect(quantityField('12')).toEqual({ ok: true, value: 12 })
    expect(quantityField('')).toEqual({ ok: true, value: 0 })
    expect(quantityField('1e3').ok).toBe(false)
    expect(quantityField(2.5).ok).toBe(false)
  })
})
