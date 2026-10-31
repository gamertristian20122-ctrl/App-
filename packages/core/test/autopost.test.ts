import { describe, expect, it } from 'vitest'
import { AUTO_POST_OUTCOME_LABELS, AUTO_POST_OUTCOMES, BEST_TIME_SLOTS, bestSlotTimes, nextMinute, zonedTimeToUtc } from '../src/autopost'
import { checkImportUrl, isPublicIp } from '../src/links'
import { PLATFORMS } from '../src/types'
import {
  AiUploadInputSchema,
  AutoPostSettingsSchema,
  AutoPublishSchema,
  ClipRequestSchema,
  PublishVideoInputSchema,
  RenderCodeVideoInputSchema,
  RenderVideoInputSchema,
} from '../src/validation'

describe('auto-post time helpers', () => {
  it('"now" is the start of the next minute', () => {
    expect(nextMinute(new Date('2026-11-02T12:00:00.000Z')).toISOString()).toBe('2026-11-02T12:01:00.000Z')
    expect(nextMinute(new Date('2026-11-02T12:00:59.999Z')).toISOString()).toBe('2026-11-02T12:01:00.000Z')
  })

  it('converts wall-clock times in a zone to UTC, across DST', () => {
    expect(zonedTimeToUtc(2026, 11, 2, 11, 0, 'America/New_York').toISOString()).toBe('2026-11-02T16:00:00.000Z') // EST
    expect(zonedTimeToUtc(2026, 7, 1, 11, 0, 'America/New_York').toISOString()).toBe('2026-07-01T15:00:00.000Z') // EDT
    expect(zonedTimeToUtc(2026, 11, 2, 9, 30, 'UTC').toISOString()).toBe('2026-11-02T09:30:00.000Z')
    expect(zonedTimeToUtc(2026, 11, 2, 9, 0, 'Asia/Kolkata').toISOString()).toBe('2026-11-02T03:30:00.000Z')
  })

  it('"best" offers each platform its slots in the brand time zone, at least 5 minutes ahead', () => {
    for (const p of PLATFORMS) expect(BEST_TIME_SLOTS[p].length).toBeGreaterThan(0)
    const now = new Date('2026-11-02T12:00:00.000Z') // 07:00 in New York
    const ig = bestSlotTimes('instagram', now, 'America/New_York')
    expect(ig[0]?.toISOString()).toBe('2026-11-02T16:00:00.000Z') // 11:00 local
    expect(ig[1]?.toISOString()).toBe('2026-11-03T00:00:00.000Z') // 19:00 local
    expect(ig.every((d, i) => i === 0 || d.getTime() > (ig[i - 1] as Date).getTime())).toBe(true)
    // a slot 3 minutes away is too close: the next one is used
    const close = bestSlotTimes('youtube', new Date('2026-11-02T14:57:00.000Z'), 'UTC')
    expect(close[0]?.toISOString()).toBe('2026-11-03T15:00:00.000Z')
    expect(bestSlotTimes('linkedin', now, 'UTC').length).toBeGreaterThanOrEqual(14)
  })

  it('names every outcome', () => {
    for (const o of AUTO_POST_OUTCOMES) expect(AUTO_POST_OUTCOME_LABELS[o]).toBeTruthy()
  })
})

describe('import links (upload_media sourceUrl)', () => {
  it('accepts https links to public host names and normalises them', () => {
    expect(checkImportUrl('https://CDN.Example.com/renders/final.mp4?sig=abc#t=1')).toEqual({
      ok: true,
      host: 'cdn.example.com',
      url: 'https://cdn.example.com/renders/final.mp4?sig=abc',
    })
  })

  it('refuses video and social sites (only your own videos)', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://www.tiktok.com/@a/video/1',
      'https://www.instagram.com/reel/abc/',
      'https://www.facebook.com/watch/?v=1',
      'https://x.com/a/status/1',
      'https://twitter.com/a/status/1',
      'https://vimeo.com/123',
      'https://www.twitch.tv/videos/1',
      'https://v16-webapp.tiktokcdn.com/video.mp4',
      'http://youtube.com/watch?v=1',
    ]) {
      const r = checkImportUrl(url)
      expect(r.ok, url).toBe(false)
      if (!r.ok) expect(r.reason, url).toBe('video_site_forbidden')
    }
  })

  it('refuses private, local and IP hosts, ports, credentials and non-https', () => {
    const reasons = (url: string) => {
      const r = checkImportUrl(url)
      return r.ok ? 'ok' : r.reason
    }
    expect(reasons('https://127.0.0.1/a.mp4')).toBe('ip_literal')
    expect(reasons('https://10.0.0.5/a.mp4')).toBe('ip_literal')
    expect(reasons('https://169.254.169.254/latest/meta-data')).toBe('ip_literal')
    expect(reasons('https://[::1]/a.mp4')).toBe('ip_literal')
    expect(reasons('https://localhost/a.mp4')).toBe('private_host')
    expect(reasons('https://metadata.google.internal/a')).toBe('private_host')
    expect(reasons('https://nas.local/a.mp4')).toBe('private_host')
    expect(reasons('https://intranet/a.mp4')).toBe('private_host')
    expect(reasons('https://cdn.example.com:8443/a.mp4')).toBe('has_port')
    expect(reasons('https://user:pw@cdn.example.com/a.mp4')).toBe('has_credentials')
    expect(reasons('http://cdn.example.com/a.mp4')).toBe('not_https')
    expect(reasons('file:///etc/passwd')).toBe('not_https')
    expect(reasons('not a url')).toBe('invalid_url')
  })

  it('tells public IP addresses from private, reserved and mapped ones', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:81d::200e', '::ffff:8.8.8.8']) {
      expect(isPublicIp(ip), ip).toBe(true)
    }
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.1',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:0a00:0001::1',
      '2001:db8::1',
      '2001:0:4136:e378::1',
      'nonsense',
      '1.2.3',
      '300.1.1.1',
    ]) {
      expect(isPublicIp(ip), ip).toBe(false)
    }
    expect(isPublicIp('172.32.0.1')).toBe(true)
  })
})

