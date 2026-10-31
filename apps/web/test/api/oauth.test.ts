// OAuth for MCP clients: discovery documents, dynamic client registration, the consent step,
// the token endpoint (code + PKCE, refresh rotation, reuse detection), revocation, and the
// bearer check on /api/mcp (with @app/mcp mocked).

import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mcp = vi.hoisted(() => ({
  handleMcpRequest: vi.fn(async (_req: Request, _ctx: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result: {} })),
}))
vi.mock('@app/mcp', () => mcp)

import { GET as asMetadata } from '@/app/.well-known/oauth-authorization-server/route'
import { GET as prmRoot } from '@/app/.well-known/oauth-protected-resource/route'
import { GET as prmMcp, OPTIONS as prmOptions } from '@/app/.well-known/oauth-protected-resource/api/mcp/route'
import { GET as mcpGet, OPTIONS as mcpOptions, POST as mcpPost } from '@/app/api/mcp/route'
import { POST as register } from '@/app/oauth/register/route'
import { POST as revoke } from '@/app/oauth/revoke/route'
import { POST as token } from '@/app/oauth/token/route'
import { decideConsent, loadConsent } from '@/lib/server/oauth'
import { resetRateLimitsForTests } from '@/lib/server/rate-limit'
import { BASE, createHarness, readJson, request, type Harness } from './harness'

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const RESOURCE = `${BASE}/api/mcp`

let h: Harness
let user: { id: string; email: string }

beforeAll(async () => {
  h = await createHarness()
  user = await h.createUser('owner@example.com')
})
afterAll(async () => {
  await h.close()
})
beforeEach(() => {
  resetRateLimitsForTests()
  mcp.handleMcpRequest.mockClear()
})

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function registerClient(redirectUris: string[] = [REDIRECT], name = 'Claude') {
  const res = await register(request('/oauth/register', { json: { client_name: name, redirect_uris: redirectUris } }))
  return { res, body: await readJson<Record<string, unknown>>(res) }
}

async function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'social',
    resource: RESOURCE,
    state: 'xyz-state',
    ...extra,
  })
}

/** register → consent (approve) → code. */
async function getCode() {
  const { body } = await registerClient()
  const clientId = body.client_id as string
  const { verifier, challenge } = pkce()
  const query = await authorizeParams(clientId, challenge)
  const decided = await decideConsent(h.rt.services, user, query, 'approve')
  expect(decided.kind).toBe('redirect')
  const url = new URL((decided as { url: string }).url)
  return { clientId, verifier, code: url.searchParams.get('code') as string, url }
}

const tokenRequest = (form: Record<string, string>) => token(request('/oauth/token', { form }))

describe('discovery documents', () => {
  it('serves protected resource metadata at both paths', async () => {
    for (const handler of [prmRoot, prmMcp]) {
      const res = await handler()
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      const body = await readJson(res)
      expect(body).toMatchObject({ resource: RESOURCE, authorization_servers: [BASE], scopes_supported: ['social'], bearer_methods_supported: ['header'] })
    }
    const pre = prmOptions()
    expect(pre.status).toBe(204)
  })

  it('serves RFC 8414 authorization server metadata (DCR, S256 only, public clients)', async () => {
    const res = await asMetadata()
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['social'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    })
  })
})

