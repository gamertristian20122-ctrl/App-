// The approval card: served as an MCP Apps resource with a minimal CSP and no external URLs, and
// its inline script speaks the MCP Apps postMessage protocol. The script runs here in node:vm
// against a tiny fake DOM (no browser needed) and drives the real server's app-only tools.

import { randomUUID as draftKey } from 'node:crypto'
import vm from 'node:vm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { TIKTOK_PRIVACY_LABELS, TIKTOK_PRIVACY_LEVELS } from '@app/core/validation'
import { APPROVAL_CARD_HTML, APPROVAL_CARD_URI, APPROVAL_META_KEY, MCP_APP_MIME_TYPE, callTool, type McpContext } from '../src'
import { connect, createHarness, ctxFor, resetHarness, tenant, type Harness } from './helpers'

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

describe('approval card resource', () => {
  it('is listed and served as text/html;profile=mcp-app with a minimal CSP', async () => {
    const { userId } = await tenant(h)
    const c = await connect(h, userId)
    const { resources } = await c.client.listResources()
    expect(resources).toEqual([expect.objectContaining({ uri: APPROVAL_CARD_URI, mimeType: MCP_APP_MIME_TYPE, name: 'approval-card' })])
    const read = await c.client.readResource({ uri: APPROVAL_CARD_URI })
    expect(read.contents).toHaveLength(1)
    const content = read.contents[0] as { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> }
    expect(content.uri).toBe(APPROVAL_CARD_URI)
    expect(content.mimeType).toBe('text/html;profile=mcp-app')
    expect(content.text).toBe(APPROVAL_CARD_HTML)
    // media previews come from the storage origin only (memory storage: the local dev origin)
    expect(content._meta.ui).toEqual({ csp: { connectDomains: [], resourceDomains: ['http://localhost:3000'] }, prefersBorder: true })
    expect(content._meta['openai/widgetCSP']).toEqual({
      connect_domains: [],
      resource_domains: ['http://localhost:3000'],
      redirect_domains: ['https://app.test'],
    })
    await c.close()
  })

  it('uses configured media origins when given (https only)', async () => {
    const { userId } = await tenant(h)
    const c = await connect(h, userId, { mediaOrigins: ['https://media.example.com/some/path', 'http://evil.example.com', 'not a url'] })
    const read = await c.client.readResource({ uri: APPROVAL_CARD_URI })
    const meta = (read.contents[0] as unknown as { _meta: { ui: { csp: { resourceDomains: string[] } } } })._meta
    expect(meta.ui.csp.resourceDomains).toEqual(['https://media.example.com'])
    await c.close()
  })

  it('is self-contained: no external URLs, scripts, styles or frames, and no innerHTML', () => {
    const html = APPROVAL_CARD_HTML
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toMatch(/https?:\/\//i)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/<iframe\b/i)
    const css = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? ''
    expect(css).not.toMatch(/@import|url\(/i)
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/)
    for (const method of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/notifications/host-context-changed', 'tools/call', 'ui/open-link', 'ui/update-model-context', 'ui/notifications/size-changed']) {
      expect(html, method).toContain(`'${method}'`)
    }
    expect(html).toContain("'approval_decide'")
    expect(html).toContain("'approval_edit_variant'")
    // the inline script parses
    expect(() => new vm.Script(inlineScript(html))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
// A tiny DOM, enough for the card's script
// ---------------------------------------------------------------------------------------------

type Listener = (event: unknown) => void

class FakeNode {
  children: FakeNode[] = []
  parent: FakeNode | null = null
  attributes = new Map<string, string>()
  listeners = new Map<string, Listener[]>()
  ownText = ''
  value = ''
  style: Record<string, unknown> & { setProperty: (k: string, v: string) => void }
  scrollHeight = 320
  scrollWidth = 400
  constructor(readonly tagName: string) {
    const style: Record<string, unknown> = {}
    this.style = Object.assign(style, { setProperty: (k: string, v: string) => void (style[k] = v) })
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    this.children = []
    this.ownText = String(v)
  }
  appendChild(child: FakeNode): FakeNode {
    child.parent = this
    this.children.push(child)
    return child
  }
  replaceWith(node: FakeNode): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    this.parent.children[i] = node
    node.parent = this.parent
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v))
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this })
  }
  click(): void {
    if (this.attributes.has('disabled')) throw new Error(`button "${this.textContent}" is disabled`)
    this.fire('click')
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())]
  }
  getBoundingClientRect(): { width: number; height: number } {
    return { width: this.scrollWidth, height: this.scrollHeight }
  }
}

