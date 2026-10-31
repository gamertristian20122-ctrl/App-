// upload_media, render_code_video, publish_video and autoPublish on the render tools: annotations,
// happy paths, validation errors, the curl / presign shape, and the approval-card nonce staying in
// _meta (never in content or structuredContent).

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createLocalStorageHandler } from '@app/storage'
import { curlCommand, shellQuote } from '../src/tools/publish'
import { OTHER_UUID, connect, createHarness, expectOk, expectToolError, resetHarness, structured, tenant, text, type Harness } from './helpers'

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

async function readyVideo(userId: string, brandId: string) {
  return h.r.media.create(userId, {
    brandId,
    kind: 'video',
    origin: 'render',
    status: 'ready',
    storageKey: `users/${userId}/renders/${randomUUID()}.mp4`,
    mimeType: 'video/mp4',
    bytes: 1_000_000,
    durationMs: 12_000,
    width: 1080,
    height: 1920,
  })
}

function turnOn(userId: string, brandId: string, extra: Record<string, unknown> = {}) {
  return h.services.brands.setAutoPost(userId, brandId, { enabled: true, ...extra }, { via: 'web' })
}

/** The card nonce must only ever be in _meta. */
function expectNonceOnlyInMeta(result: CallToolResult): string {
  const nonce = (result._meta?.approvalCard as { nonce?: string } | undefined)?.nonce
  expect(nonce, 'card nonce in _meta').toMatch(/^[A-Za-z0-9_-]{40,}$/)
  const visible = JSON.stringify({ content: result.content, structuredContent: result.structuredContent })
  expect(visible).not.toContain(nonce as string)
  return nonce as string
}

describe('tools/list: the auto pipeline tools', () => {
  it('have titles and hints; publish_video is destructive and renders the approval card', async () => {
    const { userId } = await tenant(h)
    const c = await connect(h, userId)
    const { tools } = await c.client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('upload_media')?.annotations).toMatchObject({ title: 'Upload a finished video or image', readOnlyHint: false, destructiveHint: false, openWorldHint: true })
    expect(byName.get('render_code_video')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true })
    expect(byName.get('publish_video')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false })
    expect(byName.get('publish_video')?._meta).toMatchObject({ ui: { resourceUri: 'ui://approval-card/v1' }, 'openai/outputTemplate': 'ui://approval-card/v1' })
    for (const name of ['make_clips', 'render_video', 'render_carousel', 'render_code_video']) {
      const schema = byName.get(name)?.inputSchema as { properties: Record<string, { description?: string }> }
      expect(schema.properties.autoPublish?.description, name).toMatch(/Auto-post/)
    }
    expect(byName.get('upload_media')?.description).toMatch(/Claude Code, Cursor, Codex/)
    expect(c.client.getInstructions()).toMatch(/upload_media/)
    expect(c.client.getInstructions()).toMatch(/publish_video/)
    expect(c.client.getInstructions()).toMatch(/only the user|user's switch/i)
    await c.close()
  })
})

