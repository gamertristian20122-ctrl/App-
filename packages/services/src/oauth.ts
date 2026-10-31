// OAuth 2.1 authorization server logic for MCP clients (Claude, ChatGPT, Cursor, ...): dynamic
// client registration (RFC 7591), authorization code + PKCE S256, resource indicators (RFC 8707:
// the token audience is our MCP URL), refresh-token rotation with reuse detection, revocation
// (RFC 7009), bearer verification for /api/mcp and the metadata documents (RFC 8414, RFC 9728).
//
// The web app's routes are thin: they parse the HTTP request (query / form body), call one
// function here and map errors with `oauthErrorResponse`. Codes and tokens are random 32-byte
// strings; only SHA-256 hashes are stored (oauth_* tables); nothing here logs them.

import { z } from 'zod'
import { AppError, isAppError } from '@app/core/errors'
import { randomToken, safeEqual, sha256Hex } from '@app/core/crypto'
import { MCP_SCOPE } from '@app/core/types'
import type { OAuthClientRow, OAuthTokenRow } from '@app/db'
import { createHash, randomUUID } from 'node:crypto'
import { requireUser, userIdOf, withErrors, type Ctx } from './context'

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** OAuth error codes used by the token, registration, revocation and authorization endpoints. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'invalid_token'
  | 'server_error'

function oauthError(error: OAuthErrorCode, description: string, extra: Record<string, unknown> = {}): AppError {
  const code = error === 'invalid_client' || error === 'invalid_token' ? 'unauthorized' : 'bad_request'
  return new AppError(code, description, { oauthError: error, ...extra })
}

/** The OAuth error code carried by an error thrown here (server_error for anything else). */
export function oauthErrorCode(error: unknown): OAuthErrorCode {
  if (isAppError(error) && typeof error.details?.oauthError === 'string') return error.details.oauthError as OAuthErrorCode
  if (isAppError(error) && error.code === 'validation') return 'invalid_request'
  return 'server_error'
}

/**
 * Maps an error to the JSON body and status of the token / registration / revocation endpoints
 * (RFC 6749 §5.2): `{ error, error_description }`, 401 for invalid_client, 400 otherwise, 500 for
 * unexpected errors (never their message).
 */
export function oauthErrorResponse(error: unknown): { status: number; body: { error: OAuthErrorCode; error_description: string } } {
  const code = oauthErrorCode(error)
  if (code === 'server_error') {
    return { status: 500, body: { error: code, error_description: 'Something went wrong on our side. Please try again.' } }
  }
  const message = isAppError(error) ? error.message : 'Invalid request.'
  return { status: code === 'invalid_client' || code === 'invalid_token' ? 401 : 400, body: { error: code, error_description: message } }
}

// ---------------------------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'tel:'])

/**
 * Redirect URIs a client may register: https (any host), http only on loopback (native apps,
 * RFC 8252 §7.3), or a private-use scheme of a native app (e.g. cursor://...). No fragment, no
 * credentials, at most 2,048 characters.
 */
export function checkRedirectUri(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || /\s/.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.hash || raw.includes('#') || url.username || url.password) return null
  if (url.protocol === 'https:') return url.hostname ? raw : null
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname) ? raw : null
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return null
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? raw : null
}

/**
 * Exact match, except that loopback http redirect URIs match on any port (RFC 8252 §7.3: native
 * apps such as Claude Code listen on an ephemeral port).
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true
  let a: URL
  let b: URL
  try {
    a = new URL(registered)
    b = new URL(requested)
  } catch {
    return false
  }
  if (a.protocol !== 'http:' || b.protocol !== 'http:') return false
  if (!LOOPBACK_HOSTS.has(a.hostname) || a.hostname !== b.hostname) return false
  return a.pathname === b.pathname && a.search === b.search && !b.hash && !b.username && !b.password
}

/** base64url(SHA-256(verifier)): the S256 code challenge for a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

// ---------------------------------------------------------------------------------------------
// Schemas (snake_case: these are the wire formats)
// ---------------------------------------------------------------------------------------------

const ClientIdSchema = z.string().trim().min(8).max(255)
const TokenSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{32,200}$/)
const VerifierSchema = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/)
const ChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/)
const StateSchema = z.string().max(1_000)

const RegisterSchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).max(5).optional(),
  response_types: z.array(z.string()).max(5).optional(),
  scope: z.string().max(255).optional(),
})

const AuthorizeSchema = z.looseObject({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().max(255).optional(),
  resource: z.string().max(2048).optional(),
  state: z.string().optional(),
})

const TokenRequestSchema = z.looseObject({
  grant_type: z.string().optional(),
  code: z.string().max(300).optional(),
  redirect_uri: z.string().max(2048).optional(),
  client_id: z.string().max(255).optional(),
  code_verifier: z.string().max(300).optional(),
  refresh_token: z.string().max(300).optional(),
  scope: z.string().max(255).optional(),
  resource: z.string().max(2048).optional(),
})

const RevokeSchema = z.looseObject({
  token: z.string().max(300).optional(),
  token_type_hint: z.string().max(50).optional(),
  client_id: z.string().max(255).optional(),
})

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** RFC 7591 registration response. */
export interface RegisteredClient {
  client_id: string
  client_id_issued_at: number
  client_name?: string
  redirect_uris: string[]
  token_endpoint_auth_method: 'none'
  grant_types: string[]
  response_types: string[]
  scope: string
}

