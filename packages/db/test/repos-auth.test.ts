import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as approvalNonces from '../src/repos/approvalNonces'
import * as jobs from '../src/repos/jobs'
import * as maintenance from '../src/repos/maintenance'
import * as oauth from '../src/repos/oauth'
import * as posts from '../src/repos/posts'
import * as stripeEvents from '../src/repos/stripeEvents'
import * as brands from '../src/repos/brands'
import * as media from '../src/repos/media'
import {
  createTestAccount,
  createTestDb,
  createTestDraft,
  createTestScheduledPost,
  createTestSourceVideo,
  createTestUser,
  resetTestDb,
  seedTenant,
} from '../src/testing'
import type { Db } from '../src/types'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

async function newClient() {
  return oauth.createClient(db, {
    clientId: `client-${randomUUID()}`,
    clientName: 'Claude',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect'],
  })
}

describe('oauth repo', () => {
  it('registers clients and records use', async () => {
    const client = await newClient()
    expect(client).toMatchObject({ clientName: 'Claude', tokenEndpointAuthMethod: 'none', lastUsedAt: null })
    expect(client.redirectUris).toHaveLength(2)
    await oauth.touchClient(db, client.clientId)
    expect((await oauth.getClient(db, client.clientId))?.lastUsedAt).toBeInstanceOf(Date)
    expect(await oauth.getClient(db, 'missing-client')).toBeNull()
  })

  it('consumes an authorization code once, and never after it expires', async () => {
    const user = await createTestUser(db)
    const client = await newClient()
    const now = new Date('2026-11-01T00:00:00Z')
    const code = await oauth.createCode(db, {
      codeHash: sha('code-1'),
      clientId: client.clientId,
      userId: user.id,
      redirectUri: client.redirectUris[0]!,
      codeChallenge: CHALLENGE,
      scope: 'social',
      resource: 'https://app.example/api/mcp',
      expiresAt: new Date(now.getTime() + 60_000),
    })
    expect(code.usedAt).toBeNull()
    const used = await oauth.consumeCode(db, sha('code-1'), now)
    expect(used).toMatchObject({ userId: user.id, resource: 'https://app.example/api/mcp', codeChallenge: CHALLENGE })
    expect(await oauth.consumeCode(db, sha('code-1'), now)).toBeNull()
    expect((await oauth.getCode(db, sha('code-1')))?.usedAt).toBeInstanceOf(Date)

    await oauth.createCode(db, { ...code, codeHash: sha('code-2'), expiresAt: new Date(now.getTime() + 60_000) })
    expect(await oauth.consumeCode(db, sha('code-2'), new Date(now.getTime() + 61_000))).toBeNull()
    expect(await oauth.consumeCode(db, sha('unknown'), now)).toBeNull()

    // bound: a wrong client or challenge leaves the code unused; the right one records the family
    await oauth.createCode(db, { ...code, codeHash: sha('code-3'), expiresAt: new Date(now.getTime() + 60_000) })
    const familyId = '7b8d3b5e-3f4c-4a7e-9a0b-1c2d3e4f5a6b'
    expect(await oauth.consumeCode(db, sha('code-3'), now, { clientId: 'mcp_other', codeChallenge: CHALLENGE, familyId })).toBeNull()
    expect(await oauth.consumeCode(db, sha('code-3'), now, { clientId: client.clientId, codeChallenge: 'x'.repeat(43), familyId })).toBeNull()
    expect((await oauth.getCode(db, sha('code-3')))?.usedAt).toBeNull()
    const bound = await oauth.consumeCode(db, sha('code-3'), now, { clientId: client.clientId, codeChallenge: CHALLENGE, familyId })
    expect(bound).toMatchObject({ familyId })
  })

  it('finds active tokens by hash and refuses revoked or expired ones', async () => {
    const user = await createTestUser(db)
    const client = await newClient()
    const now = new Date('2026-11-01T00:00:00Z')
    const family = randomUUID()
    const access = await oauth.createToken(db, {
      tokenHash: sha(`a-${family}`),
      kind: 'access',
      familyId: family,
      clientId: client.clientId,
      userId: user.id,
      scope: 'social',
      resource: 'https://app.example/api/mcp',
      expiresAt: new Date(now.getTime() + 3_600_000),
    })
    const found = await oauth.findActiveToken(db, access.tokenHash, 'access', now)
    expect(found).toMatchObject({ id: access.id, userId: user.id })
    expect(found?.lastUsedAt?.toISOString()).toBe(now.toISOString())
    expect(await oauth.findActiveToken(db, access.tokenHash, 'refresh', now)).toBeNull()
    expect(await oauth.findActiveToken(db, access.tokenHash, 'access', new Date(now.getTime() + 3_600_001))).toBeNull()
    expect(await oauth.revokeToken(db, access.tokenHash)).toBe(true)
    expect(await oauth.revokeToken(db, access.tokenHash)).toBe(false)
    expect(await oauth.findActiveToken(db, access.tokenHash, 'access', now)).toBeNull()
    expect((await oauth.findTokenByHash(db, access.tokenHash))?.revokedAt).toBeInstanceOf(Date)
  })

  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const user = await createTestUser(db)
    const client = await newClient()
    const family = randomUUID()
    const base = { familyId: family, clientId: client.clientId, userId: user.id, scope: 'social', expiresAt: new Date(Date.now() + 86_400_000) }
    const refresh1 = await oauth.createToken(db, { ...base, kind: 'refresh', tokenHash: sha(`r1-${family}`) })
    await oauth.createToken(db, { ...base, kind: 'access', tokenHash: sha(`a1-${family}`) })

    const use1 = await oauth.useRefreshToken(db, refresh1.tokenHash)
    expect(use1.status).toBe('ok')
    // the caller issues the next pair in the same family
    const refresh2 = await oauth.createToken(db, { ...base, kind: 'refresh', tokenHash: sha(`r2-${family}`) })
    const access2 = await oauth.createToken(db, { ...base, kind: 'access', tokenHash: sha(`a2-${family}`) })
    expect((await oauth.listActiveForUser(db, user.id)).length).toBe(3) // a1 (still valid), r2, a2

    // the old refresh token shows up again: reuse -> family revoked
    const reuse = await oauth.useRefreshToken(db, refresh1.tokenHash)
    expect(reuse).toEqual({ status: 'reused', familyId: family, userId: user.id })
    expect(await oauth.findActiveToken(db, refresh2.tokenHash, 'refresh')).toBeNull()
    expect(await oauth.findActiveToken(db, access2.tokenHash, 'access')).toBeNull()
    expect(await oauth.listActiveForUser(db, user.id)).toEqual([])

    expect(await oauth.useRefreshToken(db, sha('never-issued'))).toEqual({ status: 'invalid' })
    // an access token is not a refresh token
    const other = randomUUID()
    const a = await oauth.createToken(db, { ...base, familyId: other, kind: 'access', tokenHash: sha(`x-${other}`) })
    expect(await oauth.useRefreshToken(db, a.tokenHash)).toEqual({ status: 'invalid' })
    expect(await oauth.revokeAllForUser(db, user.id)).toBe(1)
    expect(await oauth.revokeFamily(db, other)).toBe(0)
  })
})

