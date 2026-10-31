// handleMcpRequest: the Streamable HTTP endpoint (mounted at /api/mcp by the web app after it has
// verified the OAuth bearer token). Stateless: a new server + transport per request, JSON
// responses, no session ids, no GET stream.
//
// Dual-era (docs/research/mcp.md §1):
// - Legacy clients (2025-03-26 … 2025-11-25) send `initialize` first and are served by the SDK's
//   Web-standard transport in stateless JSON mode.
// - Modern clients (2026-07-28) send per-request `_meta` (protocol version, client info and
//   capabilities) and the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. We validate the
//   headers against the body (-32020 HeaderMismatch), answer `server/discover`, reject unknown
//   versions with -32022 (listing every supported version, so dual-era clients can fall back to
//   `initialize`), forward the request to the same server in-process, and add `resultType` plus
//   the caching hints (`ttlMs`, `cacheScope`) to the result.

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { SUPPORTED_PROTOCOL_VERSIONS, isInitializeRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { SERVER_NAME, SERVER_VERSION, appUrl, type McpContext } from './context'
import { SERVER_INSTRUCTIONS } from './instructions'
import { SERVER_CAPABILITIES, SERVER_TITLE, createMcpServer } from './server'

export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28']
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = [...SUPPORTED_PROTOCOL_VERSIONS]
/** Every version we speak, newest first (UnsupportedProtocolVersionError.data.supported). */
export const PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS]

export const MAX_BODY_BYTES = 4 * 1024 * 1024

const META_VERSION = 'io.modelcontextprotocol/protocolVersion'

/** JSON-RPC error codes used at the HTTP layer. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  headerMismatch: -32020,
  unsupportedProtocolVersion: -32022,
  forbidden: -32000,
} as const

/** Methods a modern request may call (forwarded to the server) and their caching hints. */
const MODERN_METHODS: Readonly<Record<string, { cache?: { ttlMs: number; cacheScope: 'public' | 'private' } }>> = {
  ping: {},
  'tools/list': { cache: { ttlMs: 300_000, cacheScope: 'public' } },
  'tools/call': {},
  'prompts/list': { cache: { ttlMs: 300_000, cacheScope: 'public' } },
  'prompts/get': {},
  'resources/list': { cache: { ttlMs: 300_000, cacheScope: 'public' } },
  'resources/templates/list': { cache: { ttlMs: 300_000, cacheScope: 'public' } },
  'resources/read': { cache: { ttlMs: 3_600_000, cacheScope: 'public' } },
}
const NAMED_METHODS: Readonly<Record<string, 'name' | 'uri'>> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function rpcError(status: number, id: unknown, code: number, message: string, data?: unknown, headers: Record<string, string> = {}): Response {
  const error: Record<string, unknown> = { code, message }
  if (data !== undefined) error.data = data
  return json(status, { jsonrpc: '2.0', id: isRequestId(id) ? id : null, error }, headers)
}

function isRequestId(id: unknown): id is string | number {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/** DNS-rebinding protection: an Origin header, when present, must be ours (or allow-listed). */
function checkOrigin(request: Request, ctx: McpContext): Response | null {
  const origin = request.headers.get('origin')
  if (origin === null) return null
  const allowed = new Set([appUrl(ctx), ...(ctx.allowedOrigins ?? [])].map(originOf).filter((o): o is string => o !== null))
  const normalized = originOf(origin)
  if (normalized !== null && allowed.has(normalized)) return null
  return rpcError(403, null, RPC.forbidden, 'Forbidden: this Origin is not allowed.')
}

/** Mcp-Name values may be sent as "=?base64?…?=" (UTF-8). Returns null when malformed. */
export function decodeHeaderValue(value: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value)
  if (!m) return value.startsWith('=?base64?') ? null : value
  try {
    const binary = atob(m[1] as string)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function readBody(request: Request): Promise<string | Response> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return rpcError(413, null, RPC.invalidRequest, `Request body too large (max ${MAX_BODY_BYTES} bytes).`)
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return rpcError(413, null, RPC.invalidRequest, `Request body too large (max ${MAX_BODY_BYTES} bytes).`)
  }
  return text
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && value.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function handleMcpRequest(request: Request, ctx: McpContext): Promise<Response> {
  const forbidden = checkOrigin(request, ctx)
  if (forbidden) return forbidden
  if (request.method !== 'POST') {
    // No standalone SSE stream (GET) and no sessions to delete (DELETE): stateless server.
    return rpcError(405, null, RPC.invalidRequest, 'Method not allowed: send JSON-RPC messages with POST.', undefined, { allow: 'POST' })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return rpcError(415, null, RPC.invalidRequest, 'Unsupported Media Type: Content-Type must be application/json.')
  }
  const text = await readBody(request)
  if (text instanceof Response) return text
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return rpcError(400, null, RPC.parseError, 'Parse error: invalid JSON.')
  }

  const headerVersion = request.headers.get('mcp-protocol-version')
  const metaVersion = modernVersionOf(body)
  const modern =
    metaVersion !== undefined ||
    (headerVersion !== null && !LEGACY_PROTOCOL_VERSIONS.includes(headerVersion) && !isInitializeRequest(body))
  try {
    return modern ? await handleModern(request, ctx, body, headerVersion, metaVersion) : await handleLegacy(request, ctx, body)
  } catch (error) {
    ctx.log?.error('mcp request failed', { err: error instanceof Error ? error : String(error) })
    return rpcError(500, isObject(body) ? body.id : null, -32603, 'Internal error. Please try again in a minute.')
  }
}

