// Web-layer glue for our OAuth 2.1 authorization server (the logic lives in services.oauth):
// the /api/mcp challenge, the protected-resource metadata URL, the registration pre-check and
// the consent screen's load / decide steps (pages and server actions stay thin). Server-only.

import type { Config } from '@app/core/config'
import { isAppError } from '@app/core/errors'
import { MCP_SCOPE } from '@app/core/types'
import { oauthErrorCode, oauthErrorResponse, type AuthorizeRequest, type Services } from '@app/services'
import type { CurrentUser } from '@/lib/auth'

/**
 * Redirect URIs accepted at registration: https, http on a loopback host (native apps such as
 * Claude Code listen on an ephemeral port), and the private-use schemes of the desktop AI clients
 * we support (RFC 8252 §7.1; PKCE binds the code to the app that started the flow). Cursor
 * registers `cursor://anysphere.cursor-mcp/oauth/callback`. Any other scheme is refused; set
 * ALLOW_APP_SCHEME_REDIRECTS to accept every non-dangerous scheme (services.oauth's own policy).
 */
export const APP_REDIRECT_SCHEMES: readonly string[] = ['cursor:', 'vscode:', 'vscode-insiders:']
export const ALLOW_APP_SCHEME_REDIRECTS = false

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const DANGEROUS_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:']

/** Why a redirect URI may not be registered here (null = acceptable to pass to services). */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string') return 'Redirect URIs must be strings.'
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return 'Redirect URIs must be absolute URLs.'
  }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? null : 'Redirect URIs must use https (http only on localhost).'
  if (APP_REDIRECT_SCHEMES.includes(url.protocol)) return null
  if (ALLOW_APP_SCHEME_REDIRECTS && !DANGEROUS_SCHEMES.includes(url.protocol)) return null
  return 'Redirect URIs must use https (http only on localhost).'
}

/** A redirect that lands in an app on the user's own computer (loopback http or an app scheme). */
export function isLocalAppRedirect(uri: string): boolean {
  try {
    const url = new URL(uri)
    if (url.protocol === 'https:') return false
    if (url.protocol === 'http:') return LOOPBACK.has(url.hostname)
    return true
  } catch {
    return false
  }
}

/** The RFC 9728 metadata URL for our MCP resource (path-suffixed form, e.g. …/oauth-protected-resource/api/mcp). */
export function protectedResourceMetadataUrl(config: Pick<Config, 'MCP_RESOURCE_URL'>): string {
  const resource = new URL(config.MCP_RESOURCE_URL)
  const path = resource.pathname.replace(/\/+$/, '')
  return `${resource.origin}/.well-known/oauth-protected-resource${path === '/' ? '' : path}`
}

/**
 * WWW-Authenticate for a 401 from /api/mcp (RFC 6750 + RFC 9728). Without a token there is no
 * error code (RFC 6750 §3.1); with a bad or expired token error="invalid_token".
 */
export function mcpChallenge(config: Pick<Config, 'MCP_RESOURCE_URL'>, error?: 'invalid_token'): string {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(config)}"`, `scope="${MCP_SCOPE}"`]
  if (error) parts.push(`error="${error}"`)
  return `Bearer ${parts.join(', ')}`
}

/** Human description of a requested scope string (consent screen). */
export function describeScopes(scope: string): string[] {
  return scope
    .split(' ')
    .filter(Boolean)
    .map((s) =>
      s === MCP_SCOPE
        ? 'Manage your brands, connected accounts, drafts, clips and analytics, and schedule posts you have approved. It cannot publish anything you have not approved.'
        : s,
    )
}

// ---------------------------------------------------------------------------------------------
// Consent screen (/oauth/authorize)
// ---------------------------------------------------------------------------------------------

/** The authorization request parameters we forward (OAuth 2.1 + RFC 8707). */
export const AUTHORIZE_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'resource',
  'state',
] as const

