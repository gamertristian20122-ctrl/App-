// Upload-Post webhooks (signature verification, publish result, account status) and the Vercel
// cron routes (CRON_SECRET bearer → jobs enqueued, idempotent per window).

import { signUploadPostWebhook } from '@app/posting'
import { createTestAccount, createTestBrand, createTestUser } from '@app/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as cronAnalytics } from '@/app/api/cron/analytics/route'
import { GET as cronCleanup, POST as cronCleanupPost } from '@/app/api/cron/cleanup/route'
import { POST as uploadPostWebhook } from '@/app/api/webhooks/upload-post/route'
import { resetUploadPostDeliveriesForTests } from '@/lib/server/upload-post-webhook'
import { CRON_SECRET, UPLOAD_POST_SECRET, createHarness, readJson, request, type Harness } from './harness'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.close()
})
beforeEach(() => {
  resetUploadPostDeliveriesForTests()
  h.install()
})

function delivery(payload: unknown, opts: { secret?: string; delivery?: string; at?: Date } = {}) {
  const raw = JSON.stringify(payload)
  const headers = signUploadPostWebhook(raw, opts.secret ?? UPLOAD_POST_SECRET, opts.at ?? h.clock.now())
  return request('/api/webhooks/upload-post', {
    body: raw,
    headers: { 'content-type': 'application/json', ...headers, ...(opts.delivery ? { 'x-upload-post-delivery': opts.delivery } : {}) },
  })
}

