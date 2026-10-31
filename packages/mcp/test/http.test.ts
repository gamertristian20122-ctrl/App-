// handleMcpRequest over HTTP (Web Request/Response): legacy clients (initialize, stateless JSON)
// and 2026-07-28 clients (per-request _meta, header validation, server/discover, caching hints).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { APPROVAL_CARD_URI, APPROVAL_META_KEY, TOOL_NAMES, handleMcpRequest } from '../src'
import { BASE_URL, connect, createHarness, ctxFor, resetHarness, tenant, type Harness } from './helpers'

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

const URL_ = `${BASE_URL}/api/mcp`
const LEGACY = '2025-11-25'
const MODERN = '2026-07-28'

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const clientMeta = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'modern-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
}

function modern(id: number, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined
  return post(
    { jsonrpc: '2.0', id, method, params: { ...params, _meta: clientMeta } },
    { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}), ...headers },
  )
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

describe('legacy clients (initialize handshake, stateless)', () => {
  it('handles initialize, tools/list and tools/call as JSON with no session', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    const ctx = ctxFor(h, userId)

    const init = await handleMcpRequest(
      post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }),
      ctx,
    )
    expect(init.status).toBe(200)
    expect(init.headers.get('content-type')).toContain('application/json')
    expect(init.headers.get('mcp-session-id')).toBeNull()
    const initBody = await body(init)
    expect(initBody.result.protocolVersion).toBe(LEGACY)
    expect(initBody.result.serverInfo).toMatchObject({ name: 'social-mcp' })
    expect(initBody.result.capabilities).toMatchObject({ tools: {}, prompts: {}, resources: {} })
    expect(initBody.result.instructions).toMatch(/approve_draft/)

    const initialized = await handleMcpRequest(post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': LEGACY }), ctx)
    expect(initialized.status).toBe(202)

    // a different server instance answers each request (stateless); a stale session header is ignored
    const list = await handleMcpRequest(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': LEGACY, 'mcp-session-id': 'stale' }), ctx)
    expect(list.status).toBe(200)
    expect((await body(list)).result.tools.map((t: { name: string }) => t.name)).toEqual([...TOOL_NAMES])

    const call = await handleMcpRequest(
      post(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_draft', arguments: { brandId, variants: [{ platform: 'linkedin', text: 'Over HTTP' }] } } },
        { 'mcp-protocol-version': LEGACY, accept: 'application/json' }, // lenient Accept
      ),
      ctx,
    )
    expect(call.status).toBe(200)
    const result = (await body(call)).result
    expect(result.isError ?? false).toBe(false)
    expect(result.structuredContent.draft.variants[0].text).toBe('Over HTTP')

    const error = await handleMcpRequest(
      post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_draft', arguments: { brandId } } }, { 'mcp-protocol-version': LEGACY }),
      ctx,
    )
    expect((await body(error)).result).toMatchObject({ isError: true, structuredContent: { error: { code: 'validation' } } })
  })

  it('works with the SDK client over Streamable HTTP', async () => {
    const { userId } = await tenant(h)
    const ctx = ctxFor(h, userId)
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (input, init) => handleMcpRequest(new Request(input, init), ctx),
    })
    const client = new Client({ name: 'sdk-http-client', version: '1.0.0' })
    await client.connect(transport)
    expect(client.getInstructions()).toMatch(/approve_draft/)
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(TOOL_NAMES.length)
    const accounts = await client.callTool({ name: 'list_accounts', arguments: {} })
    expect(accounts.isError ?? false).toBe(false)
    const card = await client.readResource({ uri: APPROVAL_CARD_URI })
    expect(card.contents[0]?.mimeType).toBe('text/html;profile=mcp-app')
    const prompts = await client.listPrompts()
    expect(prompts.prompts.map((p) => p.name)).toEqual(['write_post', 'pick_clips', 'weekly_review'])
    await client.close()
  })

  it('refuses GET/DELETE, foreign origins, bad content types and bad JSON', async () => {
    const { userId } = await tenant(h)
    const ctx = ctxFor(h, userId, { allowedOrigins: ['https://inspector.example'] })
    const get = await handleMcpRequest(new Request(URL_, { method: 'GET', headers: { accept: 'text/event-stream' } }), ctx)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect((await handleMcpRequest(new Request(URL_, { method: 'DELETE' }), ctx)).status).toBe(405)

    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
    const evil = await handleMcpRequest(post(ping, { origin: 'https://evil.example' }), ctx)
    expect(evil.status).toBe(403)
    expect((await body(evil)).error.code).toBe(-32000)
    expect((await handleMcpRequest(post(ping, { origin: BASE_URL }), ctx)).status).toBe(200)
    expect((await handleMcpRequest(post(ping, { origin: 'https://inspector.example' }), ctx)).status).toBe(200)

    const text = await handleMcpRequest(new Request(URL_, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), ctx)
    expect(text.status).toBe(415)
    const bad = await handleMcpRequest(post('{not json'), ctx)
    expect(bad.status).toBe(400)
    expect((await body(bad)).error.code).toBe(-32700)
  })

  it('never logs the bearer token or tool arguments', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    const ctx = ctxFor(h, userId)
    await handleMcpRequest(
      post(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_draft', arguments: { brandId, variants: [{ platform: 'linkedin', text: 'secret launch plan' }] } } },
        { authorization: 'Bearer tok_live_abcdef123456', 'mcp-protocol-version': LEGACY },
      ),
      ctx,
    )
    const log = ctx.log.text()
    expect(log).toContain('mcp tool call')
    expect(log).not.toContain('tok_live_abcdef123456')
    expect(log).not.toContain('secret launch plan')
  })
})