interface Rpc {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

function inlineScript(html: string): string {
  const m = /<script>([\s\S]*)<\/script>/.exec(html)
  if (!m) throw new Error('no inline script')
  return m[1] as string
}

/** Loads the card in a sandbox. `parent: false` → not framed (ChatGPT window.openai only). */
function loadCard(options: { parent?: boolean; openai?: Record<string, unknown> } = {}) {
  const root = new FakeNode('div')
  const documentElement = new FakeNode('html')
  const posted: Rpc[] = []
  const windowListeners = new Map<string, Listener[]>()
  const parent = { postMessage: (msg: Rpc) => posted.push(JSON.parse(JSON.stringify(msg)) as Rpc) }
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
    open: () => null,
  }
  win.parent = options.parent === false ? win : parent
  if (options.openai) win.openai = options.openai
  const document = {
    getElementById: () => root,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (t: string) => Object.assign(new FakeNode('#text'), { ownText: t }),
    documentElement,
  }
  vm.runInNewContext(inlineScript(APPROVAL_CARD_HTML), {
    window: win,
    document,
    setTimeout: () => 0, // timeouts never fire in tests
    Intl,
    TextEncoder,
    URL,
    Promise,
  })
  const deliver = (msg: Rpc) => {
    for (const fn of windowListeners.get('message') ?? []) fn({ source: parent, data: msg })
  }
  const button = (label: string) => {
    const found = root.all().find((n) => n.tagName === 'button' && n.textContent === label)
    if (!found) throw new Error(`no "${label}" button in: ${root.textContent}`)
    return found
  }
  return { root, documentElement, posted, deliver, button }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

type Card = ReturnType<typeof loadCard>

function tab(card: Card, label: string): FakeNode {
  const found = card.root.all().find((n) => n.getAttribute('role') === 'tab' && n.textContent === label)
  if (!found) throw new Error(`no tab ${label}`)
  return found
}

function textarea(card: Card): FakeNode {
  const found = card.root.all().find((n) => n.tagName === 'textarea')
  if (!found) throw new Error('no textarea')
  return found
}

/** Types into the (current) textarea like a user. */
function type(card: Card, value: string): void {
  const area = textarea(card)
  area.value = value
  area.fire('input')
}

describe('approval card script (MCP Apps protocol)', () => {
  async function setup() {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin', 'x'] })
    const view = await h.services.drafts.create(userId, {
      brandId,
      variants: [
        { platform: 'linkedin', text: 'Big news: we are open on Sundays now.' },
        { platform: 'x', text: 'Open Sundays!' },
      ],
    })
    const ctx = ctxFor(h, userId)
    const result = await callTool(ctx, 'approve_draft', { draftId: view.draft.id })
    const nonce = (result._meta?.[APPROVAL_META_KEY] as { nonce: string }).nonce
    return { ctx, userId, draftId: view.draft.id, result, nonce }
  }

  /** Answers the card's tools/call with the real server's result. */
  async function answerToolCall(card: ReturnType<typeof loadCard>, ctx: McpContext): Promise<CallToolResult> {
    const call = card.posted.filter((m) => m.method === 'tools/call').at(-1)
    if (!call) throw new Error('no tools/call')
    const params = call.params as { name: string; arguments: Record<string, unknown> }
    const result = await callTool(ctx, params.name, params.arguments)
    card.deliver({ jsonrpc: '2.0', id: call.id as number, result })
    await flush()
    return result
  }

  it('handshakes, renders the tool result and approves through approval_decide with the nonce', async () => {
    const { ctx, userId, draftId, result, nonce } = await setup()
    const card = loadCard()

    const init = card.posted[0]
    expect(init).toMatchObject({ jsonrpc: '2.0', method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'approval-card' } } })
    card.deliver({ jsonrpc: '2.0', id: init?.id as number, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'host', version: '1' }, hostContext: { theme: 'dark' } } })
    await flush()
    expect(card.posted.some((m) => m.method === 'ui/notifications/initialized')).toBe(true)
    expect(card.documentElement.getAttribute('data-theme')).toBe('dark')

    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { draftId } } })
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result as Record<string, unknown> })
    await flush()
    expect(card.root.textContent).toContain('Open Sundays!') // first tab (X)
    expect(card.root.textContent).toMatch(/13 \/ 280 characters/)
    tab(card, 'LinkedIn').click()
    expect(card.root.textContent).toContain('Big news: we are open on Sundays now.')
    expect(card.root.textContent).toMatch(/37 \/ 3000 characters/)
    expect(card.posted.some((m) => m.method === 'ui/notifications/size-changed')).toBe(true)

    card.button('Approve').click()
    const call = card.posted.filter((m) => m.method === 'tools/call').at(-1)
    expect(call?.params).toEqual({ name: 'approval_decide', arguments: { draftId, nonce, decision: 'approve' } })
    const decided = await answerToolCall(card, ctx)
    expect(decided.isError ?? false).toBe(false)
    expect(card.root.textContent).toContain('Approved')
    expect(card.root.textContent).toContain('Nothing is published yet')
    expect(card.posted.some((m) => m.method === 'ui/update-model-context')).toBe(true)
    expect((await h.services.drafts.get(userId, draftId)).draft.status).toBe('approved')

    // host pings and teardown are answered
    card.deliver({ jsonrpc: '2.0', id: 99, method: 'ping' })
    card.deliver({ jsonrpc: '2.0', id: 100, method: 'ui/resource-teardown', params: { reason: 'closed' } })
    expect(card.posted.filter((m) => m.id === 99 || m.id === 100).map((m) => m.result)).toEqual([{}, {}])
  })

  it('edits a variant (new nonce) and shows server errors', async () => {
    const { ctx, userId, draftId, result } = await setup()
    const card = loadCard()
    card.deliver({ jsonrpc: '2.0', id: card.posted[0]?.id as number, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'h', version: '1' }, hostContext: {} } })
    await flush()
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result as Record<string, unknown> })
    await flush()

    // edit X beyond the limit: the server refuses, the card shows why and keeps the text
    tab(card, 'X').click()
    card.button('Edit').click()
    type(card, 'z'.repeat(290))
    expect(card.root.textContent).toContain('(10 over)')
    card.button('Save changes').click()
    const failed = await answerToolCall(card, ctx)
    expect(failed.isError).toBe(true)
    expect(card.root.textContent).toMatch(/280/)
    expect(textarea(card).value).toBe('z'.repeat(290))

    type(card, 'Open on Sundays from 10 to 4.')
    card.button('Save changes').click()
    const edit = card.posted.filter((m) => m.method === 'tools/call').at(-1)
    expect(edit?.params).toMatchObject({ name: 'approval_edit_variant', arguments: { draftId, platform: 'x', text: 'Open on Sundays from 10 to 4.' } })
    const edited = await answerToolCall(card, ctx)
    const newNonce = (edited._meta?.[APPROVAL_META_KEY] as { nonce: string }).nonce
    expect(card.root.textContent).toContain('Open on Sundays from 10 to 4.')
    expect(card.root.textContent).toContain('rev 2')

    card.button('Approve').click()
    const approve = card.posted.filter((m) => m.method === 'tools/call').at(-1)
    expect(approve?.params).toEqual({ name: 'approval_decide', arguments: { draftId, nonce: newNonce, decision: 'approve' } })
    await answerToolCall(card, ctx)
    expect((await h.services.drafts.get(userId, draftId)).draft).toMatchObject({ status: 'approved', revision: 2 })
  })

  it('asks who can see a TikTok post and approves once chosen (e2e: worker drafts had no way to set it)', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['tiktok'] })
    const clip = await h.r.media.create(userId, {
      brandId,
      kind: 'video',
      origin: 'clip',
      status: 'ready',
      storageKey: `users/${userId}/clips/${draftKey()}.mp4`,
      mimeType: 'video/mp4',
      bytes: 3_000_000,
      durationMs: 20_000,
      width: 1080,
      height: 1920,
    })
    const view = await h.services.drafts.create(userId, { brandId, variants: [{ platform: 'tiktok', text: 'New clip', mediaIds: [clip.id] }] }, { via: 'worker' })
    const ctx = ctxFor(h, userId)
    const result = await callTool(ctx, 'approve_draft', { draftId: view.draft.id })
    const card = loadCard()
    card.deliver({ jsonrpc: '2.0', id: card.posted[0]?.id as number, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'h', version: '1' }, hostContext: {} } })
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result as Record<string, unknown> })
    await flush()

    expect(card.root.textContent).toContain('Who can see this TikTok post')
    expect(card.button('Approve').attributes.has('disabled')).toBe(true)
    const select = card.root.all().find((n) => n.tagName === 'select')
    if (!select) throw new Error('no privacy select')
    // no default: the person must choose (TikTok's rule); the labels match core's
    expect(select.value).toBe('')
    const labels = select.children.filter((o) => o.getAttribute('value')).map((o) => o.textContent)
    expect(labels).toEqual(TIKTOK_PRIVACY_LEVELS.map((l) => TIKTOK_PRIVACY_LABELS[l]))

    select.value = 'SELF_ONLY'
    select.fire('change')
    const call = card.posted.filter((m) => m.method === 'tools/call').at(-1)
    expect(call?.params).toMatchObject({ name: 'approval_edit_variant', arguments: { draftId: view.draft.id, platform: 'tiktok', privacyLevel: 'SELF_ONLY' } })
    const edited = await answerToolCall(card, ctx)
    expect(edited.isError ?? false).toBe(false)
    expect(card.root.textContent).toContain('rev 2')

    card.button('Approve').click()
    await answerToolCall(card, ctx)
    expect(card.root.textContent).toContain('Approved')
    expect(card.root.textContent).not.toContain('Waiting for approval') // the pill follows the decision
    const saved = await h.services.drafts.get(userId, view.draft.id)
    expect(saved.draft.status).toBe('approved')
    expect(saved.variants[0]?.options).toEqual({ privacyLevel: 'SELF_ONLY' })
  })

  it('shows every option that gets published, e.g. a hidden first comment and collaborators (review: approved unseen)', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['instagram'] })
    const image = await h.r.media.create(userId, {
      brandId,
      kind: 'image',
      origin: 'upload',
      status: 'ready',
      storageKey: `users/${userId}/uploads/${draftKey()}.jpg`,
      mimeType: 'image/jpeg',
      bytes: 200_000,
      width: 1080,
      height: 1350,
    })
    const view = await h.services.drafts.create(userId, {
      brandId,
      variants: [
        {
          platform: 'instagram',
          text: 'Big launch today!',
          mediaIds: [image.id],
          options: { firstComment: 'Get it here https://scam.example', collaborators: ['attacker'], shareToFeed: true },
        },
      ],
    })
    const ctx = ctxFor(h, userId)
    const result = await callTool(ctx, 'approve_draft', { draftId: view.draft.id })
    const card = loadCard()
    card.deliver({ jsonrpc: '2.0', id: card.posted[0]?.id as number, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'h', version: '1' }, hostContext: {} } })
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result as Record<string, unknown> })
    await flush()
    const text = card.root.textContent
    expect(text).toContain('Big launch today!')
    expect(text).toContain('First comment')
    expect(text).toContain('Get it here https://scam.example')
    expect(text).toContain('Collaborators (invited)')
    expect(text).toContain('attacker')
    expect(text).toContain('Also share to feed')
  })

  it('reports its own height, so the host can shrink it again (e2e: stayed tall after Approve)', async () => {
    const { result } = await setup()
    const card = loadCard()
    card.deliver({ jsonrpc: '2.0', id: card.posted[0]?.id as number, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'h', version: '1' }, hostContext: {} } })
    await flush()
    card.root.scrollHeight = 480
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result as Record<string, unknown> })
    await flush()
    // the document is as tall as the iframe the host made; the card is not
    card.documentElement.scrollHeight = 900
    card.root.scrollHeight = 140
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: {} })
    const sizes = card.posted.filter((m) => m.method === 'ui/notifications/size-changed').map((m) => (m.params as { height: number }).height)
    expect(sizes.at(-1)).toBe(140)
    expect(sizes).toContain(480)
  })

  it('rejects with a reason', async () => {
    const { ctx, userId, draftId, result } = await setup()
    const card = loadCard()
    card.deliver({ jsonrpc: '2.0', id: card.posted[0]?.id as number, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'h', version: '1' }, hostContext: {} } })
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result as Record<string, unknown> })
    await flush()
    card.button('Reject').click()
    type(card, 'Wrong opening hours')
    card.button('Reject draft').click()
    await answerToolCall(card, ctx)
    expect(card.root.textContent).toContain('Rejected')
    expect((await h.services.drafts.get(userId, draftId)).draft).toMatchObject({ status: 'rejected', rejectedReason: 'Wrong opening hours' })
  })

  it('falls back to window.openai (ChatGPT Apps SDK) when not framed by an MCP Apps host', async () => {
    const { ctx, userId, draftId, result, nonce } = await setup()
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const card = loadCard({
      parent: false,
      openai: {
        theme: 'light',
        toolOutput: result.structuredContent,
        toolResponseMetadata: result._meta,
        callTool: (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args })
          return callTool(ctx, name, args)
        },
      },
    })
    expect(card.posted).toEqual([]) // no parent: no MCP Apps handshake
    expect(card.root.textContent).toContain('Open Sundays!')
    card.button('Approve').click()
    await flush()
    await flush()
    expect(calls).toEqual([{ name: 'approval_decide', args: { draftId, nonce, decision: 'approve' } }])
    expect(card.root.textContent).toContain('Approved')
    expect((await h.services.drafts.get(userId, draftId)).draft.status).toBe('approved')
  })

  it('without a nonce (model-visible data only) it offers the web app instead of buttons', async () => {
    const { result } = await setup()
    const card = loadCard({ parent: false, openai: { toolOutput: result.structuredContent } })
    expect(card.root.textContent).toContain('Open Sundays!')
    expect(card.root.textContent).toContain('Approve this draft in the web app.')
    expect(() => card.button('Approve')).toThrow()
    expect(card.button('Open in web app')).toBeTruthy()
  })
})
