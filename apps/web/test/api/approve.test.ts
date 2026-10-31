// The signed-in web approval page (/approve/[nonce]) logic: loading a draft behind a card or
// link nonce, approving and rejecting with { via: 'web' }, and the refusals (another user, used,
// stale, garbage).

import { createTestAccount, createTestBrand } from '@app/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decideApproval, loadApproval, setTikTokPrivacy } from '@/lib/server/approve'
import { createHarness, type Harness } from './harness'

let h: Harness
let owner: { id: string; email: string }
let brandId: string

beforeAll(async () => {
  h = await createHarness()
  owner = await h.createUser('approver@example.com')
  const brand = await createTestBrand(h.db, owner.id)
  brandId = brand.id
  await createTestAccount(h.db, owner.id, brand.id, { platform: 'x' })
  await createTestAccount(h.db, owner.id, brand.id, { platform: 'threads' })
})
afterAll(async () => {
  await h.close()
})

async function draftWithLink(text = 'A short update for today.') {
  const view = await h.rt.services.drafts.create(owner.id, { brandId, variants: [{ platform: 'x', text }, { platform: 'threads', text }] }, { via: 'mcp' })
  // approve_draft issues nonces via MCP; the link nonce sits in approveUrl
  const issued = await h.rt.services.approvals.issueNonce(owner.id, view.draft.id, { via: 'mcp' })
  const link = issued.approveUrl.split('/approve/')[1] as string
  return { draftId: view.draft.id, card: issued.nonce, link }
}

describe('/approve/[nonce]', () => {
  it('loads the per-platform preview for the link nonce without using it', async () => {
    const { draftId, link } = await draftWithLink()
    const state = await loadApproval(h.rt.services, owner.id, link)
    expect(state.kind).toBe('review')
    if (state.kind !== 'review') return
    expect(state.preview.draft.id).toBe(draftId)
    expect(state.preview.variants.map((v) => v.platform).sort()).toEqual(['threads', 'x'])
    expect(state.preview.ready).toBe(true)
    // still usable
    expect((await loadApproval(h.rt.services, owner.id, link)).kind).toBe('review')
  })

  it('approves with the link nonce via the web, once', async () => {
    const { draftId, link } = await draftWithLink()
    const result = await decideApproval(h.rt.services, owner.id, link, 'approve')
    expect(result).toEqual({ ok: true, decision: 'approve', draftId })
    expect((await h.rt.services.drafts.get(owner.id, draftId)).draft.status).toBe('approved')
    const again = await decideApproval(h.rt.services, owner.id, link, 'approve')
    expect(again.ok).toBe(false)
    const state = await loadApproval(h.rt.services, owner.id, link)
    expect(state).toMatchObject({ kind: 'invalid', reason: 'used' })
  })

  it('rejects with a reason (card nonces work on the web too)', async () => {
    const { draftId, card } = await draftWithLink()
    const result = await decideApproval(h.rt.services, owner.id, card, 'reject', '  Wrong tone  ')
    expect(result).toEqual({ ok: true, decision: 'reject', draftId })
    const view = await h.rt.services.drafts.get(owner.id, draftId)
    expect(view.draft.status).toBe('rejected')
    expect(view.draft.rejectedReason).toBe('Wrong tone')
  })

  it("refuses another user's nonce, garbage and stale links", async () => {
    const { link } = await draftWithLink()
    const stranger = await h.createUser('stranger@example.com')
    expect(await loadApproval(h.rt.services, stranger.id, link)).toMatchObject({ kind: 'invalid', reason: 'invalid' })
    expect((await decideApproval(h.rt.services, stranger.id, link, 'approve')).ok).toBe(false)
    expect(await loadApproval(h.rt.services, owner.id, 'short')).toMatchObject({ kind: 'invalid', reason: 'invalid' })
    expect(await loadApproval(h.rt.services, owner.id, '../../etc/passwd-aaaaaaaaaaaaaaaaaaa')).toMatchObject({ kind: 'invalid' })

    // editing the draft after the link was issued makes it stale
    const fresh = await draftWithLink()
    await h.rt.services.drafts.editVariant(owner.id, { draftId: fresh.draftId, platform: 'x', text: 'Edited text.' }, { via: 'web' })
    expect(await loadApproval(h.rt.services, owner.id, fresh.link)).toMatchObject({ kind: 'invalid', reason: 'stale' })
    expect((await decideApproval(h.rt.services, owner.id, fresh.link, 'approve')).ok).toBe(false)
    expect((await h.rt.services.drafts.get(owner.id, fresh.draftId)).draft.status).toBe('draft')
  })

  it('sets TikTok privacy from the page and continues with a fresh nonce (e2e regression)', async () => {
    const brand = await createTestBrand(h.db, owner.id, { name: 'TikTok brand' })
    await createTestAccount(h.db, owner.id, brand.id, { platform: 'tiktok' })
    const media = await h.rt.services.media.createUpload(owner.id, { filename: 'a.jpg', contentType: 'image/jpeg', bytes: 1024, brandId: brand.id }, { purpose: 'post', via: 'web' })
    await h.rt.storage.putBytes(media.media.storageKey, new Uint8Array(1024), 'image/jpeg')
    await h.rt.services.media.completeUpload(owner.id, media.media.id, {}, { via: 'web' })
    const view = await h.rt.services.drafts.create(owner.id, { brandId: brand.id, variants: [{ platform: 'tiktok', text: 'Slides', mediaIds: [media.media.id] }] }, { via: 'worker' })
    const issued = await h.rt.services.approvals.issueNonce(owner.id, view.draft.id, { via: 'mcp' })
    const link = issued.approveUrl.split('/approve/')[1] as string
    expect((await decideApproval(h.rt.services, owner.id, link, 'approve')).ok).toBe(false)

    expect(await setTikTokPrivacy(h.rt.services, owner.id, link, 'NOT_A_LEVEL')).toEqual({ ok: false, message: 'Choose who can see the TikTok post.' })
    const saved = await setTikTokPrivacy(h.rt.services, owner.id, link, 'FOLLOWER_OF_CREATOR')
    if (!saved.ok) throw new Error(saved.message)
    expect(saved.nonce).not.toBe(link)
    // the old link is used up; the new nonce opens the same draft, now approvable
    expect((await loadApproval(h.rt.services, owner.id, link)).kind).toBe('invalid')
    const state = await loadApproval(h.rt.services, owner.id, saved.nonce)
    expect(state.kind === 'review' && state.preview.ready).toBe(true)
    expect(await decideApproval(h.rt.services, owner.id, saved.nonce, 'approve')).toMatchObject({ ok: true, decision: 'approve' })
    const stranger = await h.createUser('privacy-stranger@example.com')
    expect((await setTikTokPrivacy(h.rt.services, stranger.id, saved.nonce, 'SELF_ONLY')).ok).toBe(false)
  })

  it('keeps the nonce when the draft cannot be approved yet', async () => {
    const tiktokBrand = await createTestBrand(h.db, owner.id, { name: 'No accounts' })
    const view = await h.rt.services.drafts.create(owner.id, { brandId: tiktokBrand.id, variants: [{ platform: 'x', text: 'No account here.' }] }, { via: 'mcp' })
    const issued = await h.rt.services.approvals.issueNonce(owner.id, view.draft.id, { via: 'mcp' })
    const link = issued.approveUrl.split('/approve/')[1] as string
    const result = await decideApproval(h.rt.services, owner.id, link, 'approve')
    expect(result.ok).toBe(false)
    expect((await loadApproval(h.rt.services, owner.id, link)).kind).toBe('review')
  })
})
