import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { checkRedirectUri, oauthErrorResponse, pkceChallenge, redirectUriMatches } from '../src'
import { HOUR, DAY, createHarness, expectAppError, resetHarness, tenant, type Harness } from './helpers'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.db.close()
})
beforeEach(async () => {
  await resetHarness(h)
})

const MCP = 'https://app.test/api/mcp'
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback'
const verifier = () => randomBytes(32).toString('base64url')

async function register(redirectUris: string[] = [CLAUDE, 'http://localhost/callback']) {
  return h.s.oauth.registerClient({ redirect_uris: redirectUris, client_name: 'Claude', token_endpoint_auth_method: 'none' })
}

/** Runs authorize (approve) and returns the code from the redirect. */
async function authorizeCode(userId: string, clientId: string, v: string, extra: Record<string, string> = {}) {
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE,
    code_challenge: pkceChallenge(v),
    code_challenge_method: 'S256',
    scope: 'social',
    resource: MCP,
    state: 'st-1',
    ...extra,
  }
  const { redirectTo } = await h.s.oauth.authorize(userId, params, 'approve')
  const url = new URL(redirectTo)
  return { code: url.searchParams.get('code') ?? '', url }
}

describe('oauth helpers', () => {
  it('accepts https, loopback http and app schemes as redirect URIs; refuses the rest', () => {
    expect(checkRedirectUri(CLAUDE)).toBe(CLAUDE)
    expect(checkRedirectUri('http://127.0.0.1:33418/callback')).not.toBeNull()
    expect(checkRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).not.toBeNull()
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'https://a.test/cb#frag', 'https://u:p@a.test/cb', 'file:///etc/passwd', '']) {
      expect(checkRedirectUri(bad), bad).toBeNull()
    }
  })

  it('matches redirect URIs exactly, except the port of loopback URIs', () => {
    expect(redirectUriMatches(CLAUDE, CLAUDE)).toBe(true)
    expect(redirectUriMatches(CLAUDE, `${CLAUDE}x`)).toBe(false)
    expect(redirectUriMatches('http://localhost/callback', 'http://localhost:51234/callback')).toBe(true)
    expect(redirectUriMatches('http://localhost/callback', 'http://localhost:51234/other')).toBe(false)
    expect(redirectUriMatches('http://localhost/callback', 'http://127.0.0.1:51234/callback')).toBe(false)
    expect(redirectUriMatches('https://a.test/cb', 'https://a.test:8443/cb')).toBe(false)
  })

  it('maps errors to RFC 6749 bodies without leaking unexpected messages', () => {
    expect(oauthErrorResponse(new Error('db password=hunter2 exploded'))).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: expect.not.stringContaining('hunter2') },
    })
  })
})

