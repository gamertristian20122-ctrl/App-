import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestUser } from '@app/db/testing'
import { DAY, START, approvedDraft, connect, createHarness, expectAppError, image, resetHarness, tenant, video, type Harness } from './helpers'

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

describe('drafts', () => {
  it('creates a draft with per-platform variants (revision 1, content hash, has_link)', async () => {
    const { userId, brandId } = await tenant(h)
    const img = await image(h, userId, brandId)
    const view = await h.s.drafts.create(userId, {
      brandId,
      variants: [
        { platform: 'instagram', text: 'Look at this', mediaIds: [img.id] },
        { platform: 'linkedin', text: 'Read more at https://example.com' },
      ],
      notes: 'launch',
    })
    expect(view.draft).toMatchObject({ status: 'draft', revision: 1, createdVia: 'mcp', notes: 'launch' })
    expect(view.draft.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(view.variants.map((v) => v.platform)).toEqual(['instagram', 'linkedin'])
    expect(view.variants.find((v) => v.platform === 'linkedin')?.hasLink).toBe(true)
    // no connected accounts yet: not ready
    expect(view.ready).toBe(false)
    expect(view.variants[0]?.issues.some((i) => /Connect your Instagram account/.test(i.message))).toBe(true)
  })

  it('validates against platform rules: X links, text length, YouTube title, media rules', async () => {
    const { userId, brandId } = await tenant(h)
    const xLink = await expectAppError(h.s.drafts.create(userId, { brandId, variants: [{ platform: 'x', text: 'see example.com' }] }), 'validation')
    expect(xLink.message).toMatch(/Links are not supported in X posts/)
    await expectAppError(h.s.drafts.create(userId, { brandId, variants: [{ platform: 'x', text: 'a'.repeat(281) }] }), 'validation', /280/)
    const vid = await video(h, userId, brandId)
    await expectAppError(
      h.s.drafts.create(userId, { brandId, variants: [{ platform: 'youtube', text: 'desc', mediaIds: [vid.id] }] }),
      'validation',
      /title is required/i,
    )
    const img = await image(h, userId, brandId)
    await expectAppError(
      h.s.drafts.create(userId, { brandId, variants: [{ platform: 'x', text: 'mixed', mediaIds: [img.id, vid.id] }] }),
      'validation',
    )
    // a 20-minute video is too long for Instagram
    const long = await video(h, userId, brandId, 20 * 60_000)
    await expectAppError(h.s.drafts.create(userId, { brandId, variants: [{ platform: 'instagram', text: 'x', mediaIds: [long.id] }] }), 'validation', /maximum/)
    await expectAppError(h.s.drafts.create(userId, { brandId, variants: [] }), 'validation')
    await expectAppError(h.s.drafts.create(userId, { brandId, variants: [{ platform: 'x', text: 'a' }, { platform: 'x', text: 'b' }] }), 'validation')
    await expectAppError(h.s.drafts.create(userId, { brandId, variants: [{ platform: 'myspace', text: 'a' }] }), 'validation')
  })

  it('refuses other users’ brands, media, accounts and drafts (not_found)', async () => {
    const a = await tenant(h)
    const b = await tenant(h)
    const bImg = await image(h, b.userId, b.brandId)
    const bAcc = await connect(h, b.userId, b.brandId, 'x')
    await expectAppError(h.s.drafts.create(a.userId, { brandId: b.brandId, variants: [{ platform: 'x', text: 'hi' }] }), 'not_found')
    await expectAppError(h.s.drafts.create(a.userId, { brandId: a.brandId, variants: [{ platform: 'instagram', text: 'hi', mediaIds: [bImg.id] }] }), 'not_found')
    await expectAppError(
      h.s.drafts.create(a.userId, { brandId: a.brandId, variants: [{ platform: 'x', text: 'hi', connectedAccountId: bAcc.id }] }),
      'validation',
      /not connected to this brand/,
    )
    const bDraft = await h.s.drafts.create(b.userId, { brandId: b.brandId, variants: [{ platform: 'x', text: 'secret' }] })
    await expectAppError(h.s.drafts.get(a.userId, bDraft.draft.id), 'not_found')
    await expectAppError(h.s.drafts.editVariant(a.userId, { draftId: bDraft.draft.id, platform: 'x', text: 'pwned' }), 'not_found')
    await expectAppError(h.s.drafts.archive(a.userId, bDraft.draft.id), 'not_found')
    await expectAppError(h.s.drafts.reject(a.userId, { draftId: bDraft.draft.id }), 'not_found')
    await expectAppError(h.s.approvals.issueNonce(a.userId, bDraft.draft.id), 'not_found')
    expect((await h.s.drafts.list(a.userId)).items).toHaveLength(0)
  })

  it('lists newest first with a cursor', async () => {
    const { userId, brandId } = await tenant(h)
    for (let i = 0; i < 5; i++) {
      await h.s.drafts.create(userId, { brandId, variants: [{ platform: 'x', text: `post ${i}` }] })
      await new Promise((r) => setTimeout(r, 3))
    }
    const page1 = await h.s.drafts.list(userId, { limit: 3 })
    expect(page1.items).toHaveLength(3)
    expect(page1.items[0]?.variants[0]?.text).toBe('post 4')
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await h.s.drafts.list(userId, { limit: 3, cursor: page1.nextCursor ?? undefined })
    expect(page2.items.map((d) => d.variants[0]?.text)).toEqual(['post 1', 'post 0'])
    expect(page2.nextCursor).toBeNull()
    await expectAppError(h.s.drafts.list(userId, { cursor: '!!!' }), 'validation')
  })

  it('updateVariant / editVariant bump the revision (DB triggers); notes do not', async () => {
    const { userId, brandId } = await tenant(h)
    const view = await h.s.drafts.create(userId, { brandId, variants: [{ platform: 'x', text: 'one' }] })
    const edited = await h.s.drafts.editVariant(userId, { draftId: view.draft.id, platform: 'x', text: 'two' })
    expect(edited.draft.revision).toBe(2)
    expect(edited.draft.contentHash).not.toBe(view.draft.contentHash)
    const added = await h.s.drafts.updateVariant(userId, { draftId: view.draft.id, variant: { platform: 'threads', text: 'three' } })
    expect(added.draft.revision).toBe(3)
    expect(added.variants.map((v) => v.platform)).toEqual(['threads', 'x'])
    const notes = await h.s.drafts.updateNotes(userId, { draftId: view.draft.id, notes: 'internal' })
    expect(notes.revision).toBe(3)
    await expectAppError(h.s.drafts.editVariant(userId, { draftId: view.draft.id, platform: 'x', text: 'https://evil.example' }), 'validation')
    await expectAppError(h.s.drafts.editVariant(userId, { draftId: view.draft.id, platform: 'bluesky', text: 'x' }), 'not_found')
    const removed = await h.s.drafts.removeVariant(userId, { draftId: view.draft.id, platform: 'threads' })
    expect(removed.variants.map((v) => v.platform)).toEqual(['x'])
  })

  it('preview gives per-platform text length, issues and media URLs', async () => {
    const { userId, brandId } = await tenant(h)
    await connect(h, userId, brandId, 'instagram')
    const img = await image(h, userId, brandId)
    const view = await h.s.drafts.create(userId, { brandId, variants: [{ platform: 'instagram', text: 'Hi #tag', mediaIds: [img.id] }] })
    const preview = await h.s.drafts.preview(userId, view.draft.id)
    expect(preview.brand.name).toBe('Acme')
    expect(preview.ready).toBe(true)
    const v = preview.variants[0]
    expect(v).toMatchObject({ platform: 'instagram', label: 'Instagram', ready: true, length: { used: 7, max: 2200 } })
    expect(v?.media[0]?.url).toContain('/api/dev-storage/')
    expect(v?.account?.status).toBe('active')
  })

  it('reject, archive and reopen', async () => {
    const { userId, brandId } = await tenant(h)
    const view = await h.s.drafts.create(userId, { brandId, variants: [{ platform: 'x', text: 'meh' }] })
    const rejected = await h.s.drafts.reject(userId, { draftId: view.draft.id, reason: 'off brand' })
    expect(rejected).toMatchObject({ status: 'rejected', rejectedReason: 'off brand' })
    // editing a rejected draft puts it back in the queue
    const edited = await h.s.drafts.editVariant(userId, { draftId: view.draft.id, platform: 'x', text: 'better' })
    expect(edited.draft.status).toBe('draft')
    const archived = await h.s.drafts.archive(userId, view.draft.id)
    expect(archived.status).toBe('archived')
    await expectAppError(h.s.drafts.editVariant(userId, { draftId: view.draft.id, platform: 'x', text: 'again' }), 'conflict')
    expect((await h.s.drafts.reopen(userId, view.draft.id)).status).toBe('draft')
  })

  it('canceled accounts cannot create drafts', async () => {
    const user = await createTestUser(h.db, { subscriptionStatus: 'canceled' })
    const brand = await h.r.brands.create(user.id, { name: 'B' })
    await expectAppError(h.s.drafts.create(user.id, { brandId: brand.id, variants: [{ platform: 'x', text: 'hi' }] }), 'payment_required')
  })
})

describe('approvals', () => {
  async function readyDraft() {
    const t = await tenant(h)
    await connect(h, t.userId, t.brandId, 'x')
    const view = await h.s.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'x', text: 'Ship it' }] })
    return { ...t, draftId: view.draft.id }
  }

  it('approves only with a valid one-time nonce', async () => {
    const { userId, draftId } = await readyDraft()
    // no nonce / garbage nonce
    await expectAppError(h.s.approvals.approve(userId, { draftId }), 'validation')
    await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: '' }), 'forbidden')
    await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: 'x'.repeat(43) }), 'forbidden', /not valid/)
    await expectAppError(h.s.drafts.approve(userId, { draftId, nonce: 'y'.repeat(43) }), 'forbidden')
    expect((await h.s.drafts.get(userId, draftId)).draft.status).toBe('draft')

    const issued = await h.s.approvals.issueNonce(userId, draftId)
    expect(issued.approveUrl).toMatch(/^https:\/\/app\.test\/approve\/[A-Za-z0-9_-]{43}$/)
    // the link carries its own nonce, never the card's
    expect(issued.approveUrl).not.toContain(issued.nonce)
    expect(new Date(issued.expiresAt).getTime()).toBe(START.getTime() + DAY)
    expect(await h.s.approvals.verifyNonce(userId, issued.nonce)).toMatchObject({ valid: true, draftId, revision: 1 })
    // only the hashes are stored (card + link)
    const stored = await h.db.query<{ nonce_hash: string; channel: string }>('select nonce_hash, channel from public.approval_nonces')
    expect(stored.map((r) => r.channel).sort()).toEqual(['card', 'link'])
    for (const row of stored) {
      expect(row.nonce_hash).not.toBe(issued.nonce)
      expect(row.nonce_hash).toMatch(/^[0-9a-f]{64}$/)
    }

    const approved = await h.s.approvals.approve(userId, { draftId, nonce: issued.nonce }, { via: 'web' })
    expect(approved.draft).toMatchObject({ status: 'approved', approvedRevision: 1, approvedVia: 'web' })
    const audit = await h.s.audit.list(userId, { action: 'draft.approved' })
    expect(audit).toHaveLength(1)

    // reused nonce → refused
    const reused = await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: issued.nonce }), 'forbidden', /already used/)
    expect(reused.details).toMatchObject({ reason: 'used' })
  })

  it('the plain-text approve link (readable by the AI) never works through MCP; only the signed-in web app accepts it', async () => {
    // regression: approveUrl embedded the card nonce, so an AI shown the link could call the
    // app-only approval_decide tool with it and approve by itself
    const { userId, draftId } = await readyDraft()
    const issued = await h.s.approvals.issueNonce(userId, draftId, { via: 'mcp' })
    const linkNonce = issued.approveUrl.split('/approve/')[1] ?? ''
    expect(linkNonce).toHaveLength(43)

    const viaMcp = await expectAppError(
      h.s.approvals.decide(userId, { draftId, nonce: linkNonce, decision: 'approve' }, { via: 'mcp' }),
      'forbidden',
      /only works in the web app/,
    )
    expect(viaMcp.details).toMatchObject({ reason: 'wrong_channel' })
    await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: linkNonce }, { via: 'mcp' }), 'forbidden')
    await expectAppError(
      h.s.approvals.editVariant(userId, { draftId, nonce: linkNonce, platform: 'x', text: 'AI edit' }, { via: 'mcp' }),
      'forbidden',
    )
    expect((await h.s.approvals.verifyNonce(userId, linkNonce, draftId, { via: 'mcp' })).reason).toBe('wrong_channel')
    // the refused attempts did not use the link up and changed nothing
    expect((await h.s.drafts.get(userId, draftId)).draft).toMatchObject({ status: 'draft', revision: 1 })
    expect(await h.s.approvals.verifyNonce(userId, linkNonce)).toMatchObject({ valid: true, draftId })

    // without an explicit via the most restrictive channel applies (fail closed)
    await expectAppError(h.s.approvals.decide(userId, { draftId, nonce: linkNonce, decision: 'approve' }), 'forbidden', /web app/)
    // workers and system jobs can never approve, whatever nonce they hold
    await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: issued.nonce }, { via: 'worker' }), 'forbidden', /person/)
    await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: issued.nonce }, { via: 'system' }), 'forbidden')

    // the human, signed in on the web, can use the link
    const approved = await h.s.approvals.decide(userId, { draftId, nonce: linkNonce, decision: 'approve' }, { via: 'web' })
    expect(approved.draft).toMatchObject({ status: 'approved', approvedVia: 'web' })
  })

  it('the card nonce works from the card (mcp) and from the web queue', async () => {
    const a = await readyDraft()
    const n = await h.s.approvals.issueNonce(a.userId, a.draftId)
    expect((await h.s.approvals.decide(a.userId, { draftId: a.draftId, nonce: n.nonce, decision: 'approve' }, { via: 'mcp' })).draft.approvedVia).toBe('mcp')
    const b = await readyDraft()
    const m = await h.s.approvals.issueNonce(b.userId, b.draftId, { via: 'web' })
    expect((await h.s.approvals.approve(b.userId, { draftId: b.draftId, nonce: m.nonce }, { via: 'web' })).draft.status).toBe('approved')
  })

  it('refuses expired nonces, other users’ nonces and nonces for another draft', async () => {
    const a = await readyDraft()
    const other = await h.s.drafts.create(a.userId, { brandId: a.brandId, variants: [{ platform: 'x', text: 'Other' }] })
    const n1 = await h.s.approvals.issueNonce(a.userId, a.draftId)
    await expectAppError(h.s.approvals.approve(a.userId, { draftId: other.draft.id, nonce: n1.nonce }), 'forbidden', /another draft/)

    const b = await readyDraft()
    await expectAppError(h.s.approvals.approve(b.userId, { draftId: a.draftId, nonce: n1.nonce }), 'forbidden')
    await expectAppError(h.s.approvals.approve(b.userId, { draftId: b.draftId, nonce: n1.nonce }), 'forbidden')

    const n2 = await h.s.approvals.issueNonce(a.userId, a.draftId)
    h.clock.advance(DAY + 1)
    await expectAppError(h.s.approvals.approve(a.userId, { draftId: a.draftId, nonce: n2.nonce }), 'forbidden', /expired/)
    expect((await h.s.approvals.verifyNonce(a.userId, n2.nonce)).reason).toBe('expired')
  })

  it('a nonce is bound to the revision: an edit makes it stale', async () => {
    const { userId, draftId } = await readyDraft()
    const n = await h.s.approvals.issueNonce(userId, draftId)
    await h.s.drafts.editVariant(userId, { draftId, platform: 'x', text: 'Changed after the card was shown' })
    expect((await h.s.approvals.verifyNonce(userId, n.nonce)).reason).toBe('stale')
    const err = await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: n.nonce }), 'conflict', /changed/)
    expect(err.details).toMatchObject({ reason: 'stale', currentRevision: 2 })
    expect((await h.s.drafts.get(userId, draftId)).draft.status).toBe('draft')
  })

  it('requires every variant to validate for publishing and to have an active account', async () => {
    const t = await tenant(h)
    const vid = await video(h, t.userId, t.brandId)
    const view = await h.s.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'tiktok', text: 'clip', mediaIds: [vid.id] }] })
    const n = await h.s.approvals.issueNonce(t.userId, view.draft.id)
    // no TikTok account
    await expectAppError(h.s.approvals.approve(t.userId, { draftId: view.draft.id, nonce: n.nonce }), 'validation', /cannot be approved/)
    await connect(h, t.userId, t.brandId, 'tiktok')
    // TikTok needs an explicit privacy level before publishing
    const err = await expectAppError(h.s.approvals.approve(t.userId, { draftId: view.draft.id, nonce: n.nonce }), 'validation')
    expect(JSON.stringify(err.details)).toMatch(/privacyLevel/)
    // the failed attempts did not use the nonce up, but fixing the draft changes the revision
    await h.s.drafts.updateVariant(t.userId, {
      draftId: view.draft.id,
      variant: { platform: 'tiktok', text: 'clip', mediaIds: [vid.id], options: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
    })
    await expectAppError(h.s.approvals.approve(t.userId, { draftId: view.draft.id, nonce: n.nonce }), 'conflict')
    const n2 = await h.s.approvals.issueNonce(t.userId, view.draft.id)
    expect((await h.s.approvals.approve(t.userId, { draftId: view.draft.id, nonce: n2.nonce })).draft.status).toBe('approved')
  })

  it('a needs_reauth account blocks approval', async () => {
    const t = await tenant(h)
    const acc = await connect(h, t.userId, t.brandId, 'x')
    await h.r.accounts.setStatus(t.userId, acc.id, 'needs_reauth')
    const view = await h.s.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'x', text: 'hi' }] })
    const n = await h.s.approvals.issueNonce(t.userId, view.draft.id)
    await expectAppError(h.s.approvals.approve(t.userId, { draftId: view.draft.id, nonce: n.nonce }), 'validation', /reconnected/)
  })

  it('decide: reject with a nonce; approval_edit_variant returns a fresh nonce', async () => {
    const { userId, draftId } = await readyDraft()
    const n = await h.s.approvals.issueNonce(userId, draftId)
    const edited = await h.s.approvals.editVariant(userId, { draftId, nonce: n.nonce, platform: 'x', text: 'Edited in the card' })
    expect(edited.draft.draft.revision).toBe(2)
    expect(edited.nonce.revision).toBe(2)
    expect(edited.nonce.nonce).not.toBe(n.nonce)
    // the old card nonce is used up
    await expectAppError(h.s.approvals.approve(userId, { draftId, nonce: n.nonce }), 'forbidden')
    const decided = await h.s.approvals.decide(userId, { draftId, nonce: edited.nonce.nonce, decision: 'approve' })
    expect(decided.draft.status).toBe('approved')

    const other = await readyDraft()
    const n3 = await h.s.approvals.issueNonce(other.userId, other.draftId)
    const rejected = await h.s.approvals.decide(other.userId, { draftId: other.draftId, nonce: n3.nonce, decision: 'reject', reason: 'tone' })
    expect(rejected.draft).toMatchObject({ status: 'rejected', rejectedReason: 'tone' })
    await expectAppError(h.s.approvals.decide(other.userId, { draftId: other.draftId, nonce: n3.nonce, decision: 'reject' }), 'forbidden')
    await expectAppError(h.s.approvals.editVariant(other.userId, { draftId: other.draftId, nonce: 'z'.repeat(43), platform: 'x', text: 'no' }), 'forbidden')
  })

  it('a TikTok draft without privacy can be approved once the person chooses it (e2e: clip drafts were stuck)', async () => {
    const t = await tenant(h)
    await connect(h, t.userId, t.brandId, 'tiktok')
    const clip = await video(h, t.userId, t.brandId)
    // like the drafts the worker makes from clips and renders: no privacyLevel
    const view = await h.s.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'tiktok', text: 'New clip', mediaIds: [clip.id] }] }, { via: 'worker' })
    expect(view.ready).toBe(false)
    const n = await h.s.approvals.issueNonce(t.userId, view.draft.id, { via: 'mcp' })
    await expectAppError(h.s.approvals.approve(t.userId, { draftId: view.draft.id, nonce: n.nonce }), 'validation', /privacyLevel/)

    // only TikTok has this setting, and only known levels
    await expectAppError(
      h.s.approvals.editVariant(t.userId, { draftId: view.draft.id, nonce: n.nonce, platform: 'x', privacyLevel: 'SELF_ONLY' }),
      'validation',
    )
    await expectAppError(
      h.s.approvals.editVariant(t.userId, { draftId: view.draft.id, nonce: n.nonce, platform: 'tiktok', privacyLevel: 'EVERYONE' }),
      'validation',
    )

    const edited = await h.s.approvals.editVariant(
      t.userId,
      { draftId: view.draft.id, nonce: n.nonce, platform: 'tiktok', privacyLevel: 'MUTUAL_FOLLOW_FRIENDS' },
      { via: 'mcp' },
    )
    expect(edited.draft.ready).toBe(true)
    expect(edited.draft.variants[0]?.options).toEqual({ privacyLevel: 'MUTUAL_FOLLOW_FRIENDS' })
    expect(edited.draft.variants[0]?.text).toBe('New clip')
    const decided = await h.s.approvals.decide(t.userId, { draftId: view.draft.id, nonce: edited.nonce.nonce, decision: 'approve' })
    expect(decided.draft.status).toBe('approved')
    const audit = await h.s.audit.list(t.userId, { subjectId: view.draft.id })
    expect(audit.some((a) => (a.meta as { privacyLevel?: string }).privacyLevel === 'MUTUAL_FOLLOW_FRIENDS')).toBe(true)
  })

  it('edit after approval drops the approval; schedule is refused until re-approved', async () => {
    const t = await tenant(h)
    await connect(h, t.userId, t.brandId, 'x')
    const approved = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'v1' }])
    const draftId = approved.draft.id
    const at = new Date(START.getTime() + 2 * 3_600_000).toISOString()
    const posts = await h.s.posts.schedule(t.userId, { draftId, at })
    expect(posts).toHaveLength(1)

    await h.s.drafts.editVariant(t.userId, { draftId, platform: 'x', text: 'v2' })
    const after = await h.s.drafts.get(t.userId, draftId)
    expect(after.draft.status).toBe('draft')
    // the database canceled the scheduled post of the old revision
    expect((await h.s.posts.get(t.userId, posts[0]?.id ?? '')).status).toBe('canceled')
    await expectAppError(h.s.posts.schedule(t.userId, { draftId, at }), 'conflict', /approved/)

    const n = await h.s.approvals.issueNonce(t.userId, draftId)
    await h.s.approvals.approve(t.userId, { draftId, nonce: n.nonce })
    const again = await h.s.posts.schedule(t.userId, { draftId, at })
    expect(again[0]).toMatchObject({ status: 'scheduled', approvedRevision: 2 })
  })
})