describe('auto-post schemas', () => {
  it('autoPublish defaults to "now" and takes "best" or an ISO time', () => {
    expect(AutoPublishSchema.parse({})).toEqual({ when: 'now' })
    expect(AutoPublishSchema.parse({ when: 'best', platforms: ['tiktok', 'youtube'] })).toEqual({ when: 'best', platforms: ['tiktok', 'youtube'] })
    expect(AutoPublishSchema.safeParse({ when: '2026-11-03T10:00:00Z' }).success).toBe(true)
    expect(AutoPublishSchema.safeParse({ when: 'tomorrow' }).success).toBe(false)
    expect(AutoPublishSchema.safeParse({ platforms: ['x', 'x'] }).success).toBe(false)
    expect(RenderVideoInputSchema.safeParse({ brandId: '11111111-1111-4111-8111-111111111111', slides: [{ text: 'a' }], autoPublish: { when: 'best' } }).success).toBe(true)
    expect(ClipRequestSchema.safeParse({ mediaId: '11111111-1111-4111-8111-111111111111', ranges: [{ startMs: 0, endMs: 5000 }], autoPublish: {} }).success).toBe(true)
  })

  it('Auto-post settings: daily max 1–25 (default 3), distinct platforms, TikTok privacy', () => {
    expect(AutoPostSettingsSchema.parse({ enabled: true })).toEqual({ enabled: true, platforms: [], dailyMax: 3, tiktokPrivacy: null })
    expect(AutoPostSettingsSchema.safeParse({ enabled: true, dailyMax: 0 }).success).toBe(false)
    expect(AutoPostSettingsSchema.safeParse({ enabled: true, dailyMax: 26 }).success).toBe(false)
    expect(AutoPostSettingsSchema.safeParse({ enabled: true, tiktokPrivacy: 'EVERYONE' }).success).toBe(false)
  })

  it('publish_video needs a caption (or overrides) and validates platforms', () => {
    const base = { brandId: '11111111-1111-4111-8111-111111111111', mediaId: '22222222-2222-4222-8222-222222222222' }
    expect(PublishVideoInputSchema.safeParse(base).success).toBe(false)
    expect(PublishVideoInputSchema.parse({ ...base, caption: 'Hi' })).toMatchObject({ when: 'now', caption: 'Hi' })
    expect(PublishVideoInputSchema.safeParse({ ...base, overrides: { youtube: { title: 'T' } } }).success).toBe(true)
    expect(PublishVideoInputSchema.safeParse({ ...base, caption: 'x', overrides: { myspace: { text: 'a' } } }).success).toBe(false)
  })

  it('AI uploads: allowed types, kind must match, at most 5 GB', () => {
    const ok = AiUploadInputSchema.safeParse({ filename: 'out/final video.mp4', contentType: 'video/mp4', bytes: 1000 })
    expect(ok.success).toBe(true)
    expect(AiUploadInputSchema.safeParse({ filename: 'a.mp4', contentType: 'video/mp4', bytes: 1000, kind: 'image' }).success).toBe(false)
    expect(AiUploadInputSchema.safeParse({ filename: 'a.svg', contentType: 'image/svg+xml', bytes: 1000 }).success).toBe(false)
    expect(AiUploadInputSchema.safeParse({ filename: 'a.mp4', contentType: 'video/mp4', bytes: 6_000_000_000 }).success).toBe(false)
    expect(AiUploadInputSchema.safeParse({ filename: 'a\nb.mp4', contentType: 'video/mp4', bytes: 1 }).success).toBe(false)
  })

  it('code videos: ≤ 300 KB of HTML, 1–60 s, 24 or 30 fps', () => {
    const base = { brandId: '11111111-1111-4111-8111-111111111111', html: '<p>hi</p>', durationMs: 5000 }
    expect(RenderCodeVideoInputSchema.parse(base)).toMatchObject({ fps: 30, aspect: '9:16' })
    expect(RenderCodeVideoInputSchema.safeParse({ ...base, html: 'x'.repeat(300_001) }).success).toBe(false)
    expect(RenderCodeVideoInputSchema.safeParse({ ...base, durationMs: 60_001 }).success).toBe(false)
    expect(RenderCodeVideoInputSchema.safeParse({ ...base, durationMs: 999 }).success).toBe(false)
    expect(RenderCodeVideoInputSchema.safeParse({ ...base, fps: 60 }).success).toBe(false)
  })
})
