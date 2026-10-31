import { describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import { memoryLogger } from '@app/core/testing'
import {
  isRetryableProviderError,
  providerErrorReason,
  retryAfterSeconds,
  safeProviderMessage,
  safeProviderCode,
} from '../../src/errors'
import { retryAfterFrom, UploadPostClient } from '../../src/upload-post'
import { API_KEY, NOW, catchError, errorText, makeProvider, mockFetch, type MockReply } from '../helpers'

const REF = 'brand_x'

async function errorFor(reply: MockReply | Error) {
  const { provider } = makeProvider([reply])
  return catchError(provider.getProfile(REF))
}

describe('HTTP error mapping', () => {
  const cases: Array<[string, MockReply, string, string, number | undefined]> = [
    ['401', { status: 401, json: { success: false, message: 'Invalid API key' } }, 'provider_auth', 'unavailable', 401],
    ['403', { status: 403, json: { success: false, message: 'TikTok uploads are not available on the Free plan.' } }, 'provider_auth', 'unavailable', 403],
    ['400', { status: 400, json: { success: false, message: 'Username required' } }, 'provider_rejected', 'bad_request', 400],
    ['422', { status: 422, json: { error: 'Unprocessable' } }, 'provider_rejected', 'bad_request', 422],
    ['404', { status: 404, json: { message: 'User not found' } }, 'not_found', 'not_found', 404],
    ['409', { status: 409, json: { message: 'Conflict' } }, 'conflict', 'conflict', 409],
    ['429', { status: 429, json: { message: 'Too many' } }, 'rate_limited', 'rate_limited', 429],
    ['500', { status: 500, json: { error: 'Traceback (most recent call last): db=postgres://u:p@h' } }, 'provider_unavailable', 'unavailable', 500],
    ['502 html', { status: 502, text: '<html>Bad gateway</html>' }, 'provider_unavailable', 'unavailable', 502],
    ['200 non-JSON', { status: 200, text: 'oops' }, 'provider_unavailable', 'unavailable', 200],
    ['200 success:false', { status: 200, json: { success: false, message: 'Profile blocked' } }, 'provider_rejected', 'bad_request', 200],
  ]
  for (const [name, reply, reason, code, status] of cases) {
    it(`${name} → ${reason}`, async () => {
      // getProfile treats 404 as "no profile"; use a call that maps 404 too.
      const { provider } = makeProvider([reply])
      const err = await catchError(provider.listDestinations(REF, 'facebook'))
      expect(err).toBeInstanceOf(AppError)
      expect(providerErrorReason(err)).toBe(reason)
      expect((err as AppError).code).toBe(code)
      expect((err as AppError).details).toMatchObject({ provider: 'upload_post', reason, ...(status ? { status } : {}) })
    })
  }

  it('does not echo 5xx details', async () => {
    const err = await errorFor({ status: 500, json: { error: 'Traceback: postgres://user:pw@db/prod' } })
    expect(err.message).toBe('The posting service is having trouble. Please try again shortly.')
  })

  it('passes a cleaned 4xx message through', async () => {
    const { provider } = makeProvider([{ status: 400, json: { message: 'Invalid platforms: [myspace]' } }])
    const err = await catchError(provider.listDestinations(REF, 'pinterest'))
    expect(err.message).toBe('The posting service rejected the request: Invalid platforms: [myspace]')
  })

  it('network failures and timeouts → provider_unavailable', async () => {
    const a = await errorFor(new TypeError('fetch failed'))
    expect(providerErrorReason(a)).toBe('provider_unavailable')
    expect(a.message).toContain('Could not reach')
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    const b = await errorFor(timeout)
    expect(b.message).toContain('did not answer in time')
    expect(isRetryableProviderError(b)).toBe(true)
  })

  it('429 retryAfter: Retry-After seconds, HTTP date, body retry_after, X-RateLimit-Reset, default 60', async () => {
    const now = Date.parse(NOW)
    const h = (o: Record<string, string>) => new Headers(o)
    expect(retryAfterFrom(h({ 'retry-after': '30' }), {}, now, 60)).toBe(30)
    expect(retryAfterFrom(h({ 'retry-after': new Date(now + 90_000).toUTCString() }), {}, now, 60)).toBe(90)
    expect(retryAfterFrom(h({}), { retry_after: 3600 }, now, 60)).toBe(3600)
    expect(retryAfterFrom(h({ 'x-ratelimit-reset': String(now / 1000 + 45) }), {}, now, 60)).toBe(45)
    expect(retryAfterFrom(h({}), {}, now, 60)).toBe(60)
    expect(retryAfterFrom(h({ 'retry-after': '999999' }), {}, now, 60)).toBe(86_400)

    const err = await errorFor({ status: 429, json: { message: 'slow down' }, headers: { 'retry-after': '12' } })
    expect(err).toMatchObject({ code: 'rate_limited', details: { retryAfterSec: 12 } })
    expect(retryAfterSeconds(err)).toBe(12)
  })

  it('stops sending once X-RateLimit-Remaining hits 0, until the reset', async () => {
    const reset = String(Date.parse(NOW) / 1000 + 20)
    const { provider, calls } = makeProvider([
      { json: { profile: { username: REF } }, headers: { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } },
    ])
    await provider.getProfile(REF)
    const err = await catchError(provider.getProfile(REF))
    expect(err).toMatchObject({ code: 'rate_limited', details: { retryAfterSec: 20 } })
    expect(calls).toHaveLength(1)
    expect(provider.rateLimitState()).toEqual({ remaining: 0, resetAt: new Date(Date.parse(NOW) + 20_000).toISOString() })
  })
})

describe('the API key never leaks', () => {
  const echoes: Array<[string, MockReply | Error]> = [
    ['400 echo', { status: 400, json: { message: `Bad key ${API_KEY}` } }],
    ['401 echo', { status: 401, json: { message: `Invalid API key: ${API_KEY}` } }],
    ['404 echo', { status: 404, json: { message: `Authorization: Apikey ${API_KEY}` } }],
    ['409 echo', { status: 409, json: { message: `dup for ${API_KEY}` } }],
    ['429 violation echo', { status: 429, json: { violations: [{ type: 'hard_cap', message: `cap ${API_KEY}` }] } }],
    ['500 echo', { status: 500, json: { error: `boom ${API_KEY}` } }],
    ['network error echo', new TypeError(`connect ECONNREFUSED Apikey ${API_KEY}`)],
  ]
  for (const [name, reply] of echoes) {
    it(name, async () => {
      const logger = memoryLogger('debug')
      const m = mockFetch([reply])
      const client = new UploadPostClient({ apiKey: API_KEY, fetch: m.fetch, logger, now: () => Date.parse(NOW) })
      const err = await catchError(client.request({ method: 'POST', path: '/api/uploadposts/users', json: { username: REF } }))
      expect(err).toBeInstanceOf(AppError)
      expect(errorText(err)).not.toContain(API_KEY)
      expect(logger.text()).not.toContain(API_KEY)
    })
  }

  it('is sent only in the Authorization header', async () => {
    const m = mockFetch([{ json: {} }])
    const client = new UploadPostClient({ apiKey: API_KEY, fetch: m.fetch })
    await client.request({ method: 'GET', path: '/api/uploadposts/status', query: { request_id: 'r' } })
    expect(m.last().url.toString()).not.toContain(API_KEY)
    expect(m.last().headers.get('authorization')).toBe(`Apikey ${API_KEY}`)
  })

  it('a caller cannot override the Authorization header', async () => {
    const m = mockFetch([{ json: {} }])
    const client = new UploadPostClient({ apiKey: API_KEY, fetch: m.fetch })
    await client.request({ method: 'GET', path: '/api/x', headers: { Authorization: 'Bearer other' } })
    expect(m.last().headers.get('authorization')).toBe(`Apikey ${API_KEY}`)
  })

  it('misconfiguration errors never contain the key', () => {
    expect(() => new UploadPostClient({ apiKey: '  ' })).toThrow(/UPLOAD_POST_API_KEY/)
    let err: unknown
    try {
      new UploadPostClient({ apiKey: API_KEY, baseUrl: `https://${API_KEY}@evil.example` })
    } catch (e) {
      err = e
    }
    expect(errorText(err)).not.toContain(API_KEY)
  })

  it('debug logs carry method, path and status only', async () => {
    const logger = memoryLogger('debug')
    const m = mockFetch([{ json: { ok: true } }])
    const client = new UploadPostClient({ apiKey: API_KEY, fetch: m.fetch, logger })
    await client.request({ method: 'GET', path: '/api/uploadposts/media', query: { user: REF } })
    expect(logger.lines[0]).toMatchObject({ msg: 'upload_post.response', method: 'GET', path: '/api/uploadposts/media', status: 200 })
    expect(logger.text()).not.toContain('Apikey')
  })
})

describe('safeProviderMessage / safeProviderCode', () => {
  it('strips URLs (presigned signatures included), secrets and dashboard directions', () => {
    const raw =
      'Failed to download https://bucket.r2.dev/v.mp4?X-Amz-Signature=abc. Reconnect your TikTok account from Manage Users (https://app.upload-post.com/manage-users). key=sk_live_1234567890abcdef'
    const out = safeProviderMessage(raw, { secrets: ['abc'] })!
    expect(out).not.toContain('http')
    expect(out).not.toContain('X-Amz')
    expect(out).not.toContain('sk_live_1234567890abcdef')
  })

  it('collapses whitespace, truncates and returns null for empty / non-strings', () => {
    expect(safeProviderMessage('  a \n\n b  ')).toBe('a b')
    expect(safeProviderMessage('x'.repeat(1000))!.length).toBeLessThanOrEqual(300)
    expect(safeProviderMessage('   ')).toBeNull()
    expect(safeProviderMessage(42)).toBeNull()
  })

  it('only echoes identifier-like codes', () => {
    expect(safeProviderCode('PROFILE_LIMIT_REACHED')).toBe('PROFILE_LIMIT_REACHED')
    expect(safeProviderCode('has spaces in it')).toBeUndefined()
    expect(safeProviderCode(7)).toBeUndefined()
  })

  it('upload-post rewrite removes the brand and dashboard names', async () => {
    const { provider } = makeProvider([
      { status: 400, json: { message: 'Your TikTok session expired. Reconnect it at Manage Users on app.upload-post.com/manage-users. Upload-Post' } },
    ])
    const err = await catchError(provider.listDestinations(REF, 'facebook'))
    expect(err.message).not.toMatch(/upload-post|manage users/i)
  })

  it('retry helpers ignore foreign errors', () => {
    expect(providerErrorReason(new Error('x'))).toBeUndefined()
    expect(retryAfterSeconds(new Error('x'))).toBeUndefined()
    expect(isRetryableProviderError(new AppError('validation', 'x'))).toBe(false)
  })
})
