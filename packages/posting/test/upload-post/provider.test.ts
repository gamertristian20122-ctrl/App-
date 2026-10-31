import { describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import { providerErrorReason } from '../../src/errors'
import { accountsFromSocialAccounts, parseDurationMs, profileRefForBrand, toIsoTimestamp, UploadPostProvider } from '../../src/upload-post'
import { API_KEY, BASE, NOW, catchError, makeProvider } from '../helpers'

const BRAND = '11111111-2222-3333-4444-555555555555'
const REF = `brand_${BRAND}`

function expectAuth(req: { headers: Headers }) {
  expect(req.headers.get('authorization')).toBe(`Apikey ${API_KEY}`)
  expect(req.headers.get('accept')).toBe('application/json')
}

describe('constructor', () => {
  it('requires an API key and names the field, never the value', () => {
    expect(() => new UploadPostProvider({ apiKey: '' })).toThrow(/apiKey/)
    const err = (() => {
      try {
        new UploadPostProvider({ apiKey: API_KEY, baseUrl: 'not a url' })
      } catch (e) {
        return e as Error
      }
      return null
    })()
    expect(err).toBeInstanceOf(AppError)
    expect(err?.message).toContain('baseUrl')
    expect(err?.message).not.toContain(API_KEY)
  })

  it('has name upload_post and uses the default base URL', async () => {
    const { provider, last } = makeProvider([{ json: { profile: { username: REF, social_accounts: {} } } }])
    expect(provider.name).toBe('upload_post')
    await provider.getProfile(REF)
    expect(last().url.origin).toBe(BASE)
  })

  it('honours a custom base URL', async () => {
    const { provider, last } = makeProvider([{ json: { profile: { username: REF } } }], { baseUrl: 'https://proxy.test/up/' })
    await provider.getProfile(REF)
    expect(last().url.toString()).toBe(`https://proxy.test/up/api/uploadposts/users/${REF}`)
  })
})

describe('ensureProfile', () => {
  it('creates brand_<brandId> with POST /api/uploadposts/users', async () => {
    const { provider, calls } = makeProvider([{ status: 201, json: { success: true, profile: { username: REF } } }])
    const out = await provider.ensureProfile({ brandId: BRAND, displayName: '  Acme\nCorp  ' })
    expect(out).toEqual({ profileRef: REF })
    expect(calls).toHaveLength(1)
    const req = calls[0]!
    expect(req.method).toBe('POST')
    expect(req.url.toString()).toBe(`${BASE}/api/uploadposts/users`)
    expect(req.headers.get('content-type')).toBe('application/json')
    expectAuth(req)
    expect(req.json).toEqual({ username: REF, display_name: 'Acme Corp' })
  })

  it('treats 409 (already exists) as success', async () => {
    const { provider } = makeProvider([{ status: 409, json: { success: false, message: 'Profile already exists' } }])
    await expect(provider.ensureProfile({ brandId: BRAND, displayName: 'Acme' })).resolves.toEqual({ profileRef: REF })
  })

  it('omits display_name when empty and truncates to 100 characters', async () => {
    const { provider, calls } = makeProvider([{ status: 201, json: {} }, { status: 201, json: {} }])
    await provider.ensureProfile({ brandId: BRAND, displayName: '   ' })
    expect(calls[0]!.json).toEqual({ username: REF })
    await provider.ensureProfile({ brandId: BRAND, displayName: 'x'.repeat(300) })
    expect((calls[1]!.json as { display_name: string }).display_name).toHaveLength(100)
  })

  it('uses the configured prefix', async () => {
    const { provider, calls } = makeProvider([{ status: 201, json: {} }], { profilePrefix: 'stg_brand_' })
    const out = await provider.ensureProfile({ brandId: BRAND, displayName: 'A' })
    expect(out.profileRef).toBe(`stg_brand_${BRAND}`)
    expect((calls[0]!.json as { username: string }).username).toBe(`stg_brand_${BRAND}`)
  })

  it('keeps an existing profileRef: GET, then PATCH only when the name changed', async () => {
    const { provider, calls } = makeProvider([
      { json: { success: true, profile: { username: 'legacy_1', display_name: 'Old', social_accounts: {} } } },
      { json: { success: true, profile: { username: 'legacy_1', display_name: 'New' } } },
    ])
    expect(await provider.ensureProfile({ brandId: BRAND, profileRef: 'legacy_1', displayName: 'New' })).toEqual({ profileRef: 'legacy_1' })
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /api/uploadposts/users/legacy_1',
      'PATCH /api/uploadposts/users/legacy_1',
    ])
    expect(calls[1]!.json).toEqual({ display_name: 'New' })
  })

  it('does not PATCH when the name is unchanged', async () => {
    const { provider, calls } = makeProvider([{ json: { profile: { username: 'legacy_1', display_name: 'Same' } } }])
    await provider.ensureProfile({ brandId: BRAND, profileRef: 'legacy_1', displayName: 'Same' })
    expect(calls).toHaveLength(1)
  })

  it('recreates a missing profileRef (404 → POST)', async () => {
    const { provider, calls } = makeProvider([{ status: 404, json: { success: false, message: 'Profile not found' } }, { status: 201, json: {} }])
    await provider.ensureProfile({ brandId: BRAND, profileRef: 'legacy_1', displayName: 'A' })
    expect(calls[1]!.method).toBe('POST')
    expect(calls[1]!.json).toEqual({ username: 'legacy_1', display_name: 'A' })
  })

  it('rejects unsafe ids before any request', async () => {
    const { provider, calls } = makeProvider([])
    await expect(provider.ensureProfile({ brandId: '../etc', displayName: 'A' })).rejects.toMatchObject({ code: 'validation' })
    await expect(provider.ensureProfile({ brandId: BRAND, profileRef: 'a b', displayName: 'A' })).rejects.toMatchObject({ code: 'validation' })
    expect(calls).toHaveLength(0)
  })

  it('maps PROFILE_LIMIT_REACHED to provider_auth (ops problem, not the user)', async () => {
    const { provider } = makeProvider([{ status: 403, json: { success: false, error_code: 'PROFILE_LIMIT_REACHED', message: 'Limit' } }])
    const err = await catchError(provider.ensureProfile({ brandId: BRAND, displayName: 'A' }))
    expect(providerErrorReason(err)).toBe('provider_auth')
    expect((err as AppError).code).toBe('unavailable')
    expect((err as AppError).details).toMatchObject({ status: 403, providerCode: 'PROFILE_LIMIT_REACHED' })
  })
})

