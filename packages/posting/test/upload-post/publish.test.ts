import { describe, expect, it } from 'vitest'
import type { PublishInput } from '@app/core/ports'
import { providerErrorReason } from '../../src/errors'
import { buildPublishRequest, platformFromRequestId, requestIdFor } from '../../src/upload-post'
import { parsePublishInput } from '../../src/publish-input'
import { PLATFORMS } from '@app/core/types'
import { API_KEY, BASE, IMG1, IMG2, MEDIA, catchError, formEntries, formObject, makeProvider } from '../helpers'

const REF = 'brand_11111111-2222-3333-4444-555555555555'
const KEY = 'post:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function input(over: Partial<PublishInput> & Pick<PublishInput, 'platform' | 'kind'>): PublishInput {
  return {
    profileRef: REF,
    text: 'Hello world',
    mediaUrls: over.kind === 'video' ? [MEDIA] : over.kind === 'photos' ? [IMG1, IMG2] : [],
    options: {},
    idempotencyKey: KEY,
    ...over,
  }
}

function fields(i: PublishInput) {
  const parsed = parsePublishInput(i)
  const req = buildPublishRequest(parsed, requestIdFor(parsed.platform, parsed.idempotencyKey))
  return { path: req.path, f: Object.fromEntries(req.fields.filter(([k]) => !k.endsWith('[]'))), all: req.fields }
}

const ASYNC_OK = { json: { success: true, message: 'Upload initiated successfully in background.', request_id: 'srv-req-1', total_platforms: 1 } }