describe('POST /oauth/register', () => {
  it('registers a public client with https and loopback redirect URIs', async () => {
    const { res, body } = await registerClient([REDIRECT, 'http://localhost/callback', 'http://127.0.0.1:33418/cb'])
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({ token_endpoint_auth_method: 'none', response_types: ['code'], client_name: 'Claude' })
    expect(String(body.client_id)).toMatch(/^mcp_/)
  })

  it('accepts Cursor\'s app-scheme redirect URI (integration: Cursor is a supported AI client)', async () => {
    const { res, body } = await registerClient(['cursor://anysphere.cursor-mcp/oauth/callback'])
    expect(res.status).toBe(201)
    expect(body.redirect_uris).toEqual(['cursor://anysphere.cursor-mcp/oauth/callback'])
  })

  it('refuses non-https, non-loopback and unknown app-scheme redirect URIs', async () => {
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'myapp://x/oauth/callback', 'not a url', 'https://ok.example/cb#frag']) {
      const { res, body } = await registerClient([bad])
      expect(res.status, bad).toBe(400)
      expect(body.error, bad).toBe('invalid_redirect_uri')
    }
  })

  it('validates the metadata', async () => {
    let res = await register(request('/oauth/register', { json: { client_name: 'x' } }))
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_client_metadata')
    res = await register(request('/oauth/register', { json: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' } }))
    expect((await readJson(res)).error).toBe('invalid_client_metadata')
    res = await register(request('/oauth/register', { json: { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] } }))
    expect((await readJson(res)).error).toBe('invalid_client_metadata')
    res = await register(request('/oauth/register', { body: 'redirect_uris=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))
    expect(res.status).toBe(415)
    res = await register(request('/oauth/register', { body: '{bad json', headers: { 'content-type': 'application/json' } }))
    expect(res.status).toBe(400)
    res = await register(request('/oauth/register', { json: { redirect_uris: [REDIRECT], client_name: 'x'.repeat(20_000) } }))
    expect(res.status).toBe(413)
  })

  it('rate-limits registrations per IP', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.9' }
    let last: Response | null = null
    for (let i = 0; i < 31; i++) {
      last = await register(request('/oauth/register', { json: { redirect_uris: [REDIRECT] }, headers: ip }))
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get('retry-after')).toMatch(/^\d+$/)
    // another IP is unaffected
    const other = await register(request('/oauth/register', { json: { redirect_uris: [REDIRECT] }, headers: { 'x-forwarded-for': '203.0.113.10' } }))
    expect(other.status).toBe(201)
  })
})

describe('consent (/oauth/authorize)', () => {
  it('sends signed-out users to /login with the request as next', async () => {
    const { body } = await registerClient()
    const query = await authorizeParams(body.client_id as string, pkce().challenge)
    const state = await loadConsent(h.rt.services, null, query)
    expect(state.kind).toBe('login')
    const url = new URL((state as { url: string }).url, BASE)
    expect(url.pathname).toBe('/login')
    expect(url.searchParams.get('next')).toMatch(/^\/oauth\/authorize\?/)
    expect(url.searchParams.get('next')).toContain(`client_id=${body.client_id}`)
  })

  it('shows client name, scope and redirect host to a signed-in user', async () => {
    const { body } = await registerClient([REDIRECT], 'Claude Desktop')
    const state = await loadConsent(h.rt.services, user, await authorizeParams(body.client_id as string, pkce().challenge))
    expect(state.kind).toBe('consent')
    if (state.kind !== 'consent') return
    expect(state.request.client.name).toBe('Claude Desktop')
    expect(state.request.scope).toBe('social')
    expect(state.request.redirectHost).toBe('claude.ai')
    expect(state.loopback).toBe(false)
  })

  it('shows errors for unknown clients and mismatched redirect URIs (never redirects there)', async () => {
    let state = await loadConsent(h.rt.services, user, await authorizeParams('mcp_unknown_client_id', pkce().challenge))
    expect(state.kind).toBe('error')
    const { body } = await registerClient()
    state = await loadConsent(h.rt.services, user, await authorizeParams(body.client_id as string, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }))
    expect(state.kind).toBe('error')
    const dup = new URLSearchParams(await authorizeParams(body.client_id as string, pkce().challenge))
    dup.append('scope', 'social')
    state = await loadConsent(h.rt.services, user, dup)
    expect(state.kind).toBe('error')
  })

  it('shows protocol errors with a click-through link back to the client, never an automatic redirect (review: open redirect via DCR)', async () => {
    const { body } = await registerClient()
    let state = await loadConsent(h.rt.services, user, await authorizeParams(body.client_id as string, pkce().challenge, { code_challenge_method: 'plain' }))
    expect(state.kind).toBe('error')
    if (state.kind !== 'error') return
    expect(state.message).toMatch(/S256/)
    expect(state.returnTo?.host).toBe(new URL(REDIRECT).host)
    let url = new URL(state.returnTo?.url ?? '')
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('error')).toBe('invalid_request')
    expect(url.searchParams.get('state')).toBe('xyz-state')
    state = await loadConsent(h.rt.services, user, await authorizeParams(body.client_id as string, pkce().challenge, { resource: 'https://other.example/mcp' }))
    expect(state.kind).toBe('error')
    url = new URL((state as { returnTo: { url: string } }).returnTo.url)
    expect(url.searchParams.get('error')).toBe('invalid_target')
    // signed out too: an attacker-registered client cannot bounce visitors off our domain
    state = await loadConsent(h.rt.services, null, await authorizeParams(body.client_id as string, pkce().challenge, { response_type: 'token' }))
    expect(state.kind).toBe('error')
  })

  it('deny returns access_denied with state and iss', async () => {
    const { body } = await registerClient()
    const result = await decideConsent(h.rt.services, user, await authorizeParams(body.client_id as string, pkce().challenge), 'deny')
    expect(result.kind).toBe('redirect')
    const url = new URL((result as { url: string }).url)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('xyz-state')
    expect(url.searchParams.get('iss')).toBe(BASE)
    expect(url.searchParams.has('code')).toBe(false)
  })

  it('approve returns a code with state and iss', async () => {
    const { url } = await getCode()
    expect(url.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(url.searchParams.get('state')).toBe('xyz-state')
    expect(url.searchParams.get('iss')).toBe(BASE)
  })
})

describe('POST /oauth/token', () => {
  it('exchanges a code with PKCE, rotates refresh tokens and detects reuse', async () => {
    const used = await getCode()
    const res0 = await tokenRequest({ grant_type: 'authorization_code', code: used.code, code_verifier: used.verifier, client_id: used.clientId })
    const replayed = await readJson<{ refresh_token: string }>(res0)
    // the code is single-use, and a second redemption revokes what the first one issued
    const again = await tokenRequest({ grant_type: 'authorization_code', code: used.code, code_verifier: used.verifier, client_id: used.clientId })
    expect(again.status).toBe(400)
    expect((await readJson(again)).error).toBe('invalid_grant')
    expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: replayed.refresh_token, client_id: used.clientId })).status).toBe(400)

    const { clientId, verifier, code } = await getCode()
    const res = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const first = await readJson<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string }>(res)
    expect(first).toMatchObject({ token_type: 'Bearer', scope: 'social' })
    expect(first.expires_in).toBeGreaterThan(0)

    // refresh → new pair; the old refresh token is rotated out
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })
    expect(refreshed.status).toBe(200)
    const second = await readJson<{ access_token: string; refresh_token: string }>(refreshed)
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(second.access_token).not.toBe(first.access_token)

    // the new access token works on /api/mcp
    let mcpRes = await mcpPost(request('/api/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { authorization: `Bearer ${second.access_token}` } }))
    expect(mcpRes.status).toBe(200)

    // reuse of the rotated refresh token → invalid_grant and the whole family is revoked
    const reuse = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })
    expect(reuse.status).toBe(400)
    expect((await readJson(reuse)).error).toBe('invalid_grant')
    const afterReuse = await tokenRequest({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: clientId })
    expect(afterReuse.status).toBe(400)
    mcpRes = await mcpPost(request('/api/mcp', { json: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: { authorization: `Bearer ${second.access_token}` } }))
    expect(mcpRes.status).toBe(401)
    expect(mcpRes.headers.get('www-authenticate')).toContain('error="invalid_token"')
  })

  it('refuses a wrong code_verifier, another client, a wrong redirect_uri and unknown grants', async () => {
    const a = await getCode()
    let res = await tokenRequest({ grant_type: 'authorization_code', code: a.code, code_verifier: pkce().verifier, client_id: a.clientId })
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_grant')

    const b = await getCode()
    const other = await registerClient()
    res = await tokenRequest({ grant_type: 'authorization_code', code: b.code, code_verifier: b.verifier, client_id: other.body.client_id as string })
    expect((await readJson(res)).error).toBe('invalid_grant')

    const c = await getCode()
    res = await tokenRequest({ grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, client_id: c.clientId, redirect_uri: 'https://claude.ai/other' })
    expect((await readJson(res)).error).toBe('invalid_grant')

    res = await tokenRequest({ grant_type: 'client_credentials', client_id: c.clientId })
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('unsupported_grant_type')

    res = await tokenRequest({ grant_type: 'authorization_code', code: 'x', code_verifier: 'y', client_id: 'mcp_nope_nope_nope' })
    expect(res.status).toBe(401)
    expect((await readJson(res)).error).toBe('invalid_client')
  })

  it('accepts client_id from HTTP Basic and refuses unsupported bodies', async () => {
    const { clientId, verifier, code } = await getCode()
    const basic = Buffer.from(`${clientId}:`).toString('base64')
    const res = await token(request('/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier }, headers: { authorization: `Basic ${basic}` } }))
    expect(res.status).toBe(200)
    const text = await token(request('/oauth/token', { body: 'grant_type=x', headers: { 'content-type': 'text/plain' } }))
    expect(text.status).toBe(400)
    expect((await readJson(text)).error).toBe('invalid_request')
  })
})