/** A validated authorization request (show the consent screen from it). */
export interface AuthorizeRequest {
  client: { id: string; name: string | null }
  redirectUri: string
  /** Host the user is sent back to (show it on the consent screen). */
  redirectHost: string
  scope: string
  resource: string
  state: string | null
  codeChallenge: string
}

/** RFC 6749 §5.1 token response. */
export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** Who an MCP request acts for. */
export interface AccessContext {
  userId: string
  clientId: string
  scopes: string[]
  expiresAt: Date
}

export interface OAuthConnection {
  familyId: string
  clientId: string
  clientName: string | null
  connectedAt: Date
  lastUsedAt: Date | null
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

const SUPPORTED_SCOPES = [MCP_SCOPE] as const

export function createOAuthService(ctx: Ctx) {
  const issuer = ctx.config.appUrl
  const audience = ctx.config.mcpResourceUrl
  const normalizeResource = (r: string) => r.trim().replace(/\/+$/, '')

  function parseScope(raw: string | undefined): string {
    const parts = (raw ?? '').split(/\s+/).filter(Boolean)
    if (parts.length === 0) return MCP_SCOPE
    const unknown = parts.filter((p) => !(SUPPORTED_SCOPES as readonly string[]).includes(p))
    if (unknown.length > 0) throw oauthError('invalid_scope', `Unknown scope: ${unknown.join(' ').slice(0, 100)}.`)
    return [...new Set(parts)].join(' ')
  }

  function parseResource(raw: string | undefined): string {
    if (raw === undefined || raw.trim() === '') return audience
    if (normalizeResource(raw) !== audience) throw oauthError('invalid_target', 'This authorization server only issues tokens for its own MCP server.')
    return audience
  }

  async function loadClient(clientId: unknown): Promise<OAuthClientRow> {
    const parsed = ClientIdSchema.safeParse(clientId)
    const client = parsed.success ? await ctx.repos.oauth.getClient(parsed.data) : null
    if (!client) throw oauthError('invalid_client', 'Unknown client. Register the client again.')
    return client
  }

  async function issuePair(input: { clientId: string; userId: string; scope: string; resource: string; familyId: string }): Promise<TokenResponse> {
    const now = ctx.now()
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.tx(async (r) => {
      await r.oauth.createToken({
        tokenHash: sha256Hex(accessToken),
        kind: 'access',
        familyId: input.familyId,
        clientId: input.clientId,
        userId: input.userId,
        scope: input.scope,
        resource: input.resource,
        expiresAt: new Date(now.getTime() + ctx.config.oauthAccessTokenTtlSec * 1000),
      })
      await r.oauth.createToken({
        tokenHash: sha256Hex(refreshToken),
        kind: 'refresh',
        familyId: input.familyId,
        clientId: input.clientId,
        userId: input.userId,
        scope: input.scope,
        resource: input.resource,
        expiresAt: new Date(now.getTime() + ctx.config.oauthRefreshTokenTtlSec * 1000),
      })
      await r.oauth.touchClient(input.clientId)
    })
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ctx.config.oauthAccessTokenTtlSec,
      refresh_token: refreshToken,
      scope: input.scope,
    }
  }