describe('publish request', () => {
  it('video → POST /api/upload, multipart, Idempotency-Key, async_upload, our request_id and external_id', async () => {
    const { provider, last } = makeProvider([ASYNC_OK])
    const out = await provider.publish(input({ platform: 'tiktok', kind: 'video', options: { privacyLevel: 'PUBLIC_TO_EVERYONE' } }))
    expect(out).toEqual({ requestId: 'srv-req-1' })
    const req = last()
    expect(req.method).toBe('POST')
    expect(req.url.toString()).toBe(`${BASE}/api/upload`)
    expect(req.headers.get('authorization')).toBe(`Apikey ${API_KEY}`)
    expect(req.headers.get('idempotency-key')).toBe(KEY)
    // fetch sets the multipart boundary itself
    expect(req.headers.get('content-type')).toBeNull()
    expect(req.form).toBeInstanceOf(FormData)
    expect(formEntries(req.form)).toEqual([
      ['user', REF],
      ['platform[]', 'tiktok'],
      ['async_upload', 'true'],
      ['request_id', requestIdFor('tiktok', KEY)],
      ['external_id', KEY],
      ['video', MEDIA],
      ['title', 'Hello world'],
      ['post_mode', 'DIRECT_POST'],
      ['disable_inbox_fallback', 'true'],
      ['privacy_level', 'PUBLIC_TO_EVERYONE'],
    ])
  })

  it('photos → POST /api/upload_photos with one photos[] per URL', async () => {
    const { provider, last } = makeProvider([ASYNC_OK])
    await provider.publish(input({ platform: 'instagram', kind: 'photos' }))
    expect(last().url.pathname).toBe('/api/upload_photos')
    expect(last().form?.getAll('photos[]')).toEqual([IMG1, IMG2])
    expect(last().form?.get('title')).toBe('Hello world')
    expect(last().form?.has('video')).toBe(false)
  })

  it('text → POST /api/upload_text with the text as title', async () => {
    const { provider, last } = makeProvider([ASYNC_OK])
    await provider.publish(input({ platform: 'x', kind: 'text', text: 'Just text' }))
    expect(last().url.pathname).toBe('/api/upload_text')
    expect(formObject(last().form)).toEqual({
      user: REF,
      'platform[]': 'x',
      async_upload: 'true',
      request_id: requestIdFor('x', KEY),
      external_id: KEY,
      title: 'Just text',
    })
  })

  it('falls back to our deterministic request_id when the provider omits one', async () => {
    const { provider } = makeProvider([{ json: { success: true } }])
    const out = await provider.publish(input({ platform: 'threads', kind: 'text' }))
    expect(out.requestId).toBe(requestIdFor('threads', KEY))
    expect(platformFromRequestId(out.requestId, PLATFORMS)).toBe('threads')
  })

  it('request ids are deterministic per (platform, key) and carry the platform', () => {
    expect(requestIdFor('x', 'k')).toBe(requestIdFor('x', 'k'))
    expect(requestIdFor('x', 'k')).not.toBe(requestIdFor('threads', 'k'))
    expect(requestIdFor('x', 'k')).toMatch(/^upr_x_[0-9a-f]{32}$/)
    expect(platformFromRequestId('srv-req-1', PLATFORMS)).toBeUndefined()
    expect(platformFromRequestId('upr_myspace_0123456789abcdef0123456789abcdef', PLATFORMS)).toBeUndefined()
  })

  it('throws provider_rejected when a synchronous result failed or was skipped', async () => {
    const { provider } = makeProvider([
      { json: { success: true, results: { linkedin: { success: false, error: 'Expired access token, see https://app.upload-post.com/manage-users' } } } },
      {
        json: {
          success: true,
          results: { linkedin: { success: false, skipped: true, skip_reason: 'profile_platform_not_configured', error_code: 'profile_platform_mapping_invalid' } },
        },
      },
    ])
    const a = await catchError(provider.publish(input({ platform: 'linkedin', kind: 'text' })))
    expect(providerErrorReason(a)).toBe('provider_rejected')
    expect(a.message).toBe('LinkedIn rejected the post: Expired access token')
    const b = await catchError(provider.publish(input({ platform: 'linkedin', kind: 'text' })))
    expect(b.message).toContain('No LinkedIn account is connected')
    expect(b).toMatchObject({ details: { providerCode: 'profile_platform_mapping_invalid' } })
  })

  it('maps 409 IDEMPOTENCY_KEY_IN_USE to conflict with a short retryAfter', async () => {
    const { provider } = makeProvider([{ status: 409, json: { success: false, code: 'IDEMPOTENCY_KEY_IN_USE' } }])
    const err = await catchError(provider.publish(input({ platform: 'x', kind: 'text' })))
    expect(err).toMatchObject({ code: 'conflict', details: { reason: 'conflict', retryAfterSec: 5 } })
  })

  it('maps a daily-cap 429 (violations) to cap_reached', async () => {
    const { provider } = makeProvider([
      {
        status: 429,
        json: {
          success: false,
          message: 'Post verification failed',
          violations: [{ platform: 'instagram', type: 'hard_cap', message: 'Daily cap reached for instagram: 50/50 in last 24h', used_last_24h: 50, cap: 50 }],
        },
      },
    ])
    const err = await catchError(provider.publish(input({ platform: 'instagram', kind: 'photos' })))
    expect(err).toMatchObject({ code: 'cap_reached', details: { reason: 'cap_reached', status: 429, retryAfterSec: 3600 } })
    expect(err.message).toContain('50/50')
  })

  it('maps a duplicate-content 429 violation to provider_rejected', async () => {
    const { provider } = makeProvider([
      { status: 429, json: { message: 'Post verification failed', violations: [{ type: 'duplicate', message: 'Duplicate content within 48h' }] } },
    ])
    const err = await catchError(provider.publish(input({ platform: 'instagram', kind: 'photos' })))
    expect(providerErrorReason(err)).toBe('provider_rejected')
    expect(err.message).toContain('Duplicate content')
  })
})

describe('publish validation (before any request)', () => {
  const cases: Array<[string, PublishInput]> = [
    ['text on TikTok', input({ platform: 'tiktok', kind: 'text' })],
    ['text on Instagram', input({ platform: 'instagram', kind: 'text' })],
    ['photos on YouTube', input({ platform: 'youtube', kind: 'photos', title: 'T' })],
    ['two videos', input({ platform: 'tiktok', kind: 'video', mediaUrls: [MEDIA, IMG1] })],
    ['no photos', input({ platform: 'x', kind: 'photos', mediaUrls: [] })],
    ['text with media', input({ platform: 'x', kind: 'text', mediaUrls: [IMG1] })],
    ['empty text post', input({ platform: 'x', kind: 'text', text: '  ' })],
    ['http media', input({ platform: 'x', kind: 'photos', mediaUrls: ['http://media.example/1.jpg'] })],
    ['credentials in media url', input({ platform: 'x', kind: 'photos', mediaUrls: ['https://u:p@media.example/1.jpg'] })],
    ['duplicate media', input({ platform: 'x', kind: 'photos', mediaUrls: [IMG1, IMG1] })],
    ['YouTube without title', input({ platform: 'youtube', kind: 'video' })],
    ['Pinterest without board', input({ platform: 'pinterest', kind: 'photos' })],
    ['unknown option', input({ platform: 'x', kind: 'text', options: { pollOptions: ['a'] } })],
    ['wrong option value', input({ platform: 'tiktok', kind: 'video', options: { privacyLevel: 'EVERYONE' } })],
    ['bad profile ref', input({ platform: 'x', kind: 'text', profileRef: 'a/b' })],
    ['spaces in idempotency key', input({ platform: 'x', kind: 'text', idempotencyKey: 'a b' })],
    ['unknown platform', input({ platform: 'myspace' as never, kind: 'text' })],
  ]
  for (const [name, i] of cases) {
    it(`rejects ${name}`, async () => {
      const { provider, calls } = makeProvider([])
      await expect(provider.publish(i)).rejects.toMatchObject({ code: 'validation' })
      expect(calls).toHaveLength(0)
    })
  }
})

