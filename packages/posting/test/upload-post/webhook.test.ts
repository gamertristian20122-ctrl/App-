import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import {
  headerValue,
  parseUploadPostWebhook,
  parseUploadPostWebhookPayload,
  signUploadPostWebhook,
  verifyUploadPostSignature,
} from '../../src/upload-post'
import { webhookSecrets } from '../../src'
import { catchError } from '../helpers'

const SECRET = 'whsec_3f9a0123456789abcdef'
const NOW = new Date('2026-10-31T12:00:00Z')
const TS = String(Math.floor(NOW.getTime() / 1000))

const uploadCompleted = {
  event: 'upload_completed',
  request_id: 'upr_instagram_0123456789abcdef0123456789abcdef',
  job_id: 'a1b2c3',
  external_id: 'post:123',
  user_email: 'owner@example.com',
  profile_username: 'brand_abc',
  platform: 'instagram',
  media_type: 'video',
  title: 'My Awesome Video',
  caption: 'Check this out!',
  result: { success: true, url: 'https://www.instagram.com/p/C123/', publish_id: '1798', post_id: '1798', error: null },
  created_at: '2024-03-15T14:30:00.000000',
}

function signed(body: string, secret = SECRET, ts = TS) {
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  return { 'X-Upload-Post-Signature': `sha256=${sig}`, 'X-Upload-Post-Timestamp': ts, 'X-Upload-Post-Delivery': 'dlv_1', 'X-Upload-Post-Event': 'upload_completed' }
}

function expectThrows(fn: () => unknown, code: string, message?: RegExp) {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(AppError)
  expect((err as AppError).code).toBe(code)
  if (message) expect((err as AppError).message).toMatch(message)
}

describe('verifyUploadPostSignature', () => {
  const body = JSON.stringify(uploadCompleted)

  it('accepts HMAC-SHA256(secret, "<ts>.<raw body>") from a plain header record (any case)', () => {
    expect(() => verifyUploadPostSignature({ rawBody: body, headers: signed(body), secrets: SECRET, now: NOW })).not.toThrow()
  })

  it('accepts Headers objects and Uint8Array bodies', () => {
    const headers = new Headers(signed(body))
    expect(() => verifyUploadPostSignature({ rawBody: new TextEncoder().encode(body), headers, secrets: [SECRET], now: NOW })).not.toThrow()
  })

  it('accepts the previous secret during rotation', () => {
    expect(() =>
      verifyUploadPostSignature({ rawBody: body, headers: signed(body, 'whsec_old'), secrets: ['whsec_new', 'whsec_old'], now: NOW }),
    ).not.toThrow()
  })

  it('rejects a wrong secret, a tampered body and a re-serialised body', () => {
    expectThrows(() => verifyUploadPostSignature({ rawBody: body, headers: signed(body, 'whsec_wrong'), secrets: SECRET, now: NOW }), 'unauthorized')
    expectThrows(() => verifyUploadPostSignature({ rawBody: body.replace('true', 'false'), headers: signed(body), secrets: SECRET, now: NOW }), 'unauthorized')
    const pretty = JSON.stringify(uploadCompleted, null, 2)
    expectThrows(() => verifyUploadPostSignature({ rawBody: pretty, headers: signed(body), secrets: SECRET, now: NOW }), 'unauthorized')
  })

  it('rejects missing or malformed headers', () => {
    expectThrows(() => verifyUploadPostSignature({ rawBody: body, headers: {}, secrets: SECRET, now: NOW }), 'unauthorized', /Missing/)
    const h = signed(body)
    expectThrows(
      () => verifyUploadPostSignature({ rawBody: body, headers: { ...h, 'X-Upload-Post-Signature': 'md5=abc' }, secrets: SECRET, now: NOW }),
      'unauthorized',
    )
    expectThrows(
      () => verifyUploadPostSignature({ rawBody: body, headers: { ...h, 'X-Upload-Post-Timestamp': 'yesterday' }, secrets: SECRET, now: NOW }),
      'unauthorized',
    )
  })

  it('rejects stale and far-future timestamps (5 minute window)', () => {
    const old = String(Number(TS) - 301)
    expectThrows(() => verifyUploadPostSignature({ rawBody: body, headers: signed(body, SECRET, old), secrets: SECRET, now: NOW }), 'unauthorized', /window/)
    const future = String(Number(TS) + 301)
    expectThrows(() => verifyUploadPostSignature({ rawBody: body, headers: signed(body, SECRET, future), secrets: SECRET, now: NOW }), 'unauthorized')
    const edge = String(Number(TS) - 300)
    expect(() => verifyUploadPostSignature({ rawBody: body, headers: signed(body, SECRET, edge), secrets: SECRET, now: NOW })).not.toThrow()
  })

  it('refuses to run without a secret, and refuses huge bodies', () => {
    expectThrows(() => verifyUploadPostSignature({ rawBody: body, headers: signed(body), secrets: [], now: NOW }), 'unavailable')
    expectThrows(() => verifyUploadPostSignature({ rawBody: body, headers: signed(body), secrets: '', now: NOW }), 'unavailable')
    const huge = 'x'.repeat(1_000_001)
    expectThrows(() => verifyUploadPostSignature({ rawBody: huge, headers: signed(huge), secrets: SECRET, now: NOW }), 'bad_request')
  })

  it('signUploadPostWebhook produces headers that verify', () => {
    const headers = signUploadPostWebhook(body, SECRET, NOW)
    expect(() => verifyUploadPostSignature({ rawBody: body, headers, secrets: SECRET, now: NOW })).not.toThrow()
  })
})