  /** Validates authorize parameters. Errors carry `details.redirectTo` when it is safe to redirect. */
  async function validateAuthorize(params: unknown): Promise<AuthorizeRequest> {
    const p = AuthorizeSchema.safeParse(params ?? {})
    if (!p.success) throw oauthError('invalid_request', 'The authorization request is malformed.')
    const q = p.data
    // Until client and redirect URI are verified, errors are shown to the user (never redirected).
    const client = await loadClient(q.client_id)
    const requested = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
    if (!requested || !client.redirectUris.some((r) => redirectUriMatches(r, requested))) {
      throw oauthError('invalid_request', 'The redirect URI does not match the registered client.')
    }
    const state = q.state !== undefined ? StateSchema.safeParse(q.state) : null
    const back = (error: OAuthErrorCode, description: string) => {
      const url = new URL(requested)
      url.searchParams.set('error', error)
      url.searchParams.set('error_description', description)
      if (state?.success) url.searchParams.set('state', state.data)
      url.searchParams.set('iss', issuer)
      return oauthError(error, description, { redirectTo: url.toString() })
    }
    if (state && !state.success) throw back('invalid_request', 'The state parameter is too long.')
    if (q.response_type !== 'code') throw back('unsupported_response_type', 'Only response_type=code is supported.')
    if (q.code_challenge_method !== 'S256') throw back('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
    const challenge = ChallengeSchema.safeParse(q.code_challenge)
    if (!challenge.success) throw back('invalid_request', 'A valid code_challenge is required.')
    let scope: string
    let resource: string
    try {
      scope = parseScope(q.scope)
      resource = parseResource(q.resource)
    } catch (error) {
      throw back(oauthErrorCode(error), isAppError(error) ? error.message : 'Invalid request.')
    }
    return {
      client: { id: client.clientId, name: client.clientName },
      redirectUri: requested,
      redirectHost: new URL(requested).host || new URL(requested).protocol,
      scope,
      resource,
      state: state?.success ? state.data : null,
      codeChallenge: challenge.data,
    }
  }

  return withErrors({
    /** RFC 7591 dynamic client registration (public clients only: token_endpoint_auth_method none). */
    async registerClient(input: unknown): Promise<RegisteredClient> {
      const parsed = RegisterSchema.safeParse(input ?? {})
      if (!parsed.success) throw oauthError('invalid_client_metadata', 'redirect_uris (1–10 URLs) is required.')
      const data = parsed.data
      const uris = data.redirect_uris.map((u) => checkRedirectUri(u))
      if (uris.some((u) => u === null)) {
        throw oauthError('invalid_redirect_uri', 'Redirect URIs must be https, http on localhost, or an app scheme, without a fragment.')
      }
      if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== 'none') {
        throw oauthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported.')
      }
      const grants = data.grant_types ?? ['authorization_code', 'refresh_token']
      if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
        throw oauthError('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported.')
      }
      if ((data.response_types ?? ['code']).some((t) => t !== 'code')) {
        throw oauthError('invalid_client_metadata', 'Only response_type "code" is supported.')
      }
      const scope = parseScope(data.scope)
      const clientId = `mcp_${randomToken(18)}`
      const clientName = data.client_name ? data.client_name.replace(/[\u0000-\u001f\u007f]/g, '') : null
      const row = await ctx.repos.oauth.createClient({ clientId, clientName, redirectUris: uris as string[] })
      return {
        client_id: row.clientId,
        client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
        ...(row.clientName ? { client_name: row.clientName } : {}),
        redirect_uris: row.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: grants.includes('refresh_token') ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
        response_types: ['code'],
        scope,
      }
    },

    /**
     * /oauth/authorize (GET): validates the request for the consent screen. Errors: when
     * `details.redirectTo` is set, redirect there; otherwise show the message (never redirect to
     * an unverified URI).
     */
    validateAuthorizeRequest: validateAuthorize,

    /**
     * /oauth/authorize (POST, consent form): the signed-in user approves or denies. Re-validates
     * the same parameters and returns where to send the browser (code + state + iss, or
     * error=access_denied).
     */
    async authorize(userId: string, params: unknown, decision: 'approve' | 'deny'): Promise<{ redirectTo: string }> {
      const uid = userIdOf(userId)
      const request = await validateAuthorize(params)
      const url = new URL(request.redirectUri)
      if (request.state !== null) url.searchParams.set('state', request.state)
      url.searchParams.set('iss', issuer)
      if (decision !== 'approve') {
        url.searchParams.set('error', 'access_denied')
        url.searchParams.set('error_description', 'The user denied access.')
        return { redirectTo: url.toString() }
      }
      await requireUser(ctx.repos, uid)
      const code = randomToken(32)
      await ctx.repos.oauth.createCode({
        codeHash: sha256Hex(code),
        clientId: request.client.id,
        userId: uid,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scope: request.scope,
        resource: request.resource,
        expiresAt: new Date(ctx.now().getTime() + ctx.config.oauthCodeTtlSec * 1000),
      })
      url.searchParams.set('code', code)
      return { redirectTo: url.toString() }
    },

    /** /oauth/token: authorization_code (PKCE S256) and refresh_token (rotation) grants. */
    async token(input: unknown): Promise<TokenResponse> {
      const parsed = TokenRequestSchema.safeParse(input ?? {})
      if (!parsed.success) throw oauthError('invalid_request', 'The token request is malformed.')
      const q = parsed.data
      const now = ctx.now()

      if (q.grant_type === 'authorization_code') {
        const client = await loadClient(q.client_id)
        const code = TokenSchema.safeParse(q.code)
        const verifier = VerifierSchema.safeParse(q.code_verifier)
        if (!code.success) throw oauthError('invalid_grant', 'The authorization code is invalid or expired.')
        if (!verifier.success) throw oauthError('invalid_request', 'A valid code_verifier is required.')
        const row = await ctx.repos.oauth.consumeCode(sha256Hex(code.data), now)
        if (!row) throw oauthError('invalid_grant', 'The authorization code is invalid, expired or already used.')
        if (row.clientId !== client.clientId) throw oauthError('invalid_grant', 'The authorization code was issued to another client.')
        // PKCE binds the code to this client; when redirect_uri is sent it must be the exact one used.
        if (q.redirect_uri !== undefined && q.redirect_uri !== row.redirectUri) {
          throw oauthError('invalid_grant', 'redirect_uri does not match the authorization request.')
        }
        if (!safeEqual(pkceChallenge(verifier.data), row.codeChallenge)) {
          throw oauthError('invalid_grant', 'The code_verifier does not match the code_challenge.')
        }
        const resource = row.resource ?? audience
        if (q.resource !== undefined && q.resource.trim() !== '' && normalizeResource(q.resource) !== resource) {
          throw oauthError('invalid_target', 'The resource does not match the authorization request.')
        }
        return issuePair({ clientId: client.clientId, userId: row.userId, scope: row.scope, resource, familyId: randomUUID() })
      }

      if (q.grant_type === 'refresh_token') {
        const token = TokenSchema.safeParse(q.refresh_token)
        if (!token.success) throw oauthError('invalid_grant', 'The refresh token is invalid or expired.')
        const used = await ctx.repos.oauth.useRefreshToken(sha256Hex(token.data), now)
        if (used.status === 'reused') {
          ctx.log.warn('oauth refresh token reuse: family revoked', { familyId: used.familyId })
          throw oauthError('invalid_grant', 'The refresh token was already used. Connect again.')
        }
        if (used.status !== 'ok') throw oauthError('invalid_grant', 'The refresh token is invalid or expired.')
        const old = used.token
        if (q.client_id !== undefined && q.client_id !== old.clientId) {
          await ctx.repos.oauth.revokeFamily(old.familyId, now)
          throw oauthError('invalid_grant', 'The refresh token was issued to another client.')
        }
        const granted = old.scope.split(' ').filter(Boolean)
        const scope = q.scope ? parseScope(q.scope) : old.scope
        if (scope.split(' ').some((s) => !granted.includes(s))) throw oauthError('invalid_scope', 'A refresh cannot add scopes.')
        const resource = old.resource ?? audience
        if (q.resource !== undefined && q.resource.trim() !== '' && normalizeResource(q.resource) !== resource) {
          throw oauthError('invalid_target', 'The resource does not match the original grant.')
        }
        return issuePair({ clientId: old.clientId, userId: old.userId, scope, resource, familyId: old.familyId })
      }

      throw oauthError('unsupported_grant_type', 'Use grant_type authorization_code or refresh_token.')
    },

    /** /oauth/revoke (RFC 7009): always succeeds; revoking a refresh token ends its whole family. */
    async revoke(input: unknown): Promise<void> {
      const parsed = RevokeSchema.safeParse(input ?? {})
      const token = parsed.success ? TokenSchema.safeParse(parsed.data.token) : null
      if (!parsed.success || !token?.success) return
      const row = await ctx.repos.oauth.findTokenByHash(sha256Hex(token.data))
      if (!row) return
      if (parsed.data.client_id !== undefined && parsed.data.client_id !== row.clientId) return
      if (row.kind === 'refresh') await ctx.repos.oauth.revokeFamily(row.familyId, ctx.now())
      else await ctx.repos.oauth.revokeToken(row.tokenHash, ctx.now())
    },

    /**
     * /api/mcp: verifies `Authorization: Bearer <token>` (pass the header value or the bare token).
     * The token must be a live access token issued for our MCP resource (audience) with the
     * `social` scope. Throws AppError('unauthorized', details.oauthError 'invalid_token') otherwise:
     * answer 401 with `WWW-Authenticate: wwwAuthenticate()`.
     */
    async verifyAccessToken(authorization: string | null | undefined): Promise<AccessContext> {
      const raw = (authorization ?? '').trim().replace(/^Bearer\s+/i, '')
      const token = TokenSchema.safeParse(raw)
      if (!token.success) throw oauthError('invalid_token', 'Sign in again: the access token is missing or invalid.')
      const row: OAuthTokenRow | null = await ctx.repos.oauth.findActiveToken(sha256Hex(token.data), 'access', ctx.now())
      if (!row) throw oauthError('invalid_token', 'Sign in again: the access token is invalid or expired.')
      if ((row.resource ?? audience) !== audience) throw oauthError('invalid_token', 'This access token was issued for another resource.')
      const scopes = row.scope.split(' ').filter(Boolean)
      if (!scopes.includes(MCP_SCOPE)) throw oauthError('invalid_token', 'The access token lacks the required scope.')
      return { userId: row.userId, clientId: row.clientId, scopes, expiresAt: row.expiresAt }
    },

    /** The AI apps a user has connected (one entry per live token family). */
    async listConnections(userId: string): Promise<OAuthConnection[]> {
      const uid = userIdOf(userId)
      const tokens = await ctx.repos.oauth.listActiveForUser(uid, ctx.now())
      const byFamily = new Map<string, OAuthTokenRow[]>()
      for (const t of tokens) byFamily.set(t.familyId, [...(byFamily.get(t.familyId) ?? []), t])
      const out: OAuthConnection[] = []
      for (const [familyId, rows] of byFamily) {
        const first = rows[0] as OAuthTokenRow
        const client = await ctx.repos.oauth.getClient(first.clientId)
        const lastUsed = rows.map((r) => r.lastUsedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0)
        out.push({
          familyId,
          clientId: first.clientId,
          clientName: client?.clientName ?? null,
          connectedAt: rows.map((r) => r.createdAt).reduce((a, b) => (a < b ? a : b)),
          lastUsedAt: lastUsed > 0 ? new Date(lastUsed) : null,
        })
      }
      return out.sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime())
    },

