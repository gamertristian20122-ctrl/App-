import { describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import type { PublishInput } from '@app/core/ports'
import { fixedClock } from '@app/core/testing'
import { FakePostingProvider } from '../src/fake'
import { providerError, providerErrorReason } from '../src/errors'

const NOW = '2026-10-31T12:00:00.000Z'
const BRAND = '11111111-2222-3333-4444-555555555555'
const REF = `fake_brand_${BRAND}`

function make(options: ConstructorParameters<typeof FakePostingProvider>[0] = {}) {
  return new FakePostingProvider({ clock: fixedClock(NOW), ...options })
}

function post(over: Partial<PublishInput> = {}): PublishInput {
  return {
    profileRef: REF,
    platform: 'x',
    kind: 'text',
    text: 'Hello',
    mediaUrls: [],
    options: {},
    idempotencyKey: 'post:1',
    ...over,
  }
}

describe('FakePostingProvider: profiles and accounts', () => {
  it('ensureProfile is deterministic and keeps a given profileRef', async () => {
    const p = make()
    expect(p.name).toBe('fake')
    expect(await p.ensureProfile({ brandId: BRAND, displayName: 'Acme' })).toEqual({ profileRef: REF })
    expect(await p.ensureProfile({ brandId: BRAND, displayName: 'Acme' })).toEqual({ profileRef: REF })
    expect(await p.ensureProfile({ brandId: BRAND, profileRef: 'custom_1', displayName: 'Acme' })).toEqual({ profileRef: 'custom_1' })
    expect(p.hasProfile(REF)).toBe(true)
  })

  it('createConnectLink auto-connects requested platforms and redirects back with connect_status', async () => {
    const p = make()
    const link = await p.createConnectLink({ profileRef: REF, platforms: ['tiktok', 'instagram'], redirectUrl: 'http://localhost:3000/app/accounts?x=1' })
    expect(link.expiresAt).toBe('2026-11-02T12:00:00.000Z')
    const url = new URL(link.url)
    expect(url.origin + url.pathname).toBe('http://localhost:3000/app/accounts')
    expect(Object.fromEntries(url.searchParams)).toEqual({ x: '1', connect_status: 'success', platform: 'tiktok', fake: '1' })
    const accounts = await p.listAccounts(REF)
    expect(accounts.map((a) => a.platform)).toEqual(['tiktok', 'instagram'])
    expect(accounts[0]).toMatchObject({ status: 'active', handle: `${REF}_tiktok` })
    expect(accounts[0]!.externalId).toMatch(/^fake-tiktok-[0-9a-f]{12}$/)
  })

  it('without autoConnect nothing is connected until connectAccount()', async () => {
    const p = make({ autoConnect: false })
    const link = await p.createConnectLink({ profileRef: REF, platforms: ['x'] })
    expect(link.url).toBe(`https://fake-posting.invalid/connect/${REF}?platforms=x`)
    expect(await p.listAccounts(REF)).toEqual([])
    p.connectAccount(REF, 'x', { handle: 'acme' })
    expect(await p.listAccounts(REF)).toMatchObject([{ platform: 'x', handle: 'acme', status: 'active' }])
  })

  it('disconnect, setAccountStatus and deleteProfile', async () => {
    const p = make()
    p.connectAccount(REF, 'x')
    p.connectAccount(REF, 'bluesky')
    p.setAccountStatus(REF, 'bluesky', 'needs_reauth')
    expect((await p.listAccounts(REF)).map((a) => `${a.platform}:${a.status}`)).toEqual(['x:active', 'bluesky:needs_reauth'])
    await p.disconnect({ profileRef: REF, platform: 'x' })
    expect((await p.listAccounts(REF)).map((a) => a.platform)).toEqual(['bluesky'])
    await p.deleteProfile(REF)
    expect(p.hasProfile(REF)).toBe(false)
    expect(await p.listAccounts(REF)).toEqual([])
  })

  it('refuses unsafe redirect URLs', async () => {
    const p = make()
    await expect(p.createConnectLink({ profileRef: REF, platforms: ['x'], redirectUrl: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'validation' })
    await expect(p.createConnectLink({ profileRef: REF, platforms: ['x'], redirectUrl: 'http://evil.example/' })).rejects.toMatchObject({ code: 'validation' })
  })

  it('listAccounts returns copies', async () => {
    const p = make()
    p.connectAccount(REF, 'x')
    const [a] = await p.listAccounts(REF)
    a!.status = 'disconnected'
    expect((await p.listAccounts(REF))[0]!.status).toBe('active')
  })

  it('validates input like the real adapter', async () => {
    const p = make()
    await expect(p.ensureProfile({ brandId: 'a/b', displayName: 'x' })).rejects.toMatchObject({ code: 'validation' })
    await expect(p.disconnect({ profileRef: REF, platform: 'myspace' as never })).rejects.toMatchObject({ code: 'validation' })
    await expect(p.listAccounts('bad ref')).rejects.toMatchObject({ code: 'validation' })
  })
})

describe('FakePostingProvider: publish and status', () => {
  it('publish returns a request id; the next getStatus publishes with a fake URL', async () => {
    const p = make()
    const { requestId } = await p.publish(post())
    expect(requestId).toMatch(/^fake_x_[0-9a-f]{24}$/)
    const status = await p.getStatus(requestId)
    expect(status.state).toBe('published')
    expect(status.postId).toMatch(/^fake-post-[0-9a-f]{16}$/)
    expect(status.url).toBe(`https://fake-posting.invalid/x/posts/${status.postId}`)
    expect(await p.getStatus(requestId)).toEqual(status)
    expect(p.uploads.get(requestId)).toMatchObject({ platform: 'x', text: 'Hello', publishedAt: NOW })
  })

  it('is idempotent per (platform, idempotencyKey)', async () => {
    const p = make()
    const a = await p.publish(post())
    const b = await p.publish(post({ text: 'changed' }))
    const c = await p.publish(post({ idempotencyKey: 'post:2' }))
    expect(b).toEqual(a)
    expect(c).not.toEqual(a)
    expect(p.uploads.size).toBe(2)
  })

  it('delayStatus keeps uploads pending for N polls (globally or per upload)', async () => {
    const p = make({ statusDelay: 2 })
    const { requestId } = await p.publish(post())
    expect((await p.getStatus(requestId)).state).toBe('pending')
    expect((await p.getStatus(requestId)).state).toBe('pending')
    expect((await p.getStatus(requestId)).state).toBe('published')

    p.delayStatus(0)
    const second = await p.publish(post({ idempotencyKey: 'post:2' }))
    p.delayStatus(1, second.requestId)
    expect((await p.getStatus(second.requestId)).state).toBe('pending')
    expect((await p.getStatus(second.requestId)).state).toBe('published')
  })

  it('failNextPublish throws once (default provider_unavailable, or a given error)', async () => {
    const p = make()
    p.failNextPublish()
    const err = await p.publish(post()).catch((e: unknown) => e)
    expect(providerErrorReason(err)).toBe('provider_unavailable')
    expect((err as AppError).retryable).toBe(true)
    await expect(p.publish(post())).resolves.toHaveProperty('requestId')

    p.failNextPublish(providerError('rate_limited', 'Slow down', { provider: 'fake', retryAfterSec: 30 }))
    await expect(p.publish(post({ idempotencyKey: 'post:3' }))).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterSec: 30 } })
  })

  it('failNext works for any method and queues', async () => {
    const p = make()
    p.failNext('listAccounts').failNext('listAccounts', new AppError('not_found', 'gone'))
    await expect(p.listAccounts(REF)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(p.listAccounts(REF)).rejects.toMatchObject({ code: 'not_found' })
    await expect(p.listAccounts(REF)).resolves.toEqual([])
  })

  it('failNextUpload / failUpload make the status fail', async () => {
    const p = make()
    p.failNextUpload('Instagram rejected the media.')
    const a = await p.publish(post())
    expect(await p.getStatus(a.requestId)).toEqual({ state: 'failed', error: 'Instagram rejected the media.' })
    const b = await p.publish(post({ idempotencyKey: 'post:2' }))
    p.failUpload(b.requestId)
    expect((await p.getStatus(b.requestId)).state).toBe('failed')
    const c = await p.publish(post({ idempotencyKey: 'post:3' }))
    expect((await p.getStatus(c.requestId)).state).toBe('published')
  })

  it('strictAccounts rejects platforms that are not connected', async () => {
    const p = make({ strictAccounts: true })
    await expect(p.publish(post())).rejects.toMatchObject({ code: 'bad_request', details: { reason: 'provider_rejected' } })
    p.connectAccount(REF, 'x')
    await expect(p.publish(post())).resolves.toHaveProperty('requestId')
  })

  it('validates publish input (kind/platform fit, options) and accepts http media for local storage', async () => {
    const p = make()
    await expect(p.publish(post({ platform: 'tiktok' }))).rejects.toMatchObject({ code: 'validation' })
    await expect(p.publish(post({ options: { nope: true } }))).rejects.toMatchObject({ code: 'validation' })
    await expect(p.publish(post({ kind: 'video', mediaUrls: ['ftp://x/y.mp4'] }))).rejects.toMatchObject({ code: 'validation' })
    await expect(p.publish(post({ kind: 'video', mediaUrls: ['http://localhost:3000/media/v.mp4'] }))).resolves.toHaveProperty('requestId')
  })

  it('resolves fake request ids from another process as published; unknown ids are not_found', async () => {
    const p = make()
    const other = make()
    const { requestId } = await other.publish(post())
    expect((await p.getStatus(requestId)).state).toBe('published')
    expect(await p.getStatus(requestId)).toEqual(await other.getStatus(requestId))
    await expect(p.getStatus('upr_x_123')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('records calls in order', async () => {
    const p = make()
    await p.ensureProfile({ brandId: BRAND, displayName: 'A' })
    await p.listAccounts(REF)
    expect(p.calls.map((c) => c.method)).toEqual(['ensureProfile', 'listAccounts'])
    p.reset()
    expect(p.calls).toEqual([])
    expect(p.hasProfile(REF)).toBe(false)
  })
})

describe('FakePostingProvider: analytics and past posts', () => {
  it('post metrics are deterministic or scripted', async () => {
    const p = make()
    const a = await p.getPostMetrics({ requestId: 'fake_x_1', platform: 'x', profileRef: REF })
    const b = await p.getPostMetrics({ requestId: 'fake_x_1', platform: 'x', profileRef: REF })
    expect(a).toEqual(b)
    expect(a.views).toBeGreaterThanOrEqual(100)
    p.setPostMetrics('pp-1', { views: 7, likes: 1 })
    expect(await p.getPostMetrics({ platformPostId: 'pp-1', platform: 'x', profileRef: REF })).toEqual({ views: 7, likes: 1 })
    await expect(p.getPostMetrics({ platform: 'x', profileRef: REF })).rejects.toMatchObject({ code: 'validation' })
  })

  it('account metrics per platform, deterministic or scripted', async () => {
    const p = make()
    p.setAccountMetrics(REF, 'tiktok', { followers: 3 })
    const out = await p.getAccountMetrics({ profileRef: REF, platforms: ['tiktok', 'x', 'x'] })
    expect(out.map((r) => r.platform)).toEqual(['tiktok', 'x'])
    expect(out[0]!.metrics).toEqual({ followers: 3 })
    expect(out[1]!.metrics.followers).toBeGreaterThanOrEqual(50)
    expect(await p.getAccountMetrics({ profileRef: REF, platforms: ['x'] })).toEqual([out[1]])
  })

  it('past posts page with a cursor', async () => {
    const p = make({ pastPostsPerPlatform: 5 })
    const first = await p.listPastPosts({ profileRef: REF, platform: 'instagram', limit: 2 })
    expect(first.posts).toHaveLength(2)
    expect(first.nextCursor).toBe('o:2')
    expect(first.posts[0]).toMatchObject({ platform: 'instagram', postedAt: '2026-10-30T12:00:00.000Z' })
    const second = await p.listPastPosts({ profileRef: REF, platform: 'instagram', limit: 2, cursor: first.nextCursor })
    const third = await p.listPastPosts({ profileRef: REF, platform: 'instagram', limit: 2, cursor: second.nextCursor })
    expect(third.posts).toHaveLength(1)
    expect(third.nextCursor).toBeUndefined()
    const ids = [...first.posts, ...second.posts, ...third.posts].map((x) => x.externalPostId)
    expect(new Set(ids).size).toBe(5)
    await expect(p.listPastPosts({ profileRef: REF, platform: 'instagram', cursor: 'garbage' })).rejects.toMatchObject({ code: 'validation' })
  })

  it('scripted past posts', async () => {
    const p = make()
    p.setPastPosts(REF, 'x', [
      { platform: 'x', externalPostId: '1', text: 'a', mediaType: 'TEXT', postedAt: NOW, permalink: null, metrics: {} },
    ])
    expect(await p.listPastPosts({ profileRef: REF, platform: 'x' })).toEqual({
      posts: [{ platform: 'x', externalPostId: '1', text: 'a', mediaType: 'TEXT', postedAt: NOW, permalink: null, metrics: {} }],
    })
  })
})

describe('connectAll (serverless test deployments)', () => {
  it('reports every platform connected, with the same ids in separate instances', async () => {
    const a = new FakePostingProvider({ connectAll: true })
    const b = new FakePostingProvider({ connectAll: true })
    const fromA = await a.listAccounts('fake_brand_one')
    const fromB = await b.listAccounts('fake_brand_one')
    expect(fromA).toHaveLength(9)
    expect(fromA.every((acc) => acc.status === 'active')).toBe(true)
    expect(fromB).toEqual(fromA)
  })

  it('is off by default', async () => {
    expect(await new FakePostingProvider().listAccounts('fake_brand_one')).toEqual([])
  })
})
