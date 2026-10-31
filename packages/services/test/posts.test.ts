import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import { HOUR, DAY, START, approvedDraft, connect, createHarness, expectAppError, image, resetHarness, seedPost, tenant, type Harness } from './helpers'

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

const iso = (ms: number) => new Date(START.getTime() + ms).toISOString()

async function xTenant() {
  const t = await tenant(h)
  const account = await connect(h, t.userId, t.brandId, 'x')
  return { ...t, account }
}

describe('posts.schedule', () => {
  it('creates one post per variant of an approved draft and queues publish jobs at run_at', async () => {
    const t = await tenant(h)
    await connect(h, t.userId, t.brandId, 'x')
    await connect(h, t.userId, t.brandId, 'linkedin')
    const draft = await approvedDraft(h, t.userId, t.brandId, [
      { platform: 'x', text: 'short' },
      { platform: 'linkedin', text: 'longer post' },
    ])
    const posts = await h.s.posts.schedule(t.userId, { draftId: draft.draft.id, at: iso(3 * HOUR) })
    expect(posts.map((p) => p.platform).sort()).toEqual(['linkedin', 'x'])
    expect(posts.every((p) => p.status === 'scheduled' && p.approvedRevision === 1)).toBe(true)
    const jobs = await h.s.jobs.listForUser(t.userId, { type: 'publish_post' })
    expect(jobs).toHaveLength(2)
    expect(jobs.every((j) => j.runAt.toISOString() === iso(3 * HOUR))).toBe(true)

    // only some platforms
    const d2 = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'a' }, { platform: 'linkedin', text: 'b' }])
    const only = await h.s.posts.schedule(t.userId, { draftId: d2.draft.id, at: 'now', platforms: ['linkedin'] })
    expect(only.map((p) => p.platform)).toEqual(['linkedin'])
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: d2.draft.id, at: 'now', platforms: ['tiktok'] }), 'validation', /no TikTok version/)
  })

  it('refuses unapproved drafts, past times and other users’ drafts', async () => {
    const t = await xTenant()
    const view = await h.s.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'x', text: 'not yet' }] })
    const err = await expectAppError(h.s.posts.schedule(t.userId, { draftId: view.draft.id, at: iso(HOUR) }), 'conflict')
    expect(err.details).toMatchObject({ reason: 'not_approved' })
    const approved = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'ok' }])
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: approved.draft.id, at: iso(-HOUR) }), 'validation', /past/)
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: approved.draft.id, at: '2026-11-02 15:00' }), 'validation')
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: approved.draft.id, at: iso(121 * DAY) }), 'validation')
    const other = await xTenant()
    await expectAppError(h.s.posts.schedule(other.userId, { draftId: approved.draft.id, at: iso(HOUR) }), 'not_found')
  })

  it('scheduling the same variant again moves it (no re-approval, audited); one publication per approval', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'move me' }])
    const [first] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) })
    const [moved] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(5 * HOUR) })
    expect(moved?.id).toBe(first?.id)
    expect(moved?.scheduledFor.toISOString()).toBe(iso(5 * HOUR))
    expect(await h.s.audit.list(t.userId, { action: 'post.rescheduled' })).toHaveLength(1)
    // once published, scheduling again is refused
    await h.r.posts.claimForPublish(t.userId, first?.id ?? '')
    await h.r.posts.markPublished(t.userId, first?.id ?? '')
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(6 * HOUR) }), 'conflict', /already published/)
  })

  it('enforces the rolling 24 h cap per account and suggests the next free time', async () => {
    const t = await xTenant() // X: 20 per 24 h
    for (let i = 0; i < 20; i++) await seedPost(h, t.userId, t.brandId, t.account.id, 'x', new Date(START.getTime() + HOUR + i * 60_000))
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'one too many' }])
    const err = await expectAppError(h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(2 * HOUR) }), 'cap_reached', /20 posts/)
    expect(err.details).toMatchObject({ platform: 'x', cap: 20, suggestedAt: iso(HOUR + DAY) })
    // a window that does not overlap is fine
    // the window [at − 24h, at + 24h] around a time 25 h after the burst contains none of them
    const ok = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR + DAY + 20 * 60_000) })
    expect(ok).toHaveLength(1)
    // a post on another platform/account is not affected
    await connect(h, t.userId, t.brandId, 'threads')
    const d2 = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'threads', text: 'other account' }])
    expect(await h.s.posts.schedule(t.userId, { draftId: d2.draft.id, at: iso(2 * HOUR) })).toHaveLength(1)
  })

  it('caps count every window that contains the time (posts after it too)', async () => {
    const t = await xTenant()
    // 20 posts in the 23 hours AFTER the requested time
    for (let i = 0; i < 20; i++) await seedPost(h, t.userId, t.brandId, t.account.id, 'x', new Date(START.getTime() + 2 * HOUR + i * HOUR))
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'before the burst' }])
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) }), 'cap_reached')
  })

  it('needs an active account for every scheduled variant', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'hi' }])
    await h.r.accounts.setStatus(t.userId, t.account.id, 'disconnected')
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) }), 'validation', /Connect your X account/)
  })
})