describe('per-platform fields', () => {
  it('TikTok video: privacy, toggles, cover, AI label, first comment, DIRECT_POST, no inbox fallback', () => {
    const { path, f } = fields(
      input({
        platform: 'tiktok',
        kind: 'video',
        options: {
          privacyLevel: 'SELF_ONLY',
          disableComment: true,
          disableDuet: true,
          disableStitch: false,
          brandContent: false,
          brandOrganic: true,
          isAiGenerated: true,
          coverTimestampMs: 1500,
          firstComment: 'Link in bio',
        },
      }),
    )
    expect(path).toBe('/api/upload')
    expect(f).toMatchObject({
      title: 'Hello world',
      post_mode: 'DIRECT_POST',
      disable_inbox_fallback: 'true',
      privacy_level: 'SELF_ONLY',
      disable_comment: 'true',
      disable_duet: 'true',
      disable_stitch: 'false',
      brand_content_toggle: 'false',
      brand_organic_toggle: 'true',
      is_aigc: 'true',
      cover_timestamp: '1500',
      first_comment: 'Link in bio',
    })
  })

  it('TikTok photos: title is the short title, text goes to tiktok_description; no video-only fields', () => {
    const { path, f } = fields(
      input({ platform: 'tiktok', kind: 'photos', title: 'Short', options: { disableDuet: true, coverTimestampMs: 5, isAiGenerated: true } }),
    )
    expect(path).toBe('/api/upload_photos')
    expect(f.title).toBe('Short')
    expect(f.tiktok_description).toBe('Hello world')
    expect(f).not.toHaveProperty('disable_duet')
    expect(f).not.toHaveProperty('cover_timestamp')
    expect(f).not.toHaveProperty('is_aigc')
  })

  it('YouTube: title + description, tags[], category, privacy, kids, synthetic, playlist, first comment', () => {
    const { f, all } = fields(
      input({
        platform: 'youtube',
        kind: 'video',
        title: 'My video',
        options: {
          tags: ['how to', 'tips'],
          categoryId: '22',
          privacyStatus: 'unlisted',
          madeForKids: false,
          containsSyntheticMedia: true,
          playlistId: 'PLabc',
          firstComment: 'Thanks!',
        },
      }),
    )
    expect(f).toMatchObject({
      title: 'My video',
      description: 'Hello world',
      categoryId: '22',
      privacyStatus: 'unlisted',
      selfDeclaredMadeForKids: 'false',
      containsSyntheticMedia: 'true',
      youtube_playlist_id: 'PLabc',
      first_comment: 'Thanks!',
    })
    expect(all.filter(([k]) => k === 'tags[]').map(([, v]) => v)).toEqual(['how to', 'tips'])
  })

  it('Instagram reel: media_type, share_to_feed, thumb_offset, collaborators without @, location, first comment', () => {
    const { f } = fields(
      input({
        platform: 'instagram',
        kind: 'video',
        options: { mediaType: 'REELS', shareToFeed: false, thumbOffsetMs: 2000, collaborators: ['@alice', 'bob'], locationId: '110184922344060', firstComment: '#tags' },
      }),
    )
    expect(f).toMatchObject({
      title: 'Hello world',
      media_type: 'REELS',
      share_to_feed: 'false',
      thumb_offset: '2000',
      collaborators: 'alice,bob',
      location_id: '110184922344060',
      first_comment: '#tags',
    })
  })

  it('Instagram story video has no share_to_feed; photo stories send STORIES, photo REELS sends nothing', () => {
    expect(fields(input({ platform: 'instagram', kind: 'video', options: { mediaType: 'STORIES', shareToFeed: true } })).f).not.toHaveProperty('share_to_feed')
    expect(fields(input({ platform: 'instagram', kind: 'photos', options: { mediaType: 'STORIES' } })).f.media_type).toBe('STORIES')
    expect(fields(input({ platform: 'instagram', kind: 'photos', options: { mediaType: 'REELS', thumbOffsetMs: 5 } })).f).not.toHaveProperty('media_type')
  })

  it('Facebook: page id, media type, description for video; caption as title for photos and text', () => {
    const video = fields(input({ platform: 'facebook', kind: 'video', title: 'Clip', options: { pageId: '1234', mediaType: 'VIDEO', firstComment: 'hi' } })).f
    expect(video).toMatchObject({ title: 'Clip', description: 'Hello world', facebook_page_id: '1234', facebook_media_type: 'VIDEO', first_comment: 'hi' })
    const photos = fields(input({ platform: 'facebook', kind: 'photos', options: { pageId: '1234', mediaType: 'REELS' } })).f
    expect(photos).toMatchObject({ title: 'Hello world', facebook_page_id: '1234' })
    expect(photos).not.toHaveProperty('facebook_media_type')
    expect(fields(input({ platform: 'facebook', kind: 'photos', options: { mediaType: 'STORIES' } })).f.facebook_media_type).toBe('STORIES')
    const text = fields(input({ platform: 'facebook', kind: 'text', options: { pageId: '1234' } }))
    expect(text.path).toBe('/api/upload_text')
    expect(text.f).toMatchObject({ title: 'Hello world', facebook_page_id: '1234' })
  })

  it('Threads: topic tag, reply control', () => {
    const { f } = fields(input({ platform: 'threads', kind: 'text', options: { topicTag: 'Tech', replyControl: 'mentioned_only', firstComment: 'more' } }))
    expect(f).toMatchObject({ title: 'Hello world', threads_topic_tag: 'Tech', threads_reply_control: 'mentioned_only', first_comment: 'more' })
  })

  it('X: single_post sets x_long_text_as_post; reply settings other than everyone', () => {
    const a = fields(input({ platform: 'x', kind: 'text', options: { longTextMode: 'single_post', replySettings: 'following' } })).f
    expect(a).toMatchObject({ x_long_text_as_post: 'true', reply_settings: 'following' })
    const b = fields(input({ platform: 'x', kind: 'text', options: { longTextMode: 'thread', replySettings: 'everyone' } })).f
    expect(b).not.toHaveProperty('x_long_text_as_post')
    expect(b).not.toHaveProperty('reply_settings')
  })

  it('LinkedIn: commentary as description, visibility, organization page', () => {
    const video = fields(input({ platform: 'linkedin', kind: 'video', title: 'Video title', options: { visibility: 'CONNECTIONS', pageId: '107579166' } })).f
    expect(video).toMatchObject({ title: 'Video title', description: 'Hello world', visibility: 'CONNECTIONS', target_linkedin_page_id: '107579166' })
    const text = fields(input({ platform: 'linkedin', kind: 'text', options: { visibility: 'PUBLIC' } })).f
    expect(text).toMatchObject({ title: 'Hello world', visibility: 'PUBLIC' })
    expect(text).not.toHaveProperty('description')
  })

  it('Pinterest: board, link, alt text, pin title + description; no first comment field', () => {
    const { f } = fields(
      input({ platform: 'pinterest', kind: 'photos', title: 'Pin', options: { boardId: 'b1', link: 'https://shop.example.com/p', altText: 'A chair' } }),
    )
    expect(f).toMatchObject({
      title: 'Pin',
      description: 'Hello world',
      pinterest_board_id: 'b1',
      pinterest_link: 'https://shop.example.com/p',
      pinterest_alt_text: 'A chair',
    })
    expect(f).not.toHaveProperty('first_comment')
  })

  it('Bluesky: alt text and langs', () => {
    const { f } = fields(input({ platform: 'bluesky', kind: 'photos', options: { altText: 'Cat', langs: ['en', 'es'], firstComment: 'x' } }))
    expect(f).toMatchObject({ title: 'Hello world', bluesky_alt_text: 'Cat', bluesky_langs: 'en,es', first_comment: 'x' })
  })

  it('omits empty text and absent options', () => {
    const { f } = fields(input({ platform: 'instagram', kind: 'video', text: '' }))
    expect(f).not.toHaveProperty('title')
    expect(Object.keys(f).sort()).toEqual(['async_upload', 'external_id', 'request_id', 'user', 'video'])
  })

  it('cleans control characters from text', () => {
    const { f } = fields(input({ platform: 'x', kind: 'text', text: 'a\u0000b\r\nc' }))
    expect(f.title).toBe('ab\nc')
  })
})
