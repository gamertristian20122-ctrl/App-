import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { APPROVAL_META_KEY } from '../src'
import {
  BASE_URL,
  connect,
  createHarness,
  expectOk,
  expectToolError,
  image,
  resetHarness,
  structured,
  tenant,
  text,
  type Harness,
} from './helpers'

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

interface CardMeta {
  nonce: string
  expiresAt: string
  revision: number
  webUrl: string
  preview: { draft: { id: string; revision: number }; variants: Array<{ platform: string; media: Array<{ url: string | null }>; length: { used: number; max: number } }> }
}

function cardMeta(result: CallToolResult): CardMeta {
  const meta = result._meta?.[APPROVAL_META_KEY] as CardMeta | undefined
  expect(meta, 'approval card _meta').toBeDefined()
  return meta as CardMeta
}

/** Everything the model can see: content and structuredContent (not _meta). */
function modelVisible(result: CallToolResult): string {
  return JSON.stringify({ content: result.content, structuredContent: result.structuredContent })
}

async function draftWithImage(userId: string, brandId: string) {
  const img = await image(h, userId, brandId)
  const view = await h.services.drafts.create(userId, {
    brandId,
    variants: [
      { platform: 'instagram', text: 'Launch day! Our new collection is here.', mediaIds: [img.id] },
      { platform: 'linkedin', text: 'We are launching our new collection today.' },
    ],
  })
  return { view, img }
}

describe('approve_draft', () => {
  it('opens the card with a UI-only nonce and never shows it (or media URLs) to the model', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['instagram', 'linkedin'] })
    const { view } = await draftWithImage(userId, brandId)
    const c = await connect(h, userId)
    const result = await c.call('approve_draft', { draftId: view.draft.id })
    const t = expectOk(result)
    const meta = cardMeta(result)
    expect(meta.nonce).toMatch(/^[A-Za-z0-9_-]{22,}$/)
    expect(meta.preview.draft.id).toBe(view.draft.id)
    expect(meta.preview.variants.map((v) => v.platform)).toEqual(['instagram', 'linkedin'])
    const mediaUrl = meta.preview.variants[0]?.media[0]?.url
    expect(mediaUrl).toMatch(/^http/)

    const visible = modelVisible(result)
    expect(visible).not.toContain(meta.nonce)
    expect(visible).not.toContain(mediaUrl as string)
    expect(visible).not.toMatch(/\/approve\//) // no one-click link nonce either
    const webUrl = `${BASE_URL}/app/approvals?draft=${view.draft.id}`
    expect(t).toContain(webUrl)
    expect(structured(result)).toMatchObject({ draftId: view.draft.id, approvalUrl: webUrl, ready: true, status: 'draft' })
    expect(meta.webUrl).toBe(webUrl)
    expect(t).toMatch(/schedule_post/)
    expect(t).toMatch(/Instagram: \d+\/2200/)
    await c.close()
  })

  it('refuses other users\' drafts and bad ids', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    const view = await h.services.drafts.create(userId, { brandId, variants: [{ platform: 'linkedin', text: 'Mine' }] })
    const other = await tenant(h)
    const o = await connect(h, other.userId)
    const result = await o.call('approve_draft', { draftId: view.draft.id })
    expectToolError(result, 'not_found')
    expect(result._meta?.[APPROVAL_META_KEY]).toBeUndefined()
    expectToolError(await o.call('approve_draft', { draftId: 'abc' }), 'validation', /draftId/)
    expectToolError(await o.call('approve_draft', {}), 'validation', /draftId/)
    await o.close()
  })
})