describe('parseUploadPostWebhook', () => {
  it('upload_completed (success) → published status, ids, our external id, delivery id; no email', () => {
    const body = JSON.stringify(uploadCompleted)
    const event = parseUploadPostWebhook({ rawBody: body, headers: signed(body), secrets: SECRET, now: NOW })
    expect(event).toEqual({
      type: 'upload_completed',
      deliveryId: 'dlv_1',
      providerPlatform: 'instagram',
      platform: 'instagram',
      profileRef: 'brand_abc',
      createdAt: '2024-03-15T14:30:00.000000',
      requestId: 'upr_instagram_0123456789abcdef0123456789abcdef',
      jobId: 'a1b2c3',
      externalId: 'post:123',
      status: { state: 'published', postId: '1798', url: 'https://www.instagram.com/p/C123/' },
    })
    expect(JSON.stringify(event)).not.toContain('owner@example.com')
  })

  it('upload_completed (failure) → failed with a cleaned message', () => {
    const event = parseUploadPostWebhookPayload({
      ...uploadCompleted,
      platform: 'linkedin',
      result: { success: false, error: 'Expired token, see https://app.upload-post.com/manage-users', url: null },
    })
    expect(event).toMatchObject({ type: 'upload_completed', platform: 'linkedin', status: { state: 'failed', error: 'Expired token' } })
  })

  it('upload_completed for a platform we do not support keeps platform null', () => {
    const event = parseUploadPostWebhookPayload({ ...uploadCompleted, platform: 'reddit' })
    expect(event).toMatchObject({ type: 'upload_completed', platform: null, providerPlatform: 'reddit' })
  })

  it('account events (underscore and dotted names) → account_status', () => {
    expect(
      parseUploadPostWebhookPayload({
        event: 'social_account_reauth_required',
        user_email: 'owner@example.com',
        platform: 'youtube',
        account_name: 'UCxxxx',
        status: 'reauth_required',
        reason: 'token_refresh_threshold_exceeded',
        created_at: '2024-03-15T14:30:00.000000',
      }),
    ).toEqual({
      type: 'account_status',
      event: 'reauth_required',
      accountStatus: 'needs_reauth',
      deliveryId: null,
      providerPlatform: 'youtube',
      platform: 'youtube',
      profileRef: null,
      createdAt: '2024-03-15T14:30:00.000000',
      accountName: 'UCxxxx',
      reason: 'token_refresh_threshold_exceeded',
    })
    expect(parseUploadPostWebhookPayload({ event: 'social_account.connected', platform: 'twitter', profile_username: 'brand_abc' })).toMatchObject({
      type: 'account_status',
      event: 'connected',
      accountStatus: 'active',
      platform: 'x',
      profileRef: 'brand_abc',
    })
    expect(parseUploadPostWebhookPayload({ event: 'social_account_disconnected', platform: 'tiktok', reason: 'manual_disconnect' })).toMatchObject({
      accountStatus: 'disconnected',
    })
  })

  it('unknown events are ignored (answer 2xx, do nothing)', () => {
    expect(parseUploadPostWebhookPayload({ event: 'comment_received', comment: { text: 'hi' } }, 'd1')).toEqual({
      type: 'ignored',
      deliveryId: 'd1',
      event: 'comment_received',
    })
  })

  it('rejects malformed payloads with bad_request', () => {
    expectThrows(() => parseUploadPostWebhookPayload(null), 'bad_request')
    expectThrows(() => parseUploadPostWebhookPayload({ nope: 1 }), 'bad_request')
    expectThrows(() => parseUploadPostWebhookPayload({ event: 'upload_completed', platform: 'x' }), 'bad_request')
    expectThrows(() => parseUploadPostWebhookPayload({ event: 'social_account_connected' }), 'bad_request')
    const body = 'not json'
    expectThrows(() => parseUploadPostWebhook({ rawBody: body, headers: signed(body), secrets: SECRET, now: NOW }), 'bad_request')
  })

  it('drops unsafe ids and delivery ids', () => {
    const event = parseUploadPostWebhookPayload({ ...uploadCompleted, profile_username: '../../etc', request_id: 'has space' })
    expect(event).toMatchObject({ profileRef: null, requestId: null })
    const body = JSON.stringify(uploadCompleted)
    const parsed = parseUploadPostWebhook({ rawBody: body, headers: { ...signed(body), 'X-Upload-Post-Delivery': 'bad id!' }, secrets: SECRET, now: NOW })
    expect(parsed.deliveryId).toBeNull()
  })

  it('never verifies after parsing: a bad signature fails before JSON parsing', async () => {
    const err = await catchError(
      Promise.resolve().then(() => parseUploadPostWebhook({ rawBody: 'not json', headers: signed('other'), secrets: SECRET, now: NOW })),
    )
    expect(err).toMatchObject({ code: 'unauthorized' })
  })
})

describe('helpers', () => {
  it('headerValue is case-insensitive and takes the first array value', () => {
    expect(headerValue({ 'X-A': 'b' }, 'x-a')).toBe('b')
    expect(headerValue({ 'x-a': ['1', '2'] }, 'X-A')).toBe('1')
    expect(headerValue(new Headers({ 'X-A': 'c' }), 'x-a')).toBe('c')
    expect(headerValue({}, 'x-a')).toBeUndefined()
  })

  it('webhookSecrets splits "current,previous"', () => {
    expect(webhookSecrets(' a , b ,')).toEqual(['a', 'b'])
    expect(webhookSecrets(undefined)).toEqual([])
  })
})