describe('approval nonces repo', () => {
  it('consumes a nonce once, only for its user, only before it expires', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    const now = new Date('2026-11-01T00:00:00Z')
    const nonce = await approvalNonces.create(db, user.id, {
      nonceHash: sha(`n-${draft.id}`),
      draftId: draft.id,
      revision: draft.revision,
      expiresAt: new Date(now.getTime() + 15 * 60_000),
    })
    expect(nonce).toMatchObject({ draftId: draft.id, revision: 1, usedAt: null })
    expect((await approvalNonces.findByHash(db, nonce.nonceHash))?.userId).toBe(user.id)
    const other = await createTestUser(db)
    expect(await approvalNonces.get(db, other.id, nonce.nonceHash)).toBeNull()
    expect(await approvalNonces.consume(db, other.id, nonce.nonceHash, now)).toBeNull()
    expect(await approvalNonces.consume(db, user.id, nonce.nonceHash, new Date(now.getTime() + 16 * 60_000))).toBeNull()
    const used = await approvalNonces.consume(db, user.id, nonce.nonceHash, now)
    expect(used?.usedAt?.toISOString()).toBe(now.toISOString())
    expect(await approvalNonces.consume(db, user.id, nonce.nonceHash, now)).toBeNull()
    expect((await approvalNonces.get(db, user.id, nonce.nonceHash))?.usedAt).toBeInstanceOf(Date)
  })

  it('binds a nonce to its channel: a link nonce is not consumed when only card nonces are allowed', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    const now = new Date('2026-11-01T00:00:00Z')
    const expiresAt = new Date(now.getTime() + 15 * 60_000)
    const card = await approvalNonces.create(db, user.id, { nonceHash: sha(`card-${draft.id}`), draftId: draft.id, revision: 1, expiresAt })
    const link = await approvalNonces.create(db, user.id, {
      nonceHash: sha(`link-${draft.id}`),
      draftId: draft.id,
      revision: 1,
      expiresAt,
      channel: 'link',
    })
    expect(card.channel).toBe('card')
    expect(link.channel).toBe('link')
    expect(await approvalNonces.consume(db, user.id, link.nonceHash, now, ['card'])).toBeNull()
    expect((await approvalNonces.get(db, user.id, link.nonceHash))?.usedAt).toBeNull()
    expect((await approvalNonces.consume(db, user.id, link.nonceHash, now, ['card', 'link']))?.channel).toBe('link')
    expect((await approvalNonces.consume(db, user.id, card.nonceHash, now, ['card']))?.channel).toBe('card')
    await expect(
      db.query(`update public.approval_nonces set channel = 'email' where nonce_hash = $1`, [card.nonceHash]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('stripe events repo', () => {
  it('records each event once and processes it once', async () => {
    const id = `evt_${randomUUID().replace(/-/g, '')}`
    const first = await stripeEvents.record(db, { id, type: 'invoice.paid' })
    expect(first).toMatchObject({ created: true, event: { id, type: 'invoice.paid', processedAt: null } })
    const second = await stripeEvents.record(db, { id, type: 'invoice.paid' })
    expect(second.created).toBe(false)
    const locked = await db.tx((tx) => stripeEvents.lockUnprocessed(tx, id))
    expect(locked?.id).toBe(id)
    expect(await stripeEvents.markProcessed(db, id)).toBe(true)
    expect(await stripeEvents.markProcessed(db, id)).toBe(false)
    expect(await db.tx((tx) => stripeEvents.lockUnprocessed(tx, id))).toBeNull()
    expect((await stripeEvents.record(db, { id, type: 'invoice.paid' })).event.processedAt).toBeInstanceOf(Date)
    expect(await stripeEvents.get(db, 'evt_missing')).toBeNull()
  })
})

describe('maintenance (system-wide)', () => {
  it('cleans expired nonces, codes, tokens and finished jobs; lists stale sources, due posts and analytics targets', async () => {
    await resetTestDb(db)
    const tenant = await seedTenant(db)
    const { user, brand } = tenant
    await brands.setProviderProfileRef(db, user.id, brand.id, `ref-${brand.id}`)
    await createTestAccount(db, user.id, brand.id, { platform: 'tiktok' })
    const client = await newClient()
    const past = new Date(Date.now() - 86_400_000)
    const future = new Date(Date.now() + 86_400_000)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    await approvalNonces.create(db, user.id, { nonceHash: sha('old'), draftId: draft.id, revision: 1, expiresAt: past })
    await approvalNonces.create(db, user.id, { nonceHash: sha('new'), draftId: draft.id, revision: 1, expiresAt: future })
    const codeBase = { clientId: client.clientId, userId: user.id, redirectUri: 'https://claude.ai/cb', codeChallenge: CHALLENGE, scope: 'social' }
    await oauth.createCode(db, { ...codeBase, codeHash: sha('c-old'), expiresAt: past })
    await oauth.createCode(db, { ...codeBase, codeHash: sha('c-new'), expiresAt: future })
    const tokBase = { kind: 'access' as const, familyId: randomUUID(), clientId: client.clientId, userId: user.id, scope: 'social' }
    await oauth.createToken(db, { ...tokBase, tokenHash: sha('t-old'), expiresAt: past })
    await oauth.createToken(db, { ...tokBase, tokenHash: sha('t-new'), expiresAt: future })
    const { job } = await jobs.enqueue(db, { type: 'cleanup' })
    await jobs.claim(db, { types: ['cleanup'], workerId: 'w', leaseSec: 30 })
    await jobs.complete(db, job.id, 'w')
    await jobs.enqueue(db, { type: 'cleanup' })

    const now = new Date()
    expect(await maintenance.deleteExpiredApprovalNonces(db, now)).toBe(1)
    expect(await maintenance.deleteExpiredOAuthCodes(db, now)).toBe(1)
    expect(await maintenance.deleteExpiredOAuthTokens(db, now)).toBe(1)
    expect(await maintenance.pruneFinishedJobs(db, new Date(Date.now() + 1000))).toBe(1)
    expect(await maintenance.deleteExpiredApprovalNonces(db, now)).toBe(0)

    const oldSource = await createTestSourceVideo(db, user.id)
    await db.query(`update public.media_assets set created_at = now() - interval '40 days' where id = $1`, [oldSource.id])
    const deletedSource = await createTestSourceVideo(db, user.id)
    await db.query(`update public.media_assets set created_at = now() - interval '40 days' where id = $1`, [deletedSource.id])
    await media.update(db, user.id, deletedSource.id, { status: 'deleted' })
    await createTestSourceVideo(db, user.id)
    const stale = await maintenance.listStaleSourceMedia(db, new Date(Date.now() - 30 * 86_400_000))
    expect(stale.map((m) => m.id)).toEqual([oldSource.id])

    const due = await createTestScheduledPost(db, tenant, { scheduledFor: new Date(Date.now() - 60_000) })
    await createTestScheduledPost(db, tenant, { scheduledFor: future })
    expect((await maintenance.listDuePosts(db, new Date())).map((p) => p.id)).toEqual([due.post.id])
    await posts.claimForPublish(db, user.id, due.post.id)
    const publishedAt = new Date(Date.now() - 3_600_000)
    await posts.markPublished(db, user.id, due.post.id, { publishedAt })
    expect((await maintenance.listPublishedBetween(db, new Date(publishedAt.getTime() - 1), new Date())).map((p) => p.id)).toEqual([due.post.id])

    const targets = await maintenance.listBrandsForAnalytics(db)
    expect(targets).toEqual([{ userId: user.id, brandId: brand.id, providerProfileRef: `ref-${brand.id}`, platforms: ['tiktok', 'instagram'] }])
  })
})
