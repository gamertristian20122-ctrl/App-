// End to end through the real stack (integration): an MCP client signs in with our OAuth server
// (DCR → consent → code + PKCE → token), then drives the real @app/mcp handler mounted at
// /api/mcp: initialize, tools/list, list_accounts, create_draft, approve_draft (card nonce only in
// _meta), the card's approval_decide, schedule_post and post_status. The AI can never approve on
// its own: the model-visible result carries no nonce, and the web link nonce is refused over MCP.

import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestAccount, createTestBrand } from '@app/db/testing'
import { POST as mcpPost } from '@/app/api/mcp/route'
import { POST as register } from '@/app/oauth/register/route'
import { POST as token } from '@/app/oauth/token/route'
import { decideConsent } from '@/lib/server/oauth'
import { BASE, createHarness, readJson, request, type Harness } from './harness'

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'

let h: Harness
let user: { id: string; email: string }
let brandId: string
let accessToken: string
let rpcId = 0

beforeAll(async () => {
  h = await createHarness()
  user = await h.createUser('e2e@example.com')
  const brand = await createTestBrand(h.db, user.id, { name: 'Acme' })
  brandId = brand.id
  await createTestAccount(h.db, user.id, brandId, { platform: 'x', provider: 'fake' })
  await createTestAccount(h.db, user.id, brandId, { platform: 'linkedin', provider: 'fake' })
})
afterAll(async () => {
  await h.close()
})

interface RpcResult {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
  tools?: Array<{ name: string; title?: string; annotations?: Record<string, unknown> }>
  [key: string]: unknown
}

async function rpc(method: string, params: Record<string, unknown> = {}, bearer = accessToken): Promise<{ status: number; result?: RpcResult; error?: { code: number; message: string } }> {
  const res = await mcpPost(
    request('/api/mcp', {
      json: { jsonrpc: '2.0', id: ++rpcId, method, params },
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    }),
  )
  if (res.status !== 200) return { status: res.status }
  const body = await readJson<{ result?: RpcResult; error?: { code: number; message: string } }>(res)
  return { status: res.status, ...body }
}

async function call(name: string, args: Record<string, unknown>) {
  const out = await rpc('tools/call', { name, arguments: args })
  if (!out.result) throw new Error(`tools/call ${name} failed: ${JSON.stringify(out)}`)
  return out.result
}

const textOf = (r: RpcResult) => (r.content ?? []).map((c) => c.text ?? '').join('\n')

describe('OAuth → /api/mcp → @app/mcp → services (integration)', () => {
  it('a client signs in with DCR + PKCE and gets a token for our MCP resource', async () => {
    const reg = await register(request('/oauth/register', { json: { client_name: 'ChatGPT', redirect_uris: [REDIRECT] } }))
    expect(reg.status).toBe(201)
    const clientId = (await readJson<{ client_id: string }>(reg)).client_id
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'social',
      resource: `${BASE}/api/mcp`,
      state: 's1',
    })
    const decided = await decideConsent(h.rt.services, user, query, 'approve')
    if (decided.kind !== 'redirect') throw new Error('consent did not redirect')
    const code = new URL(decided.url).searchParams.get('code') as string
    const res = await token(request('/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT } }))
    expect(res.status).toBe(200)
    accessToken = (await readJson<{ access_token: string }>(res)).access_token
    expect(accessToken).toBeTruthy()

    // without the token the endpoint challenges; with a made-up one it says invalid_token
    expect((await rpc('tools/list', {}, '')).status).toBe(401)
    expect((await rpc('tools/list', {}, 'not-a-real-token')).status).toBe(401)
  })

  it('initialize and tools/list expose every v1 tool with a title and a hint', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } })
    expect(init.result?.capabilities).toMatchObject({ tools: {}, prompts: {}, resources: {} })
    expect(String(init.result?.instructions)).toContain('approve_draft')

    const list = await rpc('tools/list')
    const names = (list.result?.tools ?? []).map((t) => t.name)
    for (const name of [
      'connect_account',
      'list_accounts',
      'create_draft',
      'list_drafts',
      'approve_draft',
      'schedule_post',
      'post_status',
      'get_transcript',
      'make_clips',
      'import_past_posts',
      'save_voice_profile',
      'render_carousel',
      'render_video',
      'get_analytics',
    ]) {
      expect(names, name).toContain(name)
    }
    for (const tool of list.result?.tools ?? []) {
      expect(tool.title, tool.name).toBeTruthy()
      const a = tool.annotations ?? {}
      expect(typeof a.readOnlyHint === 'boolean' || typeof a.destructiveHint === 'boolean', tool.name).toBe(true)
    }
  })

  it('drafts, approves only through the card nonce, schedules and reports status', async () => {
    const accounts = await call('list_accounts', {})
    expect(textOf(accounts)).toContain(brandId)

    // a limit error tells the AI exactly how far over it is
    const tooLong = await call('create_draft', { brandId, variants: [{ platform: 'x', text: 'a'.repeat(300) }] })
    expect(tooLong.isError).toBe(true)
    expect(textOf(tooLong)).toMatch(/20 over the limit of 280/)

    const created = await call('create_draft', {
      brandId,
      variants: [
        { platform: 'x', text: 'Shipping clips today.' },
        { platform: 'linkedin', text: 'We are shipping vertical clips today.' },
      ],
    })
    expect(created.isError).toBeFalsy()
    const draftId = ((created.structuredContent?.draft as { id?: string } | undefined)?.id ?? '') as string
    expect(draftId).toMatch(/^[0-9a-f-]{36}$/)

    // scheduling before approval is refused with a pointer to approve_draft
    const early = await call('schedule_post', { draftId, at: 'now' })
    expect(early.isError).toBe(true)
    expect(textOf(early)).toContain('approve_draft')

    const card = await call('approve_draft', { draftId })
    const meta = card._meta?.approvalCard as { nonce?: string; webUrl?: string } | undefined
    expect(meta?.nonce).toBeTruthy()
    const visible = JSON.stringify({ content: card.content, structuredContent: card.structuredContent })
    expect(visible).not.toContain(meta?.nonce as string)
    expect(textOf(card)).toContain(`/app/approvals?draft=${draftId}`)

    // a guessed nonce is refused; the card's nonce approves exactly once
    const guessed = await call('approval_decide', { draftId, nonce: 'guess', decision: 'approve' })
    expect(guessed.isError).toBe(true)
    const approved = await call('approval_decide', { draftId, nonce: meta?.nonce, decision: 'approve' })
    expect(approved.isError).toBeFalsy()
    expect(approved.structuredContent).toMatchObject({ decision: 'approve', status: 'approved' })
    expect((await call('approval_decide', { draftId, nonce: meta?.nonce, decision: 'approve' })).isError).toBe(true)

    const scheduled = await call('schedule_post', { draftId, at: 'now' })
    expect(scheduled.isError).toBeFalsy()
    const posts = (scheduled.structuredContent?.posts ?? []) as Array<{ id: string; platform: string; status: string }>
    expect(posts.map((p) => p.platform).sort()).toEqual(['linkedin', 'x'])
    expect(posts.every((p) => p.status === 'scheduled')).toBe(true)
    // the worker picks these up: one publish job per post
    const jobs = await h.rt.services.jobs.listForUser(user.id, { type: 'publish_post' })
    expect(jobs).toHaveLength(2)

    const status = await call('post_status', { draftId })
    expect(textOf(status)).toMatch(/scheduled/)
  })
})