describe('upload_media', () => {
  it('returns a presigned PUT, its headers and a ready-to-run curl; the PUT works and publish_video picks it up', async () => {
    const t = await tenant(h, { platforms: ['instagram'] })
    const c = await connect(h, t.userId)
    const body = new Uint8Array(2048).fill(3)
    const r = await c.call('upload_media', { brandId: t.brandId, filename: "out/it's final.mp4", contentType: 'video/mp4', bytes: body.length })
    expectOk(r)
    const s = structured<{ mediaId: string; uploadUrl: string; method: string; headers: Record<string, string>; expiresAt: string; curl: string }>(r)
    expect(s.method).toBe('PUT')
    expect(s.headers).toEqual({ 'Content-Type': 'video/mp4' })
    expect(new Date(s.expiresAt).getTime()).toBeGreaterThan(h.clock.now().getTime())
    expect(s.curl).toBe(`curl --fail --silent --show-error -X PUT -H 'Content-Type: video/mp4' --upload-file 'out/it'\\''s final.mp4' '${s.uploadUrl}'`)
    expect(text(r)).toContain(s.curl)
    expect(text(r)).toMatch(/publish_video with mediaId=/)
    const put = await createLocalStorageHandler(h.storage)(new Request(s.uploadUrl, { method: 'PUT', headers: s.headers, body }))
    expect(put.status).toBe(200)
    // publish_video completes it (head check) and, the switch being off, shows the card
    const p = await c.call('publish_video', { brandId: t.brandId, mediaId: s.mediaId, caption: 'Made with code' })
    expectOk(p)
    expect(structured<{ outcome: string }>(p).outcome).toBe('switch_off')
    expectNonceOnlyInMeta(p)
    await c.close()
  })

  it('imports a finished video from an https link, and refuses video sites, private hosts and bad arguments', async () => {
    const t = await tenant(h)
    const c = await connect(h, t.userId)
    const ok = await c.call('upload_media', { sourceUrl: 'https://cdn.example.com/renders/final.mp4' })
    expectOk(ok)
    expect(structured(ok)).toMatchObject({ status: 'pending', origin: 'url_import', host: 'cdn.example.com', kind: 'video' })
    expect(JSON.stringify(ok)).not.toContain('renders/final.mp4') // the link itself is not echoed back
    expectToolError(await c.call('upload_media', { sourceUrl: 'https://www.youtube.com/watch?v=abc' }), 'validation', /video sites/)
    expectToolError(await c.call('upload_media', { sourceUrl: 'https://www.tiktok.com/@a/video/1' }), 'validation', /only post videos you made/)
    expectToolError(await c.call('upload_media', { sourceUrl: 'https://169.254.169.254/latest/meta-data' }), 'validation', /IP address/)
    expectToolError(await c.call('upload_media', { filename: 'a.mp4', contentType: 'video/mp4' }), 'validation', /bytes/)
    expectToolError(await c.call('upload_media', { sourceUrl: 'https://cdn.example.com/a.mp4', filename: 'a.mp4' }), 'validation', /either sourceUrl/)
    expectToolError(await c.call('upload_media', { filename: 'a.exe', contentType: 'application/x-msdownload', bytes: 10 }), 'validation')
    expectToolError(await c.call('upload_media', { filename: 'a.mp4', contentType: 'video/mp4', bytes: 10, brandId: OTHER_UUID }), 'not_found')
    await c.close()
  })

  it('quotes for a POSIX shell', () => {
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'")
    expect(curlCommand('x.mp4', 'https://s/u?a=1&b=2', { 'Content-Type': 'video/mp4' })).toBe(
      "curl --fail --silent --show-error -X PUT -H 'Content-Type: video/mp4' --upload-file 'x.mp4' 'https://s/u?a=1&b=2'",
    )
  })
})