describe('posts: reschedule, cancel, status, calendar', () => {
  it('reschedule re-checks caps; cancel only before publishing; status by post or draft', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'hi' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) })
    if (!post) throw new Error('post missing')
    const moved = await h.s.posts.reschedule(t.userId, post.id, iso(4 * HOUR))
    expect(moved.scheduledFor.toISOString()).toBe(iso(4 * HOUR))
    expect(await h.s.posts.status(t.userId, { postId: post.id })).toHaveLength(1)
    expect(await h.s.posts.status(t.userId, { draftId: d.draft.id })).toHaveLength(1)
    await expectAppError(h.s.posts.status(t.userId, { postId: post.id, draftId: d.draft.id }), 'validation')

    const cal = await h.s.posts.calendar(t.userId, { from: iso(0), to: iso(DAY) })
    expect(cal).toHaveLength(1)
    expect(cal[0]?.text).toBe('hi')
    await expectAppError(h.s.posts.calendar(t.userId, { from: iso(0), to: iso(100 * DAY) }), 'validation')

    const canceled = await h.s.posts.cancel(t.userId, post.id)
    expect(canceled.status).toBe('canceled')
    await expectAppError(h.s.posts.reschedule(t.userId, post.id, iso(5 * HOUR)), 'conflict')

    const other = await xTenant()
    await expectAppError(h.s.posts.cancel(other.userId, post.id), 'not_found')
    await expectAppError(h.s.posts.status(other.userId, { draftId: d.draft.id }), 'not_found')
    await expectAppError(h.s.posts.get(other.userId, post.id), 'not_found')
  })

  it('a cancel by the person withdraws the approval: the AI cannot schedule it again (review)', async () => {
    const t = await xTenant()
    await connect(h, t.userId, t.brandId, 'linkedin')
    const d = await approvedDraft(h, t.userId, t.brandId, [
      { platform: 'x', text: 'cancel me' },
      { platform: 'linkedin', text: 'keep me' },
    ])
    const posts = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) }, { via: 'mcp' })
    const x = posts.find((p) => p.platform === 'x')
    const canceled = await h.s.posts.cancel(t.userId, x?.id ?? '', { via: 'web' })
    expect(canceled).toMatchObject({ status: 'canceled', canceledBy: 'web' })

    const err = await expectAppError(h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' }, { via: 'mcp' }), 'conflict', /user canceled the X post/)
    expect(err.details).toMatchObject({ reason: 'canceled_by_user', platform: 'x' })
    expect(await h.s.jobs.listForUser(t.userId, { type: 'publish_post' })).toHaveLength(2) // nothing new queued
    // the other variant is untouched and can still be moved by the AI
    expect(await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(2 * HOUR), platforms: ['linkedin'] }, { via: 'mcp' })).toHaveLength(1)
    // the person can schedule it again from the web app
    const again = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(3 * HOUR), platforms: ['x'] }, { via: 'web' })
    expect(again[0]?.status).toBe('scheduled')
  })

  it('after a person cancel, a new approval (reject + approve, or edit + approve) lets the AI schedule again', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'second thoughts' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) })
    await h.s.posts.cancel(t.userId, post?.id ?? '', { via: 'web' })
    await expectAppError(h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) }), 'conflict', /canceled/)
    h.clock.advance(60_000)
    const n1 = await h.s.approvals.issueNonce(t.userId, d.draft.id)
    await h.s.approvals.reject(t.userId, { draftId: d.draft.id, nonce: n1.nonce, reason: 'not today' })
    const n2 = await h.s.approvals.issueNonce(t.userId, d.draft.id)
    await h.s.approvals.approve(t.userId, { draftId: d.draft.id, nonce: n2.nonce })
    expect(await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(2 * HOUR) })).toHaveLength(1)

    // a system cancel (account disconnected) is not a withdrawal
    const d2 = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'system cancel' }])
    const [p2] = await h.s.posts.schedule(t.userId, { draftId: d2.draft.id, at: iso(3 * HOUR) })
    await h.r.posts.cancel(t.userId, p2?.id ?? '', 'The account was disconnected.')
    expect(await h.s.posts.schedule(t.userId, { draftId: d2.draft.id, at: iso(4 * HOUR) })).toHaveLength(1)
  })

  it('a publishing post cannot be canceled', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'hi' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' })
    await h.r.posts.claimForPublish(t.userId, post?.id ?? '')
    await expectAppError(h.s.posts.cancel(t.userId, post?.id ?? ''), 'conflict')
  })
})