describe('oauth flow', () => {
  it('registers a public client, issues a code with PKCE and exchanges it for a token pair bound to the MCP resource', async () => {
    const { userId } = await tenant(h)
    const client = await register()
    expect(client).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'social' })
    expect(client.client_id).toMatch(/^mcp_/)

    const request = await h.s.oauth.validateAuthorizeRequest({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CLAUDE,
      code_challenge: pkceChallenge(verifier()),
      code_challenge_method: 'S256',
      resource: `${MCP}/`,
      state: 'abc',
    })
    expect(request).toMatchObject({ client: { name: 'Claude' }, redirectHost: 'claude.ai', scope: 'social', resource: MCP, state: 'abc' })

    const v = verifier()
    const { code, url } = await authorizeCode(userId, client.client_id, v)
    expect(url.origin + url.pathname).toBe(CLAUDE)
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('iss')).toBe('https://app.test')
    // only the hash is stored
    const codes = await h.db.query<{ code_hash: string }>('select code_hash from public.oauth_codes')
    expect(codes[0]?.code_hash).not.toBe(code)

    const tokens = await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: client.client_id, redirect_uri: CLAUDE, resource: MCP })
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3_600, scope: 'social' })
    const ctx = await h.s.oauth.verifyAccessToken(`Bearer ${tokens.access_token}`)
    expect(ctx).toMatchObject({ userId, clientId: client.client_id, scopes: ['social'] })

    // the code is single use
    const reused = await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: client.client_id }), 'bad_request')
    expect(oauthErrorResponse(reused).body.error).toBe('invalid_grant')
  })

  it('refuses a wrong PKCE verifier, another client, a mismatched redirect and expired codes', async () => {
    const { userId } = await tenant(h)
    const a = await register()
    const b = await register()
    const v = verifier()
    const c1 = await authorizeCode(userId, a.client_id, v)
    const bad = await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code: c1.code, code_verifier: verifier(), client_id: a.client_id }), 'bad_request', /code_verifier/)
    expect(bad.details).toMatchObject({ oauthError: 'invalid_grant' })

    const c2 = await authorizeCode(userId, a.client_id, v)
    await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code: c2.code, code_verifier: v, client_id: b.client_id }), 'bad_request', /another client/)

    const c3 = await authorizeCode(userId, a.client_id, v)
    await expectAppError(
      h.s.oauth.token({ grant_type: 'authorization_code', code: c3.code, code_verifier: v, client_id: a.client_id, redirect_uri: 'https://claude.ai/other' }),
      'bad_request',
      /redirect_uri/,
    )

    const c4 = await authorizeCode(userId, a.client_id, v)
    h.clock.advance(301_000)
    await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code: c4.code, code_verifier: v, client_id: a.client_id }), 'bad_request', /expired/)

    const unknown = await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code: c4.code, code_verifier: v, client_id: 'mcp_nope_nope' }), 'unauthorized')
    expect(oauthErrorResponse(unknown).status).toBe(401)
    await expectAppError(h.s.oauth.token({ grant_type: 'password', username: 'x' }), 'bad_request', /grant_type/)
  })

  it('a wrong verifier or client does not use up the code (review: anyone holding the code could burn it)', async () => {
    const { userId } = await tenant(h)
    const a = await register()
    const b = await register()
    const v = verifier()
    const { code } = await authorizeCode(userId, a.client_id, v)
    await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: verifier(), client_id: a.client_id }), 'bad_request', /code_verifier/)
    await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: b.client_id }), 'bad_request', /another client/)
    const tokens = await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: a.client_id })
    expect(tokens.token_type).toBe('Bearer')
  })

  it('a second redemption of a code revokes the tokens the first one issued (review: OAuth 2.1 §4.1.3)', async () => {
    const { userId } = await tenant(h)
    const a = await register()
    const v = verifier()
    const { code } = await authorizeCode(userId, a.client_id, v)
    const first = await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: a.client_id })
    expect(await h.s.oauth.verifyAccessToken(`Bearer ${first.access_token}`)).toMatchObject({ userId })
    const replay = await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: a.client_id }), 'bad_request')
    expect(oauthErrorResponse(replay).body.error).toBe('invalid_grant')
    await expectAppError(h.s.oauth.verifyAccessToken(`Bearer ${first.access_token}`), 'unauthorized')
    await expectAppError(h.s.oauth.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: a.client_id }), 'bad_request')
    // even a replay with a wrong verifier counts: the code was already used
    const other = await authorizeCode(userId, a.client_id, v)
    const second = await h.s.oauth.token({ grant_type: 'authorization_code', code: other.code, code_verifier: v, client_id: a.client_id })
    await expectAppError(h.s.oauth.token({ grant_type: 'authorization_code', code: other.code, code_verifier: verifier(), client_id: a.client_id }), 'bad_request')
    await expectAppError(h.s.oauth.verifyAccessToken(`Bearer ${second.access_token}`), 'unauthorized')
  })

  it('rotates refresh tokens and revokes the family when a rotated token is reused', async () => {
    const { userId } = await tenant(h)
    const client = await register()
    const v = verifier()
    const { code } = await authorizeCode(userId, client.client_id, v)
    const first = await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: client.client_id })
    const second = await h.s.oauth.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client.client_id })
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect((await h.s.oauth.verifyAccessToken(second.access_token)).userId).toBe(userId)

    // replaying the rotated refresh token is theft: the whole family dies
    const reuse = await expectAppError(h.s.oauth.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client.client_id }), 'bad_request', /already used/)
    expect(reuse.details).toMatchObject({ oauthError: 'invalid_grant' })
    await expectAppError(h.s.oauth.verifyAccessToken(second.access_token), 'unauthorized')
    await expectAppError(h.s.oauth.token({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: client.client_id }), 'bad_request')
  })

  it('a refresh cannot add scopes or switch client', async () => {
    const { userId } = await tenant(h)
    const a = await register()
    const b = await register()
    const v = verifier()
    const { code } = await authorizeCode(userId, a.client_id, v)
    const t = await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: a.client_id })
    await expectAppError(h.s.oauth.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: b.client_id }), 'bad_request', /another client/)
    await expectAppError(h.s.oauth.verifyAccessToken(t.access_token), 'unauthorized')
  })

  it('access tokens expire, can be revoked, and only work for our MCP resource', async () => {
    const { userId } = await tenant(h)
    const client = await register()
    const v = verifier()
    const { code } = await authorizeCode(userId, client.client_id, v)
    const t = await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: client.client_id })
    await h.s.oauth.revoke({ token: t.access_token })
    await expectAppError(h.s.oauth.verifyAccessToken(t.access_token), 'unauthorized')
    // revoking the refresh token ends the family
    const r = await h.s.oauth.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id })
    await h.s.oauth.revoke({ token: r.refresh_token, token_type_hint: 'refresh_token' })
    await expectAppError(h.s.oauth.verifyAccessToken(r.access_token), 'unauthorized')
    // unknown / garbage tokens: revocation still succeeds silently
    await expect(h.s.oauth.revoke({ token: 'garbage' })).resolves.toBeUndefined()

    const { code: c2 } = await authorizeCode(userId, client.client_id, v)
    const t2 = await h.s.oauth.token({ grant_type: 'authorization_code', code: c2, code_verifier: v, client_id: client.client_id })
    h.clock.advance(HOUR + 1)
    await expectAppError(h.s.oauth.verifyAccessToken(t2.access_token), 'unauthorized', /expired/)
    // a token minted for another audience is refused
    await h.db.query(`update public.oauth_tokens set resource = 'https://other.test/mcp', expires_at = now() + interval '1 day' where kind = 'access'`)
    h.clock.set(new Date())
    await expectAppError(h.s.oauth.verifyAccessToken(t2.access_token), 'unauthorized', /another resource/)
    await expectAppError(h.s.oauth.verifyAccessToken(null), 'unauthorized')
    await expectAppError(h.s.oauth.verifyAccessToken('Bearer x'), 'unauthorized')
  })

  it('validates the authorize request; errors redirect only to a verified redirect URI', async () => {
    const { userId } = await tenant(h)
    const client = await register()
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE, code_challenge: pkceChallenge(verifier()), code_challenge_method: 'S256', state: 's' }
    // unknown client / unregistered redirect: shown, never redirected
    const e1 = await expectAppError(h.s.oauth.validateAuthorizeRequest({ ...base, client_id: 'mcp_unknown_client' }), 'unauthorized')
    expect(e1.details?.redirectTo).toBeUndefined()
    const e2 = await expectAppError(h.s.oauth.validateAuthorizeRequest({ ...base, redirect_uri: 'https://evil.example/cb' }), 'bad_request')
    expect(e2.details?.redirectTo).toBeUndefined()
    // after verification, errors go back to the client
    const e3 = await expectAppError(h.s.oauth.validateAuthorizeRequest({ ...base, code_challenge_method: 'plain' }), 'bad_request', /S256/)
    expect(String(e3.details?.redirectTo)).toMatch(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_request/)
    const e4 = await expectAppError(h.s.oauth.validateAuthorizeRequest({ ...base, scope: 'admin' }), 'bad_request')
    expect(e4.details).toMatchObject({ oauthError: 'invalid_scope' })
    const e5 = await expectAppError(h.s.oauth.validateAuthorizeRequest({ ...base, resource: 'https://other.test/mcp' }), 'bad_request')
    expect(e5.details).toMatchObject({ oauthError: 'invalid_target' })
    // loopback redirect on an ephemeral port (Claude Code)
    const loop = await h.s.oauth.validateAuthorizeRequest({ ...base, redirect_uri: 'http://localhost:43123/callback' })
    expect(loop.redirectUri).toBe('http://localhost:43123/callback')
    // deny
    const denied = await h.s.oauth.authorize(userId, base, 'deny')
    expect(new URL(denied.redirectTo).searchParams.get('error')).toBe('access_denied')
  })

  it('registration refuses unsafe redirect URIs and confidential clients', async () => {
    await expectAppError(h.s.oauth.registerClient({ redirect_uris: ['http://evil.example/cb'] }), 'bad_request', /Redirect URIs/)
    await expectAppError(h.s.oauth.registerClient({ redirect_uris: [] }), 'bad_request')
    await expectAppError(h.s.oauth.registerClient({ redirect_uris: [CLAUDE], token_endpoint_auth_method: 'client_secret_basic' }), 'bad_request', /public clients/)
    await expectAppError(h.s.oauth.registerClient({ redirect_uris: [CLAUDE], grant_types: ['client_credentials'] }), 'bad_request')
  })

  it('lists and disconnects a user’s AI apps (other users’ connections → not_found)', async () => {
    const a = await tenant(h)
    const b = await tenant(h)
    const client = await register()
    const v = verifier()
    const { code } = await authorizeCode(a.userId, client.client_id, v)
    const t = await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: client.client_id })
    await h.s.oauth.verifyAccessToken(t.access_token)
    const list = await h.s.oauth.listConnections(a.userId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ clientId: client.client_id, clientName: 'Claude' })
    expect(await h.s.oauth.listConnections(b.userId)).toEqual([])
    await expectAppError(h.s.oauth.revokeConnection(b.userId, list[0]?.familyId ?? ''), 'not_found')
    expect((await h.s.oauth.revokeConnection(a.userId, list[0]?.familyId ?? '')).revoked).toBe(2)
    await expectAppError(h.s.oauth.verifyAccessToken(t.access_token), 'unauthorized')
    void DAY
  })

  it('cleanup deletes registered clients that never connected (after 7 days), keeps used ones', async () => {
    const { userId } = await tenant(h)
    const idle = await register()
    const used = await register()
    const v = verifier()
    const { code } = await authorizeCode(userId, used.client_id, v)
    await h.s.oauth.token({ grant_type: 'authorization_code', code, code_verifier: v, client_id: used.client_id })
    expect((await h.s.maintenance.cleanup({ now: new Date() })).deletedOAuthClients).toBe(0)
    const res = await h.s.maintenance.cleanup({ now: new Date(Date.now() + 8 * DAY) })
    expect(res.deletedOAuthClients).toBe(1)
    expect(await h.r.oauth.getClient(idle.client_id)).toBeNull()
    expect(await h.r.oauth.getClient(used.client_id)).not.toBeNull()
  })

  it('publishes RFC 8414 / RFC 9728 metadata and the WWW-Authenticate challenge', () => {
    const as = h.s.oauth.authorizationServerMetadata()
    expect(as).toMatchObject({
      issuer: 'https://app.test',
      token_endpoint: 'https://app.test/oauth/token',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
    expect(h.s.oauth.protectedResourceMetadata()).toMatchObject({ resource: MCP, authorization_servers: ['https://app.test'] })
    expect(h.s.oauth.wwwAuthenticate('invalid_token')).toBe(
      'Bearer resource_metadata="https://app.test/.well-known/oauth-protected-resource", scope="social", error="invalid_token"',
    )
  })
})