describe('publish_video', () => {
  it('Auto-post on: approved by the rule and scheduled; no nonce anywhere', async () => {
    const t = await tenant(h, { platforms: ['instagram', 'youtube'] })
    await turnOn(t.userId, t.brandId)
    const media = await readyVideo(t.userId, t.brandId)
    const c = await connect(h, t.userId)
    const r = await c.call('publish_video', { brandId: t.brandId, mediaId: media.id, caption: 'Our launch, in 12 seconds', when: 'now' })
    const out = expectOk(r)
    expect(out).toMatch(/^Posted automatically/)
    const s = structured<{ autoPosted: boolean; outcome: string; posts: Array<{ platform: string; status: string; approvedVia: string }>; draftId: string }>(r)
    expect(s).toMatchObject({ autoPosted: true, outcome: 'posted' })
    expect(s.posts.map((p) => p.platform).sort()).toEqual(['instagram', 'youtube'])
    expect(s.posts.every((p) => p.status === 'scheduled' && p.approvedVia === 'auto_post')).toBe(true)
    const meta = r._meta?.approvalCard as { nonce?: string; autoPosted?: boolean; preview?: { draft: { approvedVia: string } } }
    expect(meta.nonce).toBeUndefined()
    expect(meta.autoPosted).toBe(true)
    expect(meta.preview?.draft.approvedVia).toBe('auto_post')
    // post_status marks auto-posted posts
    const status = await c.call('post_status', { draftId: s.draftId })
    expect(text(status)).toMatch(/\[auto-posted\]/)
    expect(structured(status)).toMatchObject({ autoPost: { outcome: 'posted' } })
    await c.close()
  })

  it('Auto-post off (or a check fails): the approval card, the web link and the reason', async () => {
    const t = await tenant(h, { platforms: ['instagram'] })
    const media = await readyVideo(t.userId, t.brandId)
    const c = await connect(h, t.userId)
    const r = await c.call('publish_video', { brandId: t.brandId, mediaId: media.id, caption: 'Hello' })
    const out = expectOk(r)
    expect(out).toMatch(/Not posted yet: Auto-post is off for Acme/)
    expect(out).toMatch(/https:\/\/app\.test\/app\/approvals\?draft=/)
    const s = structured<{ autoPosted: boolean; outcome: string; reason: string; approvalUrl: string; status: string }>(r)
    expect(s).toMatchObject({ autoPosted: false, outcome: 'switch_off', status: 'draft' })
    expect(s.reason).toMatch(/Only the user can turn Auto-post on/)
    const nonce = expectNonceOnlyInMeta(r)
    // the card's nonce approves through the app-only tool, as with approve_draft
    const draftId = (structured<{ draftId: string }>(r)).draftId
    expectOk(await c.call('approval_decide', { draftId, nonce, decision: 'approve' }))

    // switch on, daily max 1: the second video waits with the reason
    await turnOn(t.userId, t.brandId, { dailyMax: 1 })
    expect(structured(await c.call('publish_video', { brandId: t.brandId, mediaId: media.id, caption: 'One' }))).toMatchObject({ outcome: 'posted' })
    const second = await c.call('publish_video', { brandId: t.brandId, mediaId: media.id, caption: 'Two' })
    expect(structured(second)).toMatchObject({ outcome: 'daily_max', autoPosted: false })
    expectNonceOnlyInMeta(second)
    await c.close()
  })

  it('validation errors are explained (caption, X links, platforms, other users\' media)', async () => {
    const t = await tenant(h, { platforms: ['x', 'instagram'] })
    const media = await readyVideo(t.userId, t.brandId)
    const other = await tenant(h)
    const otherMedia = await readyVideo(other.userId, other.brandId)
    const c = await connect(h, t.userId)
    expectToolError(await c.call('publish_video', { brandId: t.brandId, mediaId: media.id }), 'validation', /caption/)
    expectToolError(await c.call('publish_video', { brandId: t.brandId, mediaId: media.id, caption: 'see https://example.com', platforms: ['x'] }), 'validation', /X: Links are not supported/)
    expectToolError(await c.call('publish_video', { brandId: t.brandId, mediaId: media.id, caption: 'a', platforms: ['youtube'] }), 'validation', /YouTube is not connected/)
    expectToolError(await c.call('publish_video', { brandId: t.brandId, mediaId: otherMedia.id, caption: 'a' }), 'not_found')
    expectToolError(await c.call('publish_video', { brandId: t.brandId, mediaId: media.id, caption: 'a', when: 'tomorrow' }), 'validation')
    await c.close()
  })
})

describe('render_code_video and autoPublish on renders', () => {
  it('queues the render and says what Auto-post will do', async () => {
    const t = await tenant(h, { platforms: ['tiktok'] })
    const c = await connect(h, t.userId)
    const html = '<!doctype html><html><body><div id="x"></div><script>window.seek = (ms) => { document.getElementById("x").textContent = ms }</script></body></html>'
    const r = await c.call('render_code_video', { brandId: t.brandId, html, durationMs: 4_000, autoPublish: { when: 'best' } })
    const out = expectOk(r)
    expect(out).toMatch(/Rendering a 4 s video/)
    expect(out).toMatch(/Auto-post is off for Acme/)
    expect(structured(r)).toMatchObject({ job: { type: 'code_video_render', status: 'queued' } })
    await turnOn(t.userId, t.brandId)
    const on = await c.call('render_video', { brandId: t.brandId, slides: [{ text: 'Hi' }], autoPublish: {} })
    expect(expectOk(on)).toMatch(/Auto-post is on for Acme/)
    expectToolError(await c.call('render_code_video', { brandId: t.brandId, html, durationMs: 90_000 }), 'validation', /durationMs/)
    expectToolError(await c.call('render_code_video', { brandId: t.brandId, html: 'x'.repeat(300_001), durationMs: 2_000 }), 'validation', /300 KB/)
    expectToolError(await c.call('render_code_video', { brandId: t.brandId, html, durationMs: 2_000, fps: 60 }), 'validation')
    expectToolError(await c.call('render_code_video', { brandId: OTHER_UUID, html, durationMs: 2_000 }), 'not_found')
    await c.close()
  })

  it('list_accounts shows the Auto-post switch read-only', async () => {
    const t = await tenant(h)
    await turnOn(t.userId, t.brandId, { platforms: ['tiktok'], dailyMax: 4 })
    const c = await connect(h, t.userId)
    const r = await c.call('list_accounts', {})
    expect(structured<{ brands: Array<{ autoPost: unknown }> }>(r).brands[0]?.autoPost).toEqual({ enabled: true, platforms: ['tiktok'], dailyMax: 4 })
    await c.close()
  })
})