/** A user with a brand (provider profile) and an active X account, plus an approved draft posted "now" and submitted. */
async function publishingPost() {
  const user = await createTestUser(h.db)
  const brand = await createTestBrand(h.db, user.id, { providerProfileRef: `fake_brand_${crypto.randomUUID().slice(0, 8)}` })
  const account = await createTestAccount(h.db, user.id, brand.id, { platform: 'x' })
  const s = h.rt.services
  const view = await s.drafts.create(user.id, { brandId: brand.id, variants: [{ platform: 'x', text: 'Shipping the new release today.' }] }, { via: 'web' })
  const issued = await s.approvals.issueNonce(user.id, view.draft.id, { via: 'web' })
  await s.approvals.approve(user.id, { draftId: view.draft.id, nonce: issued.nonce }, { via: 'web' })
  const [post] = await s.posts.schedule(user.id, { draftId: view.draft.id, at: 'now' }, { via: 'web' })
  if (!post) throw new Error('no post')
  const plan = await s.posts.preparePublish(user.id, post.id)
  expect(plan.action).toBe('publish')
  const requestId = `fake_x_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  await s.posts.recordPublishRequest(user.id, post.id, requestId)
  return { user, brand, account, post, requestId }
}

describe('POST /api/webhooks/upload-post', () => {
  it('rejects unsigned, mis-signed and stale deliveries', async () => {
    const payload = { event: 'social_account_connected', platform: 'x', profile_username: 'fake_brand_x' }
    let res = await uploadPostWebhook(request('/api/webhooks/upload-post', { json: payload }))
    expect(res.status).toBe(401)
    res = await uploadPostWebhook(delivery(payload, { secret: 'wrong-secret' }))
    expect(res.status).toBe(401)
    res = await uploadPostWebhook(delivery(payload, { at: new Date(h.clock.now().getTime() - 3_600_000) }))
    expect(res.status).toBe(401)
  })

  it('is 503 without a configured secret', async () => {
    h.install({ runtime: { ...h.rt, config: { ...h.rt.config, UPLOAD_POST_WEBHOOK_SECRET: undefined } } })
    const res = await uploadPostWebhook(delivery({ event: 'upload_completed' }))
    expect(res.status).toBe(503)
  })

  it('applies an account status change to the owning brand', async () => {
    const user = await createTestUser(h.db)
    const brand = await createTestBrand(h.db, user.id, { providerProfileRef: 'fake_brand_status1' })
    const account = await createTestAccount(h.db, user.id, brand.id, { platform: 'tiktok' })
    const res = await uploadPostWebhook(
      delivery({ event: 'social_account_reauth_required', platform: 'tiktok', profile_username: 'fake_brand_status1', account_name: 'creator' }, { delivery: 'dlv-1' }),
    )
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ received: true, type: 'account_status', applied: 1 })
    expect((await h.rt.services.accounts.get(user.id, account.id)).status).toBe('needs_reauth')
    // the same delivery again is ignored
    const again = await uploadPostWebhook(
      delivery({ event: 'social_account_reauth_required', platform: 'tiktok', profile_username: 'fake_brand_status1' }, { delivery: 'dlv-1' }),
    )
    expect(await readJson(again)).toMatchObject({ type: 'duplicate', applied: 0 })
  })

  it('marks a publishing post published from upload_completed', async () => {
    const { user, post, requestId } = await publishingPost()
    const res = await uploadPostWebhook(
      delivery({
        event: 'upload_completed',
        request_id: requestId,
        platform: 'x',
        result: { platform: 'x', success: true, status: 'completed', post_url: 'https://x.com/acct/status/123', platform_post_id: '123' },
      }),
    )
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ type: 'upload_completed', applied: 1 })
    const updated = await h.rt.services.posts.get(user.id, post.id)
    expect(updated).toMatchObject({ status: 'published', providerPostId: '123', postUrl: 'https://x.com/acct/status/123' })
  })

  it('acknowledges unknown requests and events without applying anything', async () => {
    let res = await uploadPostWebhook(
      delivery({ event: 'upload_completed', request_id: 'unknown_request', platform: 'x', result: { platform: 'x', success: false, status: 'failed', message: 'nope' } }),
    )
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ applied: 0 })
    res = await uploadPostWebhook(delivery({ event: 'comment_received', platform: 'x' }))
    expect(await readJson(res)).toMatchObject({ type: 'ignored' })
    res = await uploadPostWebhook(delivery({ nope: true }))
    expect(res.status).toBe(400)
  })
})

describe('cron routes', () => {
  const cronReq = (path: string, auth?: string) => request(path, { ...(auth ? { headers: { authorization: auth } } : {}) })

  it('require the CRON_SECRET bearer', async () => {
    for (const handler of [cronAnalytics, cronCleanup]) {
      expect((await handler(cronReq('/api/cron/x'))).status).toBe(401)
      expect((await handler(cronReq('/api/cron/x', 'Bearer wrong-secret-value'))).status).toBe(401)
      expect((await handler(cronReq('/api/cron/x', CRON_SECRET))).status).toBe(401)
    }
    h.install({ runtime: { ...h.rt, config: { ...h.rt.config, CRON_SECRET: undefined } } })
    expect((await cronCleanup(cronReq('/api/cron/cleanup', `Bearer ${CRON_SECRET}`))).status).toBe(503)
  })

  it('cleanup enqueues one cleanup job per hour', async () => {
    const first = await cronCleanup(cronReq('/api/cron/cleanup', `Bearer ${CRON_SECRET}`))
    expect(first.status).toBe(200)
    const a = await readJson<{ enqueued: number; jobId: string }>(first)
    expect(a.enqueued).toBe(1)
    const second = await readJson<{ enqueued: number; jobId: string }>(await cronCleanupPost(cronReq('/api/cron/cleanup', `Bearer ${CRON_SECRET}`)))
    expect(second).toMatchObject({ enqueued: 0, jobId: a.jobId })
    const rows = await h.db.query<{ type: string; status: string }>("select type, status from public.jobs where id = $1", [a.jobId])
    expect(rows[0]).toMatchObject({ type: 'cleanup', status: 'queued' })
  })

  it('analytics enqueues daily account pulls per active brand, once per day', async () => {
    const user = await createTestUser(h.db)
    const brand = await createTestBrand(h.db, user.id, { providerProfileRef: 'fake_brand_analytics' })
    await createTestAccount(h.db, user.id, brand.id, { platform: 'instagram' })
    const res = await cronAnalytics(cronReq('/api/cron/analytics', `Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(200)
    const body = await readJson<{ enqueued: number }>(res)
    expect(body.enqueued).toBeGreaterThanOrEqual(1)
    const jobs = await h.db.query<{ n: number }>(
      "select count(*)::int as n from public.jobs where type = 'analytics_pull' and payload->>'brandId' = $1",
      [brand.id],
    )
    expect(jobs[0]?.n).toBe(1)
    const again = await readJson<{ enqueued: number }>(await cronAnalytics(cronReq('/api/cron/analytics', `Bearer ${CRON_SECRET}`)))
    expect(again.enqueued).toBe(0)
  })
})