    /** Disconnects one AI app (its token family). Other users' families → not_found. */
    async revokeConnection(userId: string, familyId: string): Promise<{ revoked: number }> {
      const uid = userIdOf(userId)
      const tokens = await ctx.repos.oauth.listActiveForUser(uid, ctx.now())
      if (!tokens.some((t) => t.familyId === familyId)) throw new AppError('not_found', 'That connection was not found.')
      return { revoked: await ctx.repos.oauth.revokeFamily(familyId, ctx.now()) }
    },

    /** Signs every AI app out. */
    async revokeAll(userId: string): Promise<{ revoked: number }> {
      return { revoked: await ctx.repos.oauth.revokeAllForUser(userIdOf(userId), ctx.now()) }
    },

    /** RFC 8414 document for /.well-known/oauth-authorization-server. */
    authorizationServerMetadata() {
      return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [...SUPPORTED_SCOPES],
        authorization_response_iss_parameter_supported: true,
      }
    },

    /** RFC 9728 document for /.well-known/oauth-protected-resource (and the /api/mcp-suffixed path). */
    protectedResourceMetadata() {
      return {
        resource: audience,
        authorization_servers: [issuer],
        scopes_supported: [...SUPPORTED_SCOPES],
        bearer_methods_supported: ['header'],
        resource_name: 'Social posting MCP server',
      }
    },

    /** The WWW-Authenticate value for a 401 from /api/mcp. */
    wwwAuthenticate(error?: 'invalid_token'): string {
      const parts = [`resource_metadata="${issuer}/.well-known/oauth-protected-resource"`, `scope="${MCP_SCOPE}"`]
      if (error) parts.push(`error="${error}"`)
      return `Bearer ${parts.join(', ')}`
    },
  })
}

export type OAuthService = ReturnType<typeof createOAuthService>
