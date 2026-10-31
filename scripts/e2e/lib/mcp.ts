// MCP client side: connect @modelcontextprotocol/sdk's Client over Streamable HTTP with a real
// OAuth flow (the SDK discovers the protected-resource and authorization-server metadata, registers
// a client dynamically and starts PKCE; the consent page is approved in Chromium; the code comes
// back to a loopback server; the SDK exchanges it), plus small tool-call helpers.

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Page } from './deps'
import { E2EOAuthProvider, type CallbackServer } from './oauth'
import { assert, assertEqual, log } from './util'

export type ToolResult = CallToolResult & { _meta?: Record<string, unknown> }

export interface McpSession {
  client: Client
  provider: E2EOAuthProvider
  /** Opens a fresh client with the same provider (tokens), e.g. after forcing a refresh. */
  reconnect(): Promise<Client>
}

function newClient(): Client {
  return new Client({ name: 'e2e-mcp-client', version: '1.0.0' }, { capabilities: {} })
}

export interface ConnectOptions {
  appUrl: string
  callback: CallbackServer
  /** A signed-in browser page; it opens the authorization URL and clicks Allow. */
  page: Page
  /** Called with the consent page open (screenshots). */
  onConsent?: (page: Page) => Promise<void>
}

export async function connectWithOAuth(options: ConnectOptions): Promise<McpSession> {
  const { appUrl, callback, page } = options
  const serverUrl = new URL(`${appUrl}/api/mcp`)
  const provider = new E2EOAuthProvider(callback.url)

  // 1. First connect: 401 → discovery → dynamic registration → authorization URL (PKCE)
  const first = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider })
  let unauthorized = false
  try {
    await newClient().connect(first)
  } catch (error) {
    unauthorized = error instanceof UnauthorizedError
    if (!unauthorized) throw error
  }
  assert(unauthorized, 'connecting without a token should require authorization')
  assertEqual(provider.registrations, 1, 'dynamic client registrations')
  const info = provider.clientInformation()
  assert(info && /^mcp_/.test(info.client_id), `unexpected client id ${info?.client_id}`)
  const authUrl = provider.authorizationUrl
  assert(authUrl, 'the SDK did not produce an authorization URL')
  assertEqual(authUrl.origin + authUrl.pathname, `${appUrl}/oauth/authorize`, 'authorization endpoint')
  assertEqual(authUrl.searchParams.get('code_challenge_method'), 'S256', 'PKCE method')
  assert((authUrl.searchParams.get('code_challenge') ?? '').length >= 43, 'PKCE challenge missing')
  assertEqual(authUrl.searchParams.get('resource'), serverUrl.toString(), 'resource indicator')
  assertEqual(authUrl.searchParams.get('scope'), 'social', 'requested scope')
  const state = authUrl.searchParams.get('state')
  log(`registered ${info.client_id}; opening the consent page`)

  // 2. The person approves in the browser; the browser lands on our loopback callback
  const codePromise = callback.next()
  await page.goto(authUrl.toString())
  await page.getByRole('heading', { name: /wants to use your account/ }).waitFor({ timeout: 15_000 })
  const consentText = await page.locator('main').innerText()
  assert(consentText.includes('E2E MCP client'), 'consent page does not name the client')
  assert(consentText.includes('127.0.0.1'), 'consent page does not show where the browser goes next')
  if (options.onConsent) await options.onConsent(page)
  await page.getByRole('button', { name: 'Allow' }).click()
  const query = await codePromise
  assertEqual(query.get('state'), state, 'state round-trip')
  const code = query.get('code')
  assert(code, `no authorization code (error=${query.get('error')})`)

  // 3. Code exchange (PKCE verifier) through the SDK
  await first.finishAuth(code)
  const tokens = provider.tokens()
  assert(tokens?.access_token && tokens.refresh_token, 'token response lacks access or refresh token')
  assertEqual(tokens.token_type.toLowerCase(), 'bearer', 'token type')
  assert((tokens.expires_in ?? 0) > 0, 'token response lacks expires_in')

  const reconnect = async () => {
    const client = newClient()
    await client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }))
    return client
  }
  const client = await reconnect()
  return { client, provider, reconnect }
}

export const textOf = (r: ToolResult): string =>
  (r.content ?? [])
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

/** Calls a tool and fails the run when it returns an error result. */
export async function callOk(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = await callTool(client, name, args)
  assert(!r.isError, `${name} failed: ${textOf(r)}`)
  return r
}

export function structured<T = Record<string, unknown>>(r: ToolResult): T {
  assert(r.structuredContent && typeof r.structuredContent === 'object', 'tool result has no structuredContent')
  return r.structuredContent as T
}