export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_PARAMS)[number], string>>

type ParamSource = URLSearchParams | FormData | Record<string, string | string[] | undefined>

/**
 * Picks the authorization parameters from a query, page searchParams or a form. A parameter sent
 * more than once makes the request malformed (RFC 6749 §3.1): `duplicate` is set.
 */
export function pickAuthorizeParams(source: ParamSource): { params: AuthorizeParams; duplicate: boolean } {
  const params: AuthorizeParams = {}
  let duplicate = false
  for (const key of AUTHORIZE_PARAMS) {
    let values: unknown[]
    if (source instanceof URLSearchParams || source instanceof FormData) values = source.getAll(key)
    else {
      const v = source[key]
      values = v === undefined ? [] : Array.isArray(v) ? v : [v]
    }
    if (values.length > 1) duplicate = true
    const first = values[0]
    if (typeof first === 'string') params[key] = first
  }
  return { params, duplicate }
}

/** The query string of an authorization request (to come back after signing in). */
export function authorizeQuery(params: AuthorizeParams): string {
  const q = new URLSearchParams()
  for (const key of AUTHORIZE_PARAMS) {
    const v = params[key]
    if (v !== undefined) q.set(key, v)
  }
  return q.toString()
}

export type ConsentState =
  | { kind: 'error'; message: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'login'; url: string }
  | { kind: 'consent'; request: AuthorizeRequest; params: AuthorizeParams; user: CurrentUser; loopback: boolean }

function failure(error: unknown): { kind: 'error'; message: string } | { kind: 'redirect'; url: string } {
  if (isAppError(error) && typeof error.details?.redirectTo === 'string') return { kind: 'redirect', url: error.details.redirectTo }
  return { kind: 'error', message: oauthErrorResponse(error).body.error_description }
}

/**
 * What GET /oauth/authorize shows. The request is validated first (errors before the client and
 * redirect URI are verified are shown here, never redirected); then the user must be signed in.
 */
export async function loadConsent(
  services: Services,
  user: CurrentUser | null,
  source: ParamSource,
): Promise<ConsentState> {
  const { params, duplicate } = pickAuthorizeParams(source)
  if (duplicate) return { kind: 'error', message: 'The authorization request is malformed (a parameter was repeated).' }
  let request: AuthorizeRequest
  try {
    request = await services.oauth.validateAuthorizeRequest(params)
  } catch (error) {
    return failure(error)
  }
  if (!user) {
    const next = `/oauth/authorize?${authorizeQuery(params)}`
    return { kind: 'login', url: `/login?next=${encodeURIComponent(next)}` }
  }
  const loopback = isLocalAppRedirect(request.redirectUri)
  return { kind: 'consent', request, params, user, loopback }
}

/**
 * The consent form's Allow / Deny (server action). Returns where to send the browser: the
 * client's redirect URI with code + state + iss (or error=access_denied), or an error to show.
 */
export async function decideConsent(
  services: Services,
  user: CurrentUser,
  source: ParamSource,
  decision: 'approve' | 'deny',
): Promise<{ kind: 'redirect'; url: string } | { kind: 'error'; message: string }> {
  const { params, duplicate } = pickAuthorizeParams(source)
  if (duplicate) return { kind: 'error', message: 'The authorization request is malformed (a parameter was repeated).' }
  const attempt = () => services.oauth.authorize(user.id, params, decision)
  try {
    return { kind: 'redirect', url: (await attempt()).redirectTo }
  } catch (error) {
    // A signed-in person without an app user row yet (e.g. the row was never created at sign-in).
    if (isAppError(error) && error.code === 'unauthorized' && oauthErrorCode(error) === 'server_error') {
      try {
        await services.users.ensureUser(user.id, { email: user.email })
        return { kind: 'redirect', url: (await attempt()).redirectTo }
      } catch (retryError) {
        return failure(retryError)
      }
    }
    return failure(error)
  }
}