describe('posts: the publish cycle (worker)', () => {
  it('preparePublish → provider.publish → recordPublishRequest → recordPublishStatus', async () => {
    const t = await tenant(h)
    await connect(h, t.userId, t.brandId, 'instagram')
    const img = await image(h, t.userId, t.brandId)
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'instagram', text: 'Pic', mediaIds: [img.id] }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) })
    if (!post) throw new Error('post missing')

    // a stale early job is skipped
    expect((await h.s.posts.preparePublish(t.userId, post.id)).action).toBe('skip')
    h.clock.advance(HOUR)
    const plan = await h.s.posts.preparePublish(t.userId, post.id)
    if (plan.action !== 'publish') throw new Error(`expected publish, got ${plan.action}`)
    expect(plan.post.status).toBe('publishing')
    expect(plan.input).toMatchObject({ platform: 'instagram', kind: 'photos', text: 'Pic', idempotencyKey: `post:${post.id}` })
    expect(plan.input.mediaUrls[0]).toContain('/api/dev-storage/')
    // claimed once
    expect((await h.s.posts.preparePublish(t.userId, post.id)).action).toBe('skip')

    const { requestId } = await h.provider.publish(plan.input)
    await h.s.posts.recordPublishRequest(t.userId, post.id, requestId)
    expect(await h.s.jobs.listForUser(t.userId, { type: 'check_post_status' })).toHaveLength(1)

    const pending = await h.s.posts.recordPublishStatus(t.userId, post.id, { state: 'pending' }, { poll: 1 })
    expect(pending.nextPollAt).toBeInstanceOf(Date)
    const status = await h.provider.getStatus(requestId)
    const done = await h.s.posts.recordPublishStatus(t.userId, post.id, status, { poll: 2 })
    expect(done.post).toMatchObject({ status: 'published' })
    expect(done.post.postUrl).toContain('fake-posting.invalid')
    // analytics checkpoints queued (24h, 48h, 7d, 30d)
    expect(await h.s.jobs.listForUser(t.userId, { type: 'analytics_pull' })).toHaveLength(4)
    // replay is harmless
    expect((await h.s.posts.recordPublishStatus(t.userId, post.id, status)).post.status).toBe('published')
    expect(await h.s.posts.findByProviderRequest(requestId)).toHaveLength(1)
  })

  it('a failed publish and a status-poll budget mark the post failed', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'fail me' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' })
    const plan = await h.s.posts.preparePublish(t.userId, post?.id ?? '')
    expect(plan.action).toBe('publish')
    const failed = await h.s.posts.recordPublishStatus(t.userId, post?.id ?? '', { state: 'failed', error: 'Duplicate content' })
    expect(failed.post).toMatchObject({ status: 'failed', error: 'Duplicate content' })

    const d2 = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'slow' }])
    const [p2] = await h.s.posts.schedule(t.userId, { draftId: d2.draft.id, at: 'now' })
    await h.s.posts.preparePublish(t.userId, p2?.id ?? '')
    const timeout = await h.s.posts.recordPublishStatus(t.userId, p2?.id ?? '', { state: 'pending' }, { poll: 60 })
    expect(timeout.post.status).toBe('failed')
  })

  it('retryable provider errors requeue the post; others fail it', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'retry' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' })
    await h.s.posts.preparePublish(t.userId, post?.id ?? '')
    const requeued = await h.s.posts.recordPublishError(t.userId, post?.id ?? '', new AppError('unavailable', 'Provider down'), { retryAfterMs: 60_000 })
    expect(requeued.status).toBe('scheduled')
    expect(requeued.scheduledFor.toISOString()).toBe(iso(60_000))
    h.clock.advance(60_000)
    expect((await h.s.posts.preparePublish(t.userId, post?.id ?? '')).action).toBe('publish')
    const failed = await h.s.posts.recordPublishError(t.userId, post?.id ?? '', new AppError('bad_request', 'Rejected: text'))
    expect(failed).toMatchObject({ status: 'failed', error: 'Rejected: text' })
  })

  it('defers held accounts, moves posts when the cap is full at dispatch, fails disconnected accounts', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'held' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' })
    await h.r.users.updateBilling(t.userId, { subscriptionStatus: 'canceled' })
    const held = await h.s.posts.preparePublish(t.userId, post?.id ?? '')
    expect(held).toMatchObject({ action: 'deferred', reason: 'held' })
    // past_due keeps publishing
    await h.r.users.updateBilling(t.userId, { subscriptionStatus: 'past_due' })

    // fill the cap meanwhile (published posts in the last 24 h)
    for (let i = 0; i < 20; i++) {
      const p = await seedPost(h, t.userId, t.brandId, t.account.id, 'x', new Date(START.getTime() - HOUR + i * 1000))
      await h.r.posts.claimForPublish(t.userId, p.id)
      await h.r.posts.markPublished(t.userId, p.id, { publishedAt: new Date(START.getTime() - HOUR + i * 1000) })
    }
    const capped = await h.s.posts.preparePublish(t.userId, post?.id ?? '')
    expect(capped).toMatchObject({ action: 'deferred', reason: 'cap' })
    expect(capped.post.scheduledFor.toISOString()).toBe(iso(HOUR))

    await h.r.accounts.setStatus(t.userId, t.account.id, 'needs_reauth')
    h.clock.advance(DAY)
    const failed = await h.s.posts.preparePublish(t.userId, post?.id ?? '')
    expect(failed).toMatchObject({ action: 'failed', reason: 'account' })
    expect(failed.post.status).toBe('failed')
  })

  it('enqueueDue re-queues lost publish jobs once; a post whose sweep job died too is failed', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'lost' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) })
    const later = new Date(START.getTime() + 2 * HOUR)
    // its queued job is still live: nothing to do
    expect(await h.s.posts.enqueueDue(later)).toBe(0)
    // the job was lost
    await h.db.query(`delete from public.jobs where payload->>'postId' = $1`, [post?.id])
    expect(await h.s.posts.enqueueDue(later)).toBe(1)
    expect(await h.s.posts.enqueueDue(later)).toBe(0)
    // the sweep job died as well: the post fails instead of being swept forever
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where payload->>'postId' = $1`, [post?.id])
    expect(await h.s.posts.enqueueDue(later)).toBe(0)
    expect(await h.s.posts.get(t.userId, post?.id ?? '')).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not start/) })
  })

  it('held posts (with their next check queued) never fill the sweep batch (review: starvation)', async () => {
    const held = await xTenant()
    for (let i = 0; i < 3; i++) {
      const d = await approvedDraft(h, held.userId, held.brandId, [{ platform: 'x', text: `held ${i}` }])
      const [p] = await h.s.posts.schedule(held.userId, { draftId: d.draft.id, at: 'now' })
      await h.r.users.updateBilling(held.userId, { subscriptionStatus: 'canceled' })
      expect((await h.s.posts.preparePublish(held.userId, p?.id ?? '')).action).toBe('deferred')
      await h.r.users.updateBilling(held.userId, { subscriptionStatus: 'active' })
    }
    await h.r.users.updateBilling(held.userId, { subscriptionStatus: 'canceled' })
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'paying customer' }])
    const [lost] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: iso(HOUR) })
    await h.db.query(`delete from public.jobs where payload->>'postId' = $1`, [lost?.id])
    expect(await h.s.posts.enqueueDue(new Date(START.getTime() + 2 * HOUR), 2)).toBe(1)
    const jobs = await h.s.jobs.listForUser(t.userId, { type: 'publish_post' })
    expect(jobs).toHaveLength(1)
  })

  it('held posts are checked less often the longer they are held, and re-queued at once when billing is back', async () => {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text: 'held long' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' })
    await h.r.users.updateBilling(t.userId, { subscriptionStatus: 'canceled' })
    const first = await h.s.posts.preparePublish(t.userId, post?.id ?? '')
    expect(first).toMatchObject({ action: 'deferred', reason: 'held', until: new Date(START.getTime() + 6 * HOUR) })
    h.clock.advance(10 * DAY)
    expect(await h.s.posts.preparePublish(t.userId, post?.id ?? '')).toMatchObject({ until: new Date(START.getTime() + 15 * DAY) })
    h.clock.advance(30 * DAY)
    expect(await h.s.posts.preparePublish(t.userId, post?.id ?? '')).toMatchObject({ until: new Date(START.getTime() + 47 * DAY) })

    // the user subscribes again: the held post is queued to publish now, not in a week
    await h.r.users.updateBilling(t.userId, { stripeCustomerId: 'cus_back', stripeSubscriptionId: 'sub_back' })
    const now = h.clock.now()
    await h.s.billing.applyStripeEvent({
      id: 'evt_back',
      object: 'event',
      type: 'customer.subscription.updated',
      created: 1,
      data: {
        object: {
          id: 'sub_back',
          customer: 'cus_back',
          status: 'active',
          items: { data: [{ price: { id: 'price_starter', lookup_key: 'starter' }, quantity: 1 }] },
          metadata: {},
        },
      },
    })
    const jobs = await h.s.jobs.listForUser(t.userId, { type: 'publish_post' })
    expect(jobs.some((j) => j.runAt.getTime() === now.getTime())).toBe(true)
    expect((await h.s.posts.preparePublish(t.userId, post?.id ?? '')).action).toBe('publish')
  })
})

describe('posts: interrupted publishes and late confirmations (integration)', () => {
  /** A post claimed for publishing whose publish job then died (worker crash on its last attempt). */
  async function stuckPost(text = 'stuck') {
    const t = await xTenant()
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'x', text }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' })
    if (!post) throw new Error('post missing')
    const plan = await h.s.posts.preparePublish(t.userId, post.id)
    if (plan.action !== 'publish') throw new Error(`expected publish, got ${plan.action}`)
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where payload->>'postId' = $1`, [post.id])
    return { t, post: plan.post, draft: d }
  }

  it('resumePublish rebuilds the input for a publishing post without a request id, same attempt key', async () => {
    const { t, post } = await stuckPost('resume me')
    const plan = await h.s.posts.resumePublish(t.userId, post.id)
    if (plan.action !== 'publish') throw new Error(`expected publish, got ${plan.action}`)
    expect(plan.input).toMatchObject({ platform: 'x', kind: 'text', text: 'resume me', idempotencyKey: `post:${post.id}:${post.attempts}` })
    expect(plan.post.status).toBe('publishing')
    // once the request id is stored there is nothing to resume
    await h.s.posts.recordPublishRequest(t.userId, post.id, 'req-1')
    expect((await h.s.posts.resumePublish(t.userId, post.id)).action).toBe('skip')
    // other users cannot
    const other = await xTenant()
    await expectAppError(h.s.posts.resumePublish(other.userId, post.id), 'not_found')
  })

  it('resumePublish fails the post when the account was disconnected meanwhile', async () => {
    const { t, post } = await stuckPost()
    await h.r.accounts.setStatus(t.userId, t.account.id, 'disconnected')
    const plan = await h.s.posts.resumePublish(t.userId, post.id)
    expect(plan.action).toBe('failed')
    expect((await h.s.posts.get(t.userId, post.id)).status).toBe('failed')
  })

  it('cleanup resumes a stuck publish once, then fails it if the resume job died too', async () => {
    const { t, post } = await stuckPost()
    const first = await h.s.maintenance.cleanup({ now: h.clock.now() })
    expect(first.stuckPublishing).toEqual({ resumed: 1, rechecked: 0, failed: 0 })
    const resume = (await h.s.jobs.listForUser(t.userId, { type: 'publish_post' })).filter((j) => j.status === 'queued')
    expect(resume).toHaveLength(1)
    // a live job: nothing more to do
    expect((await h.s.maintenance.cleanup({ now: h.clock.now() })).stuckPublishing).toEqual({ resumed: 0, rechecked: 0, failed: 0 })
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where payload->>'postId' = $1`, [post.id])
    expect((await h.s.maintenance.cleanup({ now: h.clock.now() })).stuckPublishing).toEqual({ resumed: 0, rechecked: 0, failed: 1 })
    const failed = await h.s.posts.get(t.userId, post.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/interrupted/)
  })

  it('two overlapping cleanups: the second leaves a post alone while the first one\'s resume job is live (review)', async () => {
    const { t, post } = await stuckPost()
    // cleanup A listed the post and queued its resume job before cleanup B looked it up (the
    // job's payload points elsewhere so B's listing still returns the post)
    await h.r.jobs.enqueue({
      type: 'publish_post',
      payload: { userId: t.userId, postId: '00000000-0000-4000-8000-000000000001' },
      userId: t.userId,
      idempotencyKey: `publish_post:${post.id}:resume:${post.attempts}`,
    })
    const res = await h.s.posts.recoverStuckPublishing(h.clock.now())
    expect(res).toEqual({ resumed: 0, rechecked: 0, failed: 0 })
    expect((await h.s.posts.get(t.userId, post.id)).status).toBe('publishing')
  })

  it('cleanup re-checks a stuck post that has a request id (final poll), then fails it', async () => {
    const { t, post } = await stuckPost()
    await h.s.posts.recordPublishRequest(t.userId, post.id, 'req-2')
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where payload->>'postId' = $1`, [post.id])
    expect((await h.s.maintenance.cleanup({ now: h.clock.now() })).stuckPublishing).toEqual({ resumed: 0, rechecked: 1, failed: 0 })
    const checks = (await h.s.jobs.listForUser(t.userId, { type: 'check_post_status' })).filter((j) => j.status === 'queued')
    expect(checks).toHaveLength(1)
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where payload->>'postId' = $1`, [post.id])
    expect((await h.s.maintenance.cleanup({ now: h.clock.now() })).stuckPublishing.failed).toBe(1)
    expect((await h.s.posts.get(t.userId, post.id)).status).toBe('failed')
  })

  it('a late confirmation fills in the post id and URL of a published post without re-running side effects', async () => {
    const t = await tenant(h)
    await connect(h, t.userId, t.brandId, 'linkedin')
    const d = await approvedDraft(h, t.userId, t.brandId, [{ platform: 'linkedin', text: 'late' }])
    const [post] = await h.s.posts.schedule(t.userId, { draftId: d.draft.id, at: 'now' })
    await h.s.posts.preparePublish(t.userId, post?.id ?? '')
    await h.s.posts.recordPublishRequest(t.userId, post?.id ?? '', 'req-3')
    const first = await h.s.posts.recordPublishStatus(t.userId, post?.id ?? '', { state: 'published' })
    expect(first.post).toMatchObject({ status: 'published', providerPostId: null, postUrl: null })
    const publishedAt = first.post.publishedAt
    h.clock.advance(DAY)
    const late = await h.s.posts.recordPublishStatus(t.userId, post?.id ?? '', { state: 'published', postId: '7301', url: 'https://www.linkedin.com/feed/update/7301' })
    expect(late.post).toMatchObject({ status: 'published', providerPostId: '7301', postUrl: 'https://www.linkedin.com/feed/update/7301' })
    expect(late.post.publishedAt?.toISOString()).toBe(publishedAt?.toISOString())
    // never overwritten, analytics checkpoints not queued twice
    const again = await h.s.posts.recordPublishStatus(t.userId, post?.id ?? '', { state: 'published', postId: 'other', url: 'https://x.invalid/other' })
    expect(again.post.providerPostId).toBe('7301')
    expect(await h.s.jobs.listForUser(t.userId, { type: 'analytics_pull' })).toHaveLength(4)
  })
})