describe('modern clients (2026-07-28, per-request metadata)', () => {
  it('answers server/discover with versions, capabilities, instructions and caching hints', async () => {
    const { userId } = await tenant(h)
    const res = await handleMcpRequest(modern(1, 'server/discover'), ctxFor(h, userId))
    expect(res.status).toBe(200)
    const result = (await body(res)).result
    expect(result).toMatchObject({ resultType: 'complete', cacheScope: 'public', capabilities: { tools: {}, prompts: {}, resources: {} } })
    expect(result.supportedVersions).toEqual(expect.arrayContaining([MODERN, LEGACY]))
    expect(result.ttlMs).toBeGreaterThan(0)
    expect(result.instructions).toMatch(/approve_draft/)
    expect(result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'social-mcp' })
  })

  it('serves tools/list, tools/call, prompts and resources statelessly with resultType and cache hints', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    const ctx = ctxFor(h, userId)
    const list = await body(await handleMcpRequest(modern(1, 'tools/list'), ctx))
    expect(list.result.tools).toHaveLength(TOOL_NAMES.length)
    expect(list.result).toMatchObject({ resultType: 'complete', cacheScope: 'public' })
    expect(list.result.ttlMs).toBeGreaterThan(0)

    const created = await body(
      await handleMcpRequest(modern(2, 'tools/call', { name: 'create_draft', arguments: { brandId, variants: [{ platform: 'linkedin', text: 'Modern era' }] } }), ctx),
    )
    expect(created.result.resultType).toBe('complete')
    expect(created.result.ttlMs).toBeUndefined()
    const draftId = created.result.structuredContent.draft.id as string

    const card = await body(await handleMcpRequest(modern(3, 'tools/call', { name: 'approve_draft', arguments: { draftId } }), ctx))
    expect(card.result._meta[APPROVAL_META_KEY].nonce).toBeTruthy()
    expect(JSON.stringify(card.result.content)).not.toContain(card.result._meta[APPROVAL_META_KEY].nonce)

    const read = await body(await handleMcpRequest(modern(4, 'resources/read', { uri: APPROVAL_CARD_URI }), ctx))
    expect(read.result.contents[0].mimeType).toBe('text/html;profile=mcp-app')
    expect(read.result).toMatchObject({ resultType: 'complete', cacheScope: 'public' })

    const prompt = await body(await handleMcpRequest(modern(5, 'prompts/get', { name: 'write_post', arguments: { brand_id: brandId, topic: 'Hello' } }), ctx))
    expect(prompt.result.messages[0].content.text).toContain('Hello')
    const badPrompt = await body(await handleMcpRequest(modern(6, 'prompts/get', { name: 'write_post', arguments: { brand_id: 'x', topic: 'Hello' } }), ctx))
    expect(badPrompt.error.code).toBe(-32602)

    // Mcp-Name may be base64-encoded
    const encoded = `=?base64?${Buffer.from('list_drafts', 'utf8').toString('base64')}?=`
    const drafts = await handleMcpRequest(modern(7, 'tools/call', { name: 'list_drafts', arguments: {} }, { 'mcp-name': encoded }), ctx)
    expect(drafts.status).toBe(200)
    expect((await body(drafts)).result.structuredContent.drafts).toHaveLength(1)
  })

  it('rejects header/body mismatches with -32020', async () => {
    const { userId } = await tenant(h)
    const ctx = ctxFor(h, userId)
    const cases: Request[] = [
      modern(1, 'tools/call', { name: 'list_drafts', arguments: {} }, { 'mcp-name': 'approve_draft' }),
      modern(2, 'tools/list', {}, { 'mcp-method': 'prompts/list' }),
      post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: clientMeta } }, { 'mcp-protocol-version': MODERN }), // no Mcp-Method
      post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_drafts', _meta: clientMeta } }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call' }), // no Mcp-Name
      post({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: clientMeta } }, { 'mcp-method': 'tools/list' }), // no version header
      post({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }), // no _meta version
      modern(7, 'tools/call', { name: 'list_drafts', arguments: {} }, { 'mcp-name': '=?base64?***?=' }),
    ]
    for (const req of cases) {
      const res = await handleMcpRequest(req, ctx)
      expect(res.status).toBe(400)
      expect((await body(res)).error.code).toBe(-32020)
    }
  })

  it('rejects unsupported versions with -32022 (listing every supported version) and unknown methods with 404', async () => {
    const { userId } = await tenant(h)
    const ctx = ctxFor(h, userId)
    const future = post(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...clientMeta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } },
      { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
    )
    const res = await handleMcpRequest(future, ctx)
    expect(res.status).toBe(400)
    const error = (await body(res)).error
    expect(error.code).toBe(-32022)
    expect(error.data).toEqual({ supported: expect.arrayContaining([MODERN, LEGACY]), requested: '2099-01-01' })

    for (const method of ['subscriptions/listen', 'initialize', 'logging/setLevel']) {
      const r = await handleMcpRequest(modern(2, method), ctx)
      expect(r.status, method).toBe(404)
      expect((await body(r)).error.code).toBe(-32601)
    }
    expect((await handleMcpRequest(post([{ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: clientMeta } }], { 'mcp-protocol-version': MODERN }), ctx)).status).toBe(400)
    const note = await handleMcpRequest(post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: clientMeta } }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'notifications/cancelled' }), ctx)
    expect(note.status).toBe(202)
  })

  it('serves the same tools to the in-memory client (sanity)', async () => {
    const { userId } = await tenant(h)
    const c = await connect(h, userId)
    expect((await c.client.listTools()).tools).toHaveLength(TOOL_NAMES.length)
    await c.close()
  })
})
