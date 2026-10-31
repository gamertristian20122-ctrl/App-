// The MCP client's side of OAuth 2.1, as a native app would do it (RFC 8252): an in-memory
// OAuthClientProvider for @modelcontextprotocol/sdk (dynamic client registration, PKCE S256,
// resource indicator, refresh) and a loopback HTTP server that receives the authorization code.

import { createServer, type Server } from 'node:http'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export class E2EOAuthProvider implements OAuthClientProvider {
  private info: OAuthClientInformationMixed | undefined
  private saved: OAuthTokens | undefined
  private verifier: string | undefined
  /** The last authorization URL the SDK asked us to open. */
  authorizationUrl: URL | null = null
  /** Every token response saved, in order (initial exchange, then refreshes). */
  readonly tokenHistory: OAuthTokens[] = []
  registrations = 0

  constructor(private readonly redirect: string) {}

  get redirectUrl(): string {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'E2E MCP client',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'social',
    }
  }

  state(): string {
    return `e2e-${Date.now().toString(36)}`
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.info
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.registrations++
    this.info = info
  }

  tokens(): OAuthTokens | undefined {
    return this.saved
  }

  saveTokens(tokens: OAuthTokens): void {
    this.saved = tokens
    this.tokenHistory.push(tokens)
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No PKCE code verifier saved')
    return this.verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') this.saved = undefined
    if (scope === 'all' || scope === 'client') this.info = undefined
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
  }

  /** Test hook: replace the access token (keeps the refresh token) to force a 401 + refresh. */
  corruptAccessToken(): void {
    if (!this.saved) throw new Error('No tokens yet')
    this.saved = { ...this.saved, access_token: 'expired-or-revoked-access-token' }
  }
}

export interface CallbackServer {
  url: string
  /** Resolves with the query of the next request to /callback. */
  next(): Promise<URLSearchParams>
  close(): Promise<void>
}

/** Loopback redirect target (http://127.0.0.1:<port>/callback) that captures code + state. */
export function startCallbackServer(port: number): Promise<CallbackServer> {
  let waiting: ((q: URLSearchParams) => void) | null = null
  const queue: URLSearchParams[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Connected</title><p>You can close this window.</p>')
    if (waiting) {
      const w = waiting
      waiting = null
      w(url.searchParams)
    } else queue.push(url.searchParams)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${port}/callback`,
        next: () => {
          const q = queue.shift()
          if (q) return Promise.resolve(q)
          return new Promise((r) => {
            waiting = r
          })
        },
        close: () => new Promise((r) => server.close(() => r())),
      }),
    )
  })
}
