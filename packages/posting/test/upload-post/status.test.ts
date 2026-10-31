import { describe, expect, it } from 'vitest'
import { mapUploadStatus, publicUrl, requestIdFor } from '../../src/upload-post'
import { makeProvider } from '../helpers'

const safe = (m: unknown) => (typeof m === 'string' && m.trim() ? m.trim() : null)

describe('mapUploadStatus', () => {
  it('pending while queued / processing / in_progress, including "Queued" results without a status', () => {
    expect(mapUploadStatus({ status: 'pending', results: [] }, 'x', safe)).toEqual({ state: 'pending' })
    expect(mapUploadStatus({ status: 'queued' }, 'x', safe)).toEqual({ state: 'pending' })
    expect(
      mapUploadStatus({ status: 'in_progress', results: [{ platform: 'x', success: true, message: 'Queued' }] }, 'x', safe),
    ).toEqual({ state: 'pending' })
    expect(mapUploadStatus({ status: 'processing', results: [{ platform: 'x', status: 'processing' }] }, 'x', safe)).toEqual({ state: 'pending' })
  })

  it('retryable is still pending (the provider retries by itself)', () => {
    expect(mapUploadStatus({ status: 'in_progress', results: [{ platform: 'x', success: false, status: 'retryable', error: 'temp' }] }, 'x', safe)).toEqual({
      state: 'pending',
    })
  })

  it('published with post id and URL', () => {
    expect(
      mapUploadStatus(
        { status: 'completed', results: [{ platform: 'tiktok', success: true, status: 'completed', platform_post_id: '7401', post_url: 'https://www.tiktok.com/@a/video/7401' }] },
        'tiktok',
        safe,
      ),
    ).toEqual({ state: 'published', postId: '7401', url: 'https://www.tiktok.com/@a/video/7401' })
  })

  it('published without a status field once the request completed ("Published" message)', () => {
    expect(mapUploadStatus({ status: 'completed', results: [{ platform: 'x', success: true, message: 'Published' }] }, 'x', safe)).toEqual({
      state: 'published',
    })
  })

  it('TikTok late post id: published with the temporary id and no URL', () => {
    expect(
      mapUploadStatus(
        { status: 'completed', results: [{ platform: 'tiktok', success: true, post_url: null, platform_post_id: 'p_pub_123', warnings: ['id later'] }] },
        'tiktok',
        safe,
      ),
    ).toEqual({ state: 'published', postId: 'p_pub_123' })
  })

  it('TikTok inbox fallback is a failure (not live), with prose in post_url ignored', () => {
    const s = mapUploadStatus(
      {
        status: 'completed',
        results: [{ platform: 'tiktok', success: true, fallback_to_inbox: true, post_url: 'Video sent to Inbox (No Public URL)' }],
      },
      'tiktok',
      safe,
    )
    expect(s.state).toBe('failed')
    expect(s.error).toContain('inbox')
  })

  it('failed results carry the provider reason; skipped means not connected', () => {
    expect(mapUploadStatus({ status: 'failed', results: [{ platform: 'linkedin', success: false, error: 'Expired access token' }] }, 'linkedin', safe)).toEqual({
      state: 'failed',
      error: 'Expired access token',
    })
    expect(
      mapUploadStatus({ status: 'completed', results: [{ platform: 'linkedin', success: false, status: 'skipped', skipped: true }] }, 'linkedin', safe).error,
    ).toContain('No LinkedIn account is connected')
    expect(
      mapUploadStatus({ status: 'failed', results: [{ platform: 'tiktok', success: false, error_code: 'reached_active_user_cap' }] }, 'tiktok', safe).error,
    ).toContain('daily posting limit')
  })

  it('a top-level failure without results (no activity for over 1 hour)', () => {
    expect(mapUploadStatus({ status: 'failed', message: 'Upload appears to have failed (no activity for over 1 hour)', results: [] }, 'x', safe)).toEqual({
      state: 'failed',
      error: 'Upload appears to have failed (no activity for over 1 hour)',
    })
    expect(mapUploadStatus({ status: 'completed', results: [] }, 'x', safe).state).toBe('failed')
  })

  it('picks the result of our platform; a single foreign-named result still counts', () => {
    const body = {
      status: 'in_progress',
      results: [
        { platform: 'x', success: true, status: 'completed', post_id: '1' },
        { platform: 'linkedin', status: 'processing' },
      ],
    }
    expect(mapUploadStatus(body, 'linkedin', safe)).toEqual({ state: 'pending' })
    expect(mapUploadStatus(body, 'x', safe)).toEqual({ state: 'published', postId: '1' })
    expect(mapUploadStatus({ status: 'completed', results: [{ platform: 'twitter', success: true, post_id: 9 }] }, 'x', safe)).toEqual({
      state: 'published',
      postId: '9',
    })
    // unknown platform (provider-generated request id): latest result
    expect(mapUploadStatus(body, undefined, safe)).toEqual({ state: 'pending' })
  })

  it('ignores malformed results', () => {
    expect(mapUploadStatus({ status: 'in_progress', results: ['nope', 42, { platform: 'x', success: 'yes' }] }, 'x', safe)).toEqual({ state: 'pending' })
  })

  it('publicUrl accepts http(s) only', () => {
    expect(publicUrl('https://x.com/a')).toBe('https://x.com/a')
    expect(publicUrl('Video sent to Inbox (No Public URL)')).toBeUndefined()
    expect(publicUrl('javascript:alert(1)')).toBeUndefined()
    expect(publicUrl(null)).toBeUndefined()
  })
})

describe('getStatus end to end', () => {
  it('uses the platform encoded in our request id and cleans failure messages', async () => {
    const id = requestIdFor('linkedin', 'k1')
    const { provider } = makeProvider([
      {
        json: {
          request_id: id,
          status: 'failed',
          results: [{ platform: 'linkedin', success: false, status: 'failed', error: 'Token expired. Reconnect at https://app.upload-post.com/manage-users' }],
        },
      },
    ])
    expect(await provider.getStatus(id)).toEqual({ state: 'failed', error: 'Token expired. Reconnect' })
  })
})