function modernVersionOf(body: unknown): string | undefined {
  if (!isObject(body) || !isObject(body.params) || !isObject(body.params._meta)) return undefined
  const v = body.params._meta[META_VERSION]
  return typeof v === 'string' ? v : undefined
}

// ---------------------------------------------------------------------------------------------
// Legacy era (initialize handshake), via the SDK transport in stateless JSON mode
// ---------------------------------------------------------------------------------------------

async function handleLegacy(request: Request, ctx: McpContext, body: unknown): Promise<Response> {
  const headers = new Headers(request.headers)
  // We always answer with JSON; accept clients that only list one of the two types (or none).
  const accept = headers.get('accept') ?? ''
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    headers.set('accept', 'application/json, text/event-stream')
  }
  const normalized = new Request(request.url, { method: 'POST', headers })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  const server = createMcpServer(ctx)
  try {
    await server.connect(transport)
    return await transport.handleRequest(normalized, { parsedBody: body })
  } finally {
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------
// Modern era (2026-07-28): per-request metadata
// ---------------------------------------------------------------------------------------------

async function handleModern(
  request: Request,
  ctx: McpContext,
  body: unknown,
  headerVersion: string | null,
  metaVersion: string | undefined,
): Promise<Response> {
  if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(400, isObject(body) ? body.id : null, RPC.invalidRequest, 'Invalid Request: send one JSON-RPC request per POST (no batches).')
  }
  const id = body.id
  const method = body.method
  const version = metaVersion ?? headerVersion ?? ''
  if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return rpcError(400, id, RPC.unsupportedProtocolVersion, 'Unsupported protocol version', {
      supported: PROTOCOL_VERSIONS,
      requested: version.slice(0, 40),
    })
  }

  // Header ↔ body validation
  const mismatch = (message: string) => rpcError(400, id, RPC.headerMismatch, `Header mismatch: ${message}`)
  if (headerVersion === null) return mismatch('the MCP-Protocol-Version header is missing.')
  if (metaVersion === undefined) return mismatch(`the request _meta has no "${META_VERSION}".`)
  if (headerVersion !== metaVersion) return mismatch('MCP-Protocol-Version does not match the request _meta protocol version.')
  const methodHeader = request.headers.get('mcp-method')
  if (methodHeader === null) return mismatch('the Mcp-Method header is missing.')
  if (methodHeader !== method) return mismatch('the Mcp-Method header does not match the request method.')
  const nameField = NAMED_METHODS[method]
  if (nameField) {
    const raw = request.headers.get('mcp-name')
    if (raw === null) return mismatch('the Mcp-Name header is missing.')
    const decoded = decodeHeaderValue(raw)
    const params = isObject(body.params) ? body.params : {}
    if (decoded === null) return mismatch('the Mcp-Name header is malformed.')
    if (decoded !== params[nameField]) return mismatch(`the Mcp-Name header does not match params.${nameField}.`)
  }

  if (id === undefined) return new Response(null, { status: 202 }) // notification: nothing to do
  if (!isRequestId(id)) return rpcError(400, null, RPC.invalidRequest, 'Invalid Request: id must be a string or a number.')

  if (method === 'server/discover') {
    return json(200, {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'complete',
        supportedVersions: PROTOCOL_VERSIONS,
        capabilities: SERVER_CAPABILITIES,
        instructions: SERVER_INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION } },
        ttlMs: 3_600_000,
        cacheScope: 'public',
      },
    })
  }
  const spec = MODERN_METHODS[method]
  if (!spec) return rpcError(404, id, RPC.methodNotFound, `Method not found: ${method.slice(0, 64)}`)

  const response = await dispatch(ctx, body as JSONRPCMessage, id)
  if ('error' in response && response.error) {
    return json(response.error.code === RPC.methodNotFound ? 404 : 200, response)
  }
  if ('result' in response && isObject(response.result)) {
    response.result = { ...response.result, resultType: 'complete', ...(spec.cache ?? {}) }
  }
  return json(200, response)
}

type RpcResponse = { jsonrpc: '2.0'; id: string | number; result?: Record<string, unknown>; error?: { code: number; message: string } }

/** Runs one request through a fresh server over an in-process transport. */
async function dispatch(ctx: McpContext, message: JSONRPCMessage, id: string | number): Promise<RpcResponse> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(ctx)
  try {
    await server.connect(serverSide)
    const answer = new Promise<RpcResponse>((resolve) => {
      client.onmessage = (m) => {
        const r = m as Partial<RpcResponse>
        if (r.id === id && ('result' in r || 'error' in r)) resolve(r as RpcResponse)
      }
    })
    await client.start()
    await client.send(message)
    return await answer
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}