describe('getProfile / deleteProfile', () => {
  it('returns null on 404', async () => {
    const { provider } = makeProvider([{ status: 404, json: { success: false, message: 'Profile not found' } }])
    expect(await provider.getProfile(REF)).toBeNull()
  })

  it('url-encodes the username', async () => {
    const { provider, last } = makeProvider([{ json: { profile: { username: 'me@x' } } }])
    await provider.getProfile('me@x')
    expect(last().url.pathname).toBe('/api/uploadposts/users/me%40x')
  })

  it('DELETE /api/uploadposts/users with {username}; 404 counts as deleted', async () => {
    const { provider, calls } = makeProvider([{ json: { success: true } }, { status: 404, json: { message: 'nope' } }])
    await provider.deleteProfile(REF)
    await provider.deleteProfile(REF)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url.toString()).toBe(`${BASE}/api/uploadposts/users`)
    expect(calls[0]!.json).toEqual({ username: REF })
    expectAuth(calls[0]!)
  })
})

describe('createConnectLink', () => {
  it('POSTs generate-jwt with show_calendar:false and returns the access_url', async () => {
    const { provider, last } = makeProvider([
      { json: { success: true, access_url: 'https://app.upload-post.com/connect?token=eyJabc', duration: '48h' } },
    ])
    const out = await provider.createConnectLink({
      profileRef: REF,
      platforms: ['tiktok', 'instagram'],
      redirectUrl: 'https://app.example.com/app/accounts?connected=1',
    })
    expect(out).toEqual({
      url: 'https://app.upload-post.com/connect?token=eyJabc',
      expiresAt: new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString(),
    })
    const req = last()
    expect(req.method).toBe('POST')
    expect(req.url.toString()).toBe(`${BASE}/api/uploadposts/users/generate-jwt`)
    expectAuth(req)
    expect(req.json).toEqual({
      username: REF,
      show_calendar: false,
      redirect_url: 'https://app.example.com/app/accounts?connected=1',
      platforms: ['tiktok', 'instagram'],
    })
  })

  it('omits the platform filter when a requested platform is not filterable (pinterest, bluesky)', async () => {
    const { provider, last } = makeProvider([{ json: { access_url: 'https://app.upload-post.com/connect?token=t' } }])
    await provider.createConnectLink({ profileRef: REF, platforms: ['bluesky', 'x'] })
    expect(last().json).toEqual({ username: REF, show_calendar: false })
  })

  it('sends branding and falls back to 48h when duration is missing', async () => {
    const { provider, last } = makeProvider([{ json: { access_url: 'https://app.upload-post.com/connect?token=t' } }], {
      connectPage: { logoUrl: 'https://cdn.example.com/logo.png', title: 'Connect', description: 'Pick accounts', buttonText: 'Back', language: 'es' },
    })
    const out = await provider.createConnectLink({ profileRef: REF, platforms: [] })
    expect(last().json).toEqual({
      username: REF,
      show_calendar: false,
      logo_image: 'https://cdn.example.com/logo.png',
      connect_title: 'Connect',
      connect_description: 'Pick accounts',
      redirect_button_text: 'Back',
      language: 'es',
    })
    expect(out.expiresAt).toBe(new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString())
  })

  it('rejects non-https redirects (http only for localhost)', async () => {
    const { provider, calls } = makeProvider([{ json: { access_url: 'https://app.upload-post.com/connect?token=t' } }])
    await expect(provider.createConnectLink({ profileRef: REF, platforms: [], redirectUrl: 'http://evil.com' })).rejects.toMatchObject({ code: 'validation' })
    await expect(provider.createConnectLink({ profileRef: REF, platforms: [], redirectUrl: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'validation' })
    expect(calls).toHaveLength(0)
    await provider.createConnectLink({ profileRef: REF, platforms: [], redirectUrl: 'http://localhost:3000/app' })
    expect(calls).toHaveLength(1)
  })

  it('refuses a non-https access_url from the provider', async () => {
    const { provider } = makeProvider([{ json: { access_url: 'http://insecure.example/connect' } }])
    const err = await catchError(provider.createConnectLink({ profileRef: REF, platforms: [] }))
    expect(providerErrorReason(err)).toBe('provider_unavailable')
  })

  it('maps 404 PROFILE_NOT_FOUND to not_found', async () => {
    const { provider } = makeProvider([{ status: 404, json: { success: false, error_code: 'PROFILE_NOT_FOUND', message: 'Profile not found' } }])
    const err = await catchError(provider.createConnectLink({ profileRef: REF, platforms: [] }))
    expect(err).toMatchObject({ code: 'not_found' })
    expect(providerErrorReason(err)).toBe('not_found')
  })
})

describe('listAccounts', () => {
  it('reads social_accounts from GET /users/{username}', async () => {
    const { provider, last } = makeProvider([
      {
        json: {
          success: true,
          profile: {
            username: REF,
            social_accounts: {
              tiktok: {
                username: '-000g91dgwXgwtNwc',
                handle: 'acme',
                display_name: 'Acme',
                social_images: 'https://x/y.jpg',
                reauth_required: false,
                capabilities: ['music'],
              },
              instagram: { username: '17841400000', handle: 'acme.ig', display_name: 'Acme IG', reauth_required: true },
              youtube: '',
              x: null,
              reddit: { username: 'r1' },
              google_business: { username: 'g1' },
            },
          },
        },
      },
    ])
    const accounts = await provider.listAccounts(REF)
    expect(last().method).toBe('GET')
    expect(last().url.toString()).toBe(`${BASE}/api/uploadposts/users/${REF}`)
    expectAuth(last())
    expect(accounts).toEqual([
      { platform: 'tiktok', externalId: '-000g91dgwXgwtNwc', handle: 'acme', displayName: 'Acme', status: 'active' },
      { platform: 'instagram', externalId: '17841400000', handle: 'acme.ig', displayName: 'Acme IG', status: 'needs_reauth' },
    ])
  })

  it('throws not_found for a missing profile', async () => {
    const { provider } = makeProvider([{ status: 404, json: { message: 'Profile not found' } }])
    await expect(provider.listAccounts(REF)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('normalises odd shapes (twitter key, string values, missing username)', () => {
    expect(
      accountsFromSocialAccounts({
        twitter: { handle: 'acme_x', display_name: 'Acme' },
        bluesky: 'acme.bsky.social',
        linkedin: { display_name: 'Acme Ltd' },
        pinterest: { reauth_required: true },
        threads: 42,
      }),
    ).toEqual([
      { platform: 'x', externalId: 'acme_x', handle: 'acme_x', displayName: 'Acme', status: 'active' },
      { platform: 'linkedin', externalId: 'Acme Ltd', handle: null, displayName: 'Acme Ltd', status: 'active' },
      { platform: 'bluesky', externalId: 'acme.bsky.social', handle: null, displayName: null, status: 'active' },
    ])
  })
})

describe('disconnect', () => {
  it('DELETE /api/uploadposts/users/social with profile_username + social_platform', async () => {
    const { provider, last } = makeProvider([{ json: { success: true } }])
    await provider.disconnect({ profileRef: REF, platform: 'instagram' })
    expect(last().method).toBe('DELETE')
    expect(last().url.toString()).toBe(`${BASE}/api/uploadposts/users/social`)
    expect(last().json).toEqual({ profile_username: REF, social_platform: 'instagram' })
    expectAuth(last())
  })

  it('treats 404 (never connected) as success', async () => {
    const { provider } = makeProvider([{ status: 404, json: { success: false } }])
    await expect(provider.disconnect({ profileRef: REF, platform: 'x' })).resolves.toBeUndefined()
  })

  it('validates the platform', async () => {
    const { provider, calls } = makeProvider([])
    await expect(provider.disconnect({ profileRef: REF, platform: 'myspace' as never })).rejects.toMatchObject({ code: 'validation' })
    expect(calls).toHaveLength(0)
  })
})

describe('listDestinations', () => {
  it('lists Facebook pages, LinkedIn pages (URN → id) and Pinterest boards', async () => {
    const { provider, calls } = makeProvider([
      { json: { success: true, pages: [{ id: '1234', name: 'Acme Page' }, { bad: true }] } },
      { json: { success: true, pages: [{ id: 'urn:li:organization:999', name: 'Acme Co' }] } },
      { json: { success: true, boards: [{ id: 'b1', name: 'Ideas' }] } },
    ])
    expect(await provider.listDestinations(REF, 'facebook')).toEqual([{ id: '1234', name: 'Acme Page' }])
    expect(await provider.listDestinations(REF, 'linkedin')).toEqual([{ id: '999', name: 'Acme Co' }])
    expect(await provider.listDestinations(REF, 'pinterest')).toEqual([{ id: 'b1', name: 'Ideas' }])
    expect(calls.map((c) => `${c.method} ${c.url.pathname}?${c.url.searchParams}`)).toEqual([
      `GET /api/uploadposts/facebook/pages?profile=${REF}`,
      `GET /api/uploadposts/linkedin/pages?profile=${REF}`,
      `GET /api/uploadposts/pinterest/boards?profile=${REF}`,
    ])
  })
})

describe('getStatus', () => {
  it('GET /api/uploadposts/status?request_id= and maps a completed result', async () => {
    const id = 'upr_instagram_0123456789abcdef0123456789abcdef'
    const { provider, last } = makeProvider([
      {
        json: {
          request_id: id,
          status: 'completed',
          completed: 1,
          total: 1,
          results: [
            {
              platform: 'instagram',
              success: true,
              status: 'completed',
              platform_post_id: '1789',
              post_url: 'https://www.instagram.com/reel/ABC/',
            },
          ],
        },
      },
    ])
    expect(await provider.getStatus(id)).toEqual({ state: 'published', postId: '1789', url: 'https://www.instagram.com/reel/ABC/' })
    expect(last().method).toBe('GET')
    expect(last().url.pathname).toBe('/api/uploadposts/status')
    expect(last().url.searchParams.get('request_id')).toBe(id)
    expectAuth(last())
  })

  it('throws not_found on 404 / status not_found', async () => {
    const { provider } = makeProvider([
      { status: 404, json: { request_id: 'x', status: 'not_found', message: 'No upload request found with this ID' } },
      { status: 404, text: '<html>nope</html>' },
    ])
    await expect(provider.getStatus('abc')).rejects.toMatchObject({ code: 'not_found' })
    await expect(provider.getStatus('abc')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('an empty or malformed 200 body is provider_unavailable (retry later)', async () => {
    const { provider } = makeProvider([{ status: 200, text: '' }, { status: 200, json: { status: 7 } }])
    await expect(provider.getStatus('abc')).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'provider_unavailable' } })
    await expect(provider.getStatus('abc')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects malformed request ids before any request', async () => {
    const { provider, calls } = makeProvider([])
    await expect(provider.getStatus('../../users')).rejects.toMatchObject({ code: 'validation' })
    expect(calls).toHaveLength(0)
  })
})

describe('getPostMetrics', () => {
  it('by request id: GET /post-analytics/{id}?platform=, normalised metrics', async () => {
    const { provider, last } = makeProvider([
      {
        json: {
          success: true,
          platforms: {
            youtube: { success: true, post_metrics: { views: 5200, likes: 120, comments: 8, favorites: 3, media_product_type: 'X' } },
          },
        },
      },
    ])
    const m = await provider.getPostMetrics({ requestId: 'upr_youtube_abc', platform: 'youtube', profileRef: REF })
    expect(m).toEqual({ views: 5200, likes: 120, comments: 8 })
    expect(last().url.pathname).toBe('/api/uploadposts/post-analytics/upr_youtube_abc')
    expect(last().url.searchParams.get('platform')).toBe('youtube')
    expectAuth(last())
  })

  it('by platform post id: GET /post-analytics?platform_post_id&platform&user', async () => {
    const { provider, last } = makeProvider([
      {
        json: {
          platforms: {
            x: { post_metrics: { impressions: 900, likes: 4, retweets: 2, replies: 1, bookmarks: 3 } },
          },
        },
      },
    ])
    const m = await provider.getPostMetrics({ platformPostId: '1850000000000000000', platform: 'x', profileRef: REF })
    expect(m).toEqual({ impressions: 900, likes: 4, shares: 2, comments: 1, saves: 3 })
    expect(last().url.pathname).toBe('/api/uploadposts/post-analytics')
    expect(Object.fromEntries(last().url.searchParams)).toEqual({ platform_post_id: '1850000000000000000', platform: 'x', user: REF })
  })

  it('returns {} when metrics could not be fetched or the platform is unsupported', async () => {
    const { provider, calls } = makeProvider([{ json: { platforms: { tiktok: { post_metrics_error: 'TikTok video not found' } } } }])
    expect(await provider.getPostMetrics({ requestId: 'r1', platform: 'tiktok', profileRef: REF })).toEqual({})
    expect(await provider.getPostMetrics({ platformPostId: 'at://x', platform: 'bluesky', profileRef: REF })).toEqual({})
    expect(calls).toHaveLength(1)
  })

  it('needs an id', async () => {
    const { provider } = makeProvider([])
    await expect(provider.getPostMetrics({ platform: 'x', profileRef: REF })).rejects.toMatchObject({ code: 'validation' })
  })

  it('maps the 100-per-5-minutes limit to rate_limited with retryAfter', async () => {
    const { provider } = makeProvider([{ status: 429, json: { success: false, error_type: 'daily_limit', retry_after: 120 } }])
    const err = await catchError(provider.getPostMetrics({ requestId: 'r1', platform: 'x', profileRef: REF }))
    expect(err).toMatchObject({ code: 'rate_limited', details: { reason: 'rate_limited', retryAfterSec: 120, providerCode: 'daily_limit' } })
  })
})

describe('getAccountMetrics', () => {
  it('GET /api/analytics/{profile}?platforms=… and normalises each platform', async () => {
    const { provider, last } = makeProvider([
      {
        json: {
          instagram: { followers: 47, reach: 1250, views: 3400, impressions: 3400, profileViews: 89, likes: 120, reach_timeseries: [] },
          tiktok: { followers: '800', views: 12000 },
          threads: { message: 'Analytics are not supported for this account.' },
        },
      },
    ])
    const out = await provider.getAccountMetrics({ profileRef: REF, platforms: ['instagram', 'tiktok', 'threads'] })
    expect(last().url.pathname).toBe(`/api/analytics/${REF}`)
    expect(last().url.searchParams.get('platforms')).toBe('instagram,tiktok,threads')
    expect(last().url.searchParams.has('page_id')).toBe(false)
    expectAuth(last())
    expect(out).toEqual([
      { platform: 'instagram', metrics: { followers: 47, reach: 1250, views: 3400, impressions: 3400, likes: 120 } },
      { platform: 'tiktok', metrics: { followers: 800, views: 12000 } },
      { platform: 'threads', metrics: {} },
    ])
  })

  it('resolves the Facebook page first (page_id is required by the provider)', async () => {
    const { provider, calls } = makeProvider([
      { json: { pages: [{ id: '555', name: 'Page' }] } },
      { json: { facebook: { followers: 10, reach: 20 } } },
    ])
    const out = await provider.getAccountMetrics({ profileRef: REF, platforms: ['facebook'] })
    expect(calls[0]!.url.pathname).toBe('/api/uploadposts/facebook/pages')
    expect(calls[1]!.url.searchParams.get('page_id')).toBe('555')
    expect(out).toEqual([{ platform: 'facebook', metrics: { followers: 10, reach: 20 } }])
  })

  it('skips Facebook when no page can be found, without failing the others', async () => {
    const { provider, calls } = makeProvider([{ status: 400, json: { message: 'No Facebook account' } }, { json: { x: { followers: 5 } } }])
    const out = await provider.getAccountMetrics({ profileRef: REF, platforms: ['facebook', 'x'] })
    expect(calls[1]!.url.searchParams.get('platforms')).toBe('x')
    expect(out).toEqual([
      { platform: 'facebook', metrics: {} },
      { platform: 'x', metrics: { followers: 5 } },
    ])
  })

  it('uses a given facebookPageId / linkedinPageId and makes no call for an empty list', async () => {
    const { provider, calls } = makeProvider([{ json: {} }])
    expect(await provider.getAccountMetrics({ profileRef: REF, platforms: [] })).toEqual([])
    await provider.getAccountMetrics({ profileRef: REF, platforms: ['facebook', 'linkedin'], facebookPageId: '42', linkedinPageId: '7' })
    expect(calls).toHaveLength(1)
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ platforms: 'facebook,linkedin', page_id: '42', page_urn: '7' })
  })
})

describe('listPastPosts', () => {
  const media = {
    success: true,
    media: [
      {
        id: '17890455123456789',
        caption: 'Launch day!',
        media_type: 'IMAGE',
        media_url: 'https://scontent.example/v/image123.jpg',
        permalink: 'https://www.instagram.com/p/ABC123/',
        timestamp: '2025-06-15T10:30:00+0000',
        thumbnail_url: null,
        like_count: 12,
      },
      { id: 42, caption: null, media_type: 'VIDEO', permalink: 'not a url', timestamp: 'garbage' },
      { caption: 'no id' },
    ],
    pagination: { limit: 25, next_cursor: 'QVFIUkc', has_more: true },
  }

  it('GET /api/uploadposts/media with platform, user, limit, cursor; maps captions and metadata only', async () => {
    const { provider, last } = makeProvider([{ json: media }])
    const out = await provider.listPastPosts({ profileRef: REF, platform: 'instagram', cursor: 'prev', limit: 50 })
    expect(last().url.pathname).toBe('/api/uploadposts/media')
    expect(Object.fromEntries(last().url.searchParams)).toEqual({ platform: 'instagram', user: REF, limit: '50', cursor: 'prev' })
    expectAuth(last())
    expect(out).toEqual({
      nextCursor: 'QVFIUkc',
      posts: [
        {
          platform: 'instagram',
          externalPostId: '17890455123456789',
          text: 'Launch day!',
          mediaType: 'IMAGE',
          postedAt: '2025-06-15T10:30:00.000Z',
          permalink: 'https://www.instagram.com/p/ABC123/',
          metrics: { likes: 12 },
        },
        { platform: 'instagram', externalPostId: '42', text: null, mediaType: 'VIDEO', postedAt: null, permalink: null, metrics: {} },
      ],
    })
    expect(JSON.stringify(out)).not.toContain('scontent')
  })

  it('caps the page size per platform and defaults to 25', async () => {
    const { provider, calls } = makeProvider([{ json: { media: [] } }, { json: { media: [] } }, { json: { media: [] } }])
    await provider.listPastPosts({ profileRef: REF, platform: 'tiktok', limit: 100 })
    await provider.listPastPosts({ profileRef: REF, platform: 'youtube', limit: 100 })
    await provider.listPastPosts({ profileRef: REF, platform: 'x' })
    expect(calls.map((c) => c.url.searchParams.get('limit'))).toEqual(['20', '50', '25'])
  })

  it('stops at the last page', async () => {
    const { provider } = makeProvider([{ json: { media: [], pagination: { next_cursor: null, has_more: false } } }])
    expect(await provider.listPastPosts({ profileRef: REF, platform: 'x' })).toEqual({ posts: [] })
  })

  it('never sends a cursor for LinkedIn (no pagination there)', async () => {
    const { provider, calls } = makeProvider([{ json: { ...media, pagination: { next_cursor: 'zzz', has_more: true } } }])
    expect(await provider.listPastPosts({ profileRef: REF, platform: 'linkedin', cursor: 'zzz' })).toEqual({ posts: [] })
    expect(calls).toHaveLength(0)
    const out = await provider.listPastPosts({ profileRef: REF, platform: 'linkedin' })
    expect(out.nextCursor).toBeUndefined()
    expect(calls[0]!.url.searchParams.has('cursor')).toBe(false)
  })
})

describe('helpers', () => {
  it('profileRefForBrand / parseDurationMs / toIsoTimestamp', () => {
    expect(profileRefForBrand('ABC-def')).toBe('brand_abc-def')
    expect(parseDurationMs('48h')).toBe(48 * 3_600_000)
    expect(parseDurationMs('30m')).toBe(1_800_000)
    expect(parseDurationMs('soon')).toBeUndefined()
    expect(toIsoTimestamp('2025-06-15T10:30:00+0000')).toBe('2025-06-15T10:30:00.000Z')
    expect(toIsoTimestamp('2025-06-15T10:30:00Z')).toBe('2025-06-15T10:30:00.000Z')
    expect(toIsoTimestamp('nope')).toBeNull()
  })
})