describe('approval_decide', () => {
  it('approves only with the card nonce, once', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    const view = await h.services.drafts.create(userId, { brandId, variants: [{ platform: 'linkedin', text: 'Ship it' }] })
    const c = await connect(h, userId)
    const draftId = view.draft.id

    // the model cannot approve without the card: no nonce, a made-up nonce, the readable web link nonce
    expectToolError(await c.call('approval_decide', { draftId, decision: 'approve' }), 'validation', /nonce/)
    expectToolError(await c.call('approval_decide', { draftId, nonce: 'x'.repeat(43), decision: 'approve' }), 'forbidden', /not valid/)
    const issued = await h.services.approvals.issueNonce(userId, draftId, { via: 'mcp' })
    const linkNonce = issued.approveUrl.split('/approve/')[1] as string
    expectToolError(await c.call('approval_decide', { draftId, nonce: linkNonce, decision: 'approve' }), 'forbidden', /web app/)
    expect((await h.services.drafts.get(userId, draftId)).draft.status).toBe('draft')

    const card = await c.call('approve_draft', { draftId })
    const nonce = cardMeta(card).nonce
    const other = await tenant(h)
    const o = await connect(h, other.userId)
    expectToolError(await o.call('approval_decide', { draftId, nonce, decision: 'approve' }), 'forbidden')
    await o.close()

    const approved = await c.call('approval_decide', { draftId, nonce, decision: 'approve' })
    const t = expectOk(approved)
    expect(structured(approved)).toMatchObject({ decision: 'approve', draftId, status: 'approved' })
    expect(t).toMatch(/not published yet: call schedule_post/)
    expect(modelVisible(approved)).not.toContain(nonce)

    expectToolError(await c.call('approval_decide', { draftId, nonce, decision: 'approve' }), 'forbidden', /already used/)
    expectOk(await c.call('schedule_post', { draftId, at: 'now' }))
    await c.close()
  })

  it('rejects with a reason', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    const view = await h.services.drafts.create(userId, { brandId, variants: [{ platform: 'linkedin', text: 'Meh' }] })
    const c = await connect(h, userId)
    const nonce = cardMeta(await c.call('approve_draft', { draftId: view.draft.id })).nonce
    const rejected = await c.call('approval_decide', { draftId: view.draft.id, nonce, decision: 'reject', reason: 'Too vague' })
    expect(expectOk(rejected)).toContain('Too vague')
    expect(structured(rejected)).toMatchObject({ decision: 'reject', status: 'rejected' })
    expectToolError(await c.call('approval_decide', { draftId: view.draft.id, nonce, decision: 'maybe' }), 'validation', /decision/)
    await c.close()
  })

  it('refuses approval when the draft is not ready (the nonce stays usable)', async () => {
    const { userId, brandId } = await tenant(h, { platforms: [] })
    const view = await h.services.drafts.create(userId, { brandId, variants: [{ platform: 'linkedin', text: 'No account yet' }] })
    const c = await connect(h, userId)
    const card = await c.call('approve_draft', { draftId: view.draft.id })
    expect(structured(card)).toMatchObject({ ready: false })
    expect(text(card)).toMatch(/LinkedIn: .*not ready: Connect your LinkedIn account/)
    const nonce = cardMeta(card).nonce
    expectToolError(await c.call('approval_decide', { draftId: view.draft.id, nonce, decision: 'approve' }), 'validation', /Connect your LinkedIn account/)
    expectOk(await c.call('approval_decide', { draftId: view.draft.id, nonce, decision: 'reject' }))
    await c.close()
  })
})

describe('approval_edit_variant', () => {
  it('edits with the nonce, returns a fresh nonce for the new revision, and the old one stops working', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin', 'x'] })
    const view = await h.services.drafts.create(userId, {
      brandId,
      variants: [
        { platform: 'linkedin', text: 'First version' },
        { platform: 'x', text: 'First version' },
      ],
    })
    const draftId = view.draft.id
    const c = await connect(h, userId)
    const first = cardMeta(await c.call('approve_draft', { draftId }))

    expectToolError(await c.call('approval_edit_variant', { draftId, platform: 'x', text: 'New' }), 'validation', /nonce/)
    expectToolError(await c.call('approval_edit_variant', { draftId, nonce: first.nonce, platform: 'x' }), 'validation', /Change the text, the title or who can see/)
    expectToolError(
      await c.call('approval_edit_variant', { draftId, nonce: first.nonce, platform: 'x', text: 'y'.repeat(290) }),
      'validation',
      /280/,
    )

    const edited = await c.call('approval_edit_variant', { draftId, nonce: first.nonce, platform: 'x', text: 'Second version' })
    expect(expectOk(edited)).toMatch(/still needs their approval/)
    const next = cardMeta(edited)
    expect(next.nonce).not.toBe(first.nonce)
    expect(next.revision).toBe(first.revision + 1)
    expect(next.preview.draft.revision).toBe(first.revision + 1)
    expect(modelVisible(edited)).not.toContain(next.nonce)
    expect((await h.services.drafts.get(userId, draftId)).variants.find((v) => v.platform === 'x')?.text).toBe('Second version')

    expectToolError(await c.call('approval_decide', { draftId, nonce: first.nonce, decision: 'approve' }), 'forbidden')
    expectOk(await c.call('approval_decide', { draftId, nonce: next.nonce, decision: 'approve' }))
    expect((await h.services.drafts.get(userId, draftId)).draft).toMatchObject({ status: 'approved', revision: next.revision })

    const other = await tenant(h)
    const o = await connect(h, other.userId)
    expectToolError(await o.call('approval_edit_variant', { draftId, nonce: next.nonce, platform: 'x', text: 'hijack' }), 'forbidden')
    await o.close()
    await c.close()
  })
})