describe('POST /oauth/revoke', () => {
  it('revokes a refresh token family and always answers 200', async () => {
    const { clientId, verifier, code } = await getCode()
    const pair = await readJson<{ access_token: string; refresh_token: string }>(
      await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId }),
    )
    const res = await revoke(request('/oauth/revoke', { form: { token: pair.refresh_token, token_type_hint: 'refresh_token', client_id: clientId } }))
    expect(res.status).toBe(200)
    const unknown = await revoke(request('/oauth/revoke', { form: { token: 'x'.repeat(43) } }))
    expect(unknown.status).toBe(200)
    const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: clientId })
    expect(refresh.status).toBe(400)
    const mcpRes = await mcpPost(request('/api/mcp', { json: {}, headers: { authorization: `Bearer ${pair.access_token}` } }))
    expect(mcpRes.status).toBe(401)
  })
})

describe('/api/mcp bearer check', () => {
  const prm = `${BASE}/.well-known/oauth-protected-resource/api/mcp`

  it('answers 401 with WWW-Authenticate (resource_metadata, no error) without a token', async () => {
    for (const handler of [mcpPost, mcpGet]) {
      const res = await handler(request('/api/mcp', { method: handler === mcpGet ? 'GET' : 'POST', ...(handler === mcpGet ? {} : { json: {} }) }))
      expect(res.status).toBe(401)
      const challenge = res.headers.get('www-authenticate') ?? ''
      expect(challenge).toMatch(/^Bearer /)
      expect(challenge).toContain(`resource_metadata="${prm}"`)
      expect(challenge).toContain('scope="social"')
      expect(challenge).not.toContain('error=')
    }
    expect(mcp.handleMcpRequest).not.toHaveBeenCalled()
  })

  it('answers 401 error="invalid_token" for bad tokens', async () => {
    for (const auth of ['Bearer not-a-real-token-but-long-enough-0123456789abcdef', 'Bearer x', 'Basic abc']) {
      const res = await mcpPost(request('/api/mcp', { json: {}, headers: { authorization: auth } }))
      expect(res.status).toBe(401)
      if (auth.startsWith('Bearer')) expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    }
    expect(mcp.handleMcpRequest).not.toHaveBeenCalled()
  })

  it('passes the untouched request and the user to @app/mcp', async () => {
    const { clientId, verifier, code } = await getCode()
    const pair = await readJson<{ access_token: string }>(await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId }))
    const req = request('/api/mcp', { json: { jsonrpc: '2.0', id: 7, method: 'tools/list' }, headers: { authorization: `Bearer ${pair.access_token}`, origin: BASE } })
    const res = await mcpPost(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(BASE)
    expect(mcp.handleMcpRequest).toHaveBeenCalledTimes(1)
    const [passed, ctx] = mcp.handleMcpRequest.mock.calls[0] as [Request, { userId: string; baseUrl: string; services: unknown }]
    expect(passed).toBe(req)
    expect(passed.bodyUsed).toBe(false)
    expect(ctx.userId).toBe(user.id)
    expect(ctx.baseUrl).toBe(BASE)
    expect(ctx.services).toBe(h.rt.services)
  })

  it('answers CORS preflights for allowed browser origins only', async () => {
    const ok = await mcpOptions(request('/api/mcp', { method: 'OPTIONS', headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' } }))
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:6274')
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization')
    const denied = await mcpOptions(request('/api/mcp', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    const unauth = await mcpPost(request('/api/mcp', { json: {}, headers: { origin: 'http://localhost:6274' } }))
    expect(unauth.headers.get('access-control-expose-headers')).toContain('www-authenticate')
  })

  it('does not turn a verification failure into 401 (clients would re-authenticate)', async () => {
    const spy = vi.spyOn(h.rt.services.oauth, 'verifyAccessToken').mockRejectedValueOnce(new Error('db down'))
    const res = await mcpPost(request('/api/mcp', { json: {}, headers: { authorization: `Bearer ${'a'.repeat(43)}` } }))
    expect(res.status).toBe(503)
    spy.mockRestore()
  })

  it('rate-limits per user', async () => {
    const { clientId, verifier, code } = await getCode()
    const pair = await readJson<{ access_token: string }>(await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId }))
    let last: Response | null = null
    for (let i = 0; i < 241; i++) {
      last = await mcpPost(request('/api/mcp', { json: {}, headers: { authorization: `Bearer ${pair.access_token}` } }))
    }
    expect(last?.status).toBe(429)
  })
})
