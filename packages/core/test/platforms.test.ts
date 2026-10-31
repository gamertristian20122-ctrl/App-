import { describe, expect, it } from 'vitest'
import {
  CAPS_PER_24H,
  PLATFORM_RULES,
  TEXT_ONLY_PLATFORMS,
  X_LONG_TEXT_MAX,
  blockingIssues,
  contentKindFor,
  countHashtags,
  countInBusiestWindow,
  countMentions,
  graphemeCount,
  measureText,
  textLimitsFor,
  utf16Units,
  utf8Bytes,
  validateVariant,
  wouldExceedCap,
  xWeightedLength,
  type MediaFacts,
} from '../src/platforms'
import { PLATFORMS } from '../src/types'

const codes = (issues: { code: string }[]) => issues.map((i) => i.code)
const video = (durationMs: number, bytes = 1_000_000): MediaFacts => ({ kind: 'video', durationMs, bytes })
const image = (bytes = 100_000): MediaFacts => ({ kind: 'image', bytes })
const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`)

describe('counting', () => {
  it('counts graphemes, bytes and UTF-16 units', () => {
    expect(graphemeCount('👨‍👩‍👧‍👦a')).toBe(2)
    expect(graphemeCount('é')).toBe(1)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('👍')).toBe(4)
    expect(utf16Units('👍')).toBe(2)
    expect(measureText('ab', 'graphemes')).toBe(2)
  })

  it.each([
    ['hello', 5],
    ['', 0],
    ['日本語', 6],
    ['👍', 2],
    ['👍🏽', 2],
    ['👨‍👩‍👧‍👦', 2],
    ['🇺🇸', 2],
    ['1️⃣', 2],
    ['café', 4],
    ['café', 4], // NFC → café
    ['—', 1], // U+2014 is in a weight-1 range
    ['™', 2],
    ['Привет', 6], // Cyrillic is below U+10FF
    ['https://example.com/a/very/long/path/that/goes/on/and/on', 23],
    ['see example.com', 4 + 23],
    ['a https://x.org b https://y.org', 23 * 2 + 5],
  ])('X weighted length of %j is %i', (text, expected) => {
    expect(xWeightedLength(text)).toBe(expected)
  })
})

describe('rules table', () => {
  it('covers every platform', () => {
    for (const p of PLATFORMS) {
      expect(PLATFORM_RULES[p].platform).toBe(p)
      expect(PLATFORM_RULES[p].text.length).toBeGreaterThan(0)
      expect(CAPS_PER_24H[p]).toBeGreaterThan(0)
    }
  })

  it('uses the effective caps (lower of platform and Upload-Post)', () => {
    expect(CAPS_PER_24H).toEqual({
      tiktok: 15,
      youtube: 10,
      instagram: 50,
      facebook: 25,
      threads: 50,
      x: 20,
      linkedin: 25,
      pinterest: 20,
      bluesky: 25,
    })
  })

  it('knows which platforms allow text-only posts', () => {
    expect([...TEXT_ONLY_PLATFORMS].sort()).toEqual(['bluesky', 'facebook', 'linkedin', 'threads', 'x'])
  })

  it('X long-text mode raises the limit', () => {
    expect(textLimitsFor('x')[0]?.max).toBe(280)
    expect(textLimitsFor('x', { longTextMode: 'thread' })[0]?.max).toBe(X_LONG_TEXT_MAX)
    expect(textLimitsFor('bluesky')).toHaveLength(2)
  })
})

describe('validateVariant: text', () => {
  it('accepts a normal post on every text platform', () => {
    for (const p of TEXT_ONLY_PLATFORMS) expect(validateVariant(p, { text: 'Hello world' })).toEqual([])
  })

  it('requires text or media', () => {
    expect(codes(validateVariant('x', { text: '   ' }))).toEqual(['text_required'])
    expect(validateVariant('x', { text: '', mediaIds: ['m1'] })).toEqual([])
  })

  it('X: 280 weighted characters', () => {
    expect(validateVariant('x', { text: 'a'.repeat(280) })).toEqual([])
    const [issue] = validateVariant('x', { text: 'a'.repeat(281) })
    expect(issue).toMatchObject({ code: 'text_too_long', severity: 'error', limit: 280, actual: 281, field: 'text' })
    expect(issue?.message).toContain('longTextMode')
    expect(validateVariant('x', { text: '日'.repeat(141) })[0]?.actual).toBe(282)
    expect(validateVariant('x', { text: 'a'.repeat(1000), options: { longTextMode: 'thread' } })).toEqual([])
  })

  it('X: links are refused (Upload-Post strips them)', () => {
    const issues = validateVariant('x', { text: 'read more at example.com' })
    expect(codes(issues)).toEqual(['links_not_allowed'])
    expect(codes(validateVariant('x', { text: 'hi', options: { firstComment: 'https://a.co/x' } }))).toEqual([
      'links_not_allowed',
    ])
    expect(validateVariant('linkedin', { text: 'read more at example.com' })).toEqual([])
  })

  it('Bluesky: 300 graphemes and 3000 bytes', () => {
    expect(validateVariant('bluesky', { text: '👍'.repeat(300) })).toEqual([])
    expect(codes(validateVariant('bluesky', { text: '👍'.repeat(301) }))).toEqual(['text_too_long'])
    // 300 graphemes of 11-byte family emoji = 3,300+ bytes
    const fam = '👨‍👩‍👧'.repeat(300)
    const issues = validateVariant('bluesky', { text: fam })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'text_too_long', limit: 3000 })
  })

  it('Threads: 500 UTF-8 bytes and at most 5 links', () => {
    expect(validateVariant('threads', { text: 'a'.repeat(500) })).toEqual([])
    expect(codes(validateVariant('threads', { text: 'é'.repeat(251) }))).toEqual(['text_too_long'])
    const six = Array.from({ length: 6 }, (_, i) => `https://s${i}.com`).join(' ')
    expect(codes(validateVariant('threads', { text: six }))).toEqual(['too_many_links'])
  })

  it('Instagram: hashtags and mentions', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ')
    expect(codes(validateVariant('instagram', { text: tags, mediaIds: ['m'] }))).toEqual(['too_many_hashtags'])
    const mentions = Array.from({ length: 21 }, (_, i) => `@user${i}`).join(' ')
    expect(codes(validateVariant('instagram', { text: mentions, mediaIds: ['m'] }))).toEqual(['too_many_mentions'])
  })

  it('counts hashtags and mentions sensibly', () => {
    expect(countHashtags('#one #two#three #4 a#b #éclair')).toBe(3)
    expect(countMentions('@a @b.c email@x.com')).toBe(2)
  })
})

describe('validateVariant: title', () => {
  it('YouTube requires a title of at most 100 without < or >', () => {
    expect(codes(validateVariant('youtube', { text: '', mediaIds: ['m'] }))).toEqual(['title_required'])
    expect(codes(validateVariant('youtube', { text: '', title: 'x'.repeat(101), mediaIds: ['m'] }))).toEqual([
      'title_too_long',
    ])
    expect(codes(validateVariant('youtube', { text: '', title: 'a <b>', mediaIds: ['m'] }))).toEqual([
      'title_invalid_chars',
    ])
    expect(validateVariant('youtube', { text: 'desc', title: 'Fine', mediaIds: ['m'] })).toEqual([])
  })

  it('warns when a title would be ignored', () => {
    const [issue] = validateVariant('x', { text: 'hi', title: 'Title' })
    expect(issue).toMatchObject({ code: 'title_ignored', severity: 'warning' })
  })

  it('YouTube description is measured in UTF-8 bytes', () => {
    expect(codes(validateVariant('youtube', { text: 'é'.repeat(2501), title: 't', mediaIds: ['m'] }))).toEqual([
      'text_too_long',
    ])
  })
})

describe('validateVariant: media', () => {
  it('media-only platforms warn on drafts and fail at publish', () => {
    const draft = validateVariant('instagram', { text: 'caption' })
    expect(draft).toEqual([expect.objectContaining({ code: 'media_required', severity: 'warning' })])
    const publish = validateVariant('instagram', { text: 'caption' }, { forPublish: true })
    expect(publish).toEqual([expect.objectContaining({ code: 'media_required', severity: 'error' })])
    expect(blockingIssues(draft)).toEqual([])
    expect(blockingIssues(publish)).toHaveLength(1)
  })

  it('caps the number of items', () => {
    expect(codes(validateVariant('x', { text: 'hi', mediaIds: ids(5) }))).toEqual(['too_many_media'])
    expect(codes(validateVariant('pinterest', { text: 'hi', mediaIds: ids(6), options: { boardId: 'b' } }))).toEqual([
      'too_many_media',
    ])
    expect(codes(validateVariant('youtube', { text: '', title: 't', mediaIds: ids(2) }))).toEqual(['too_many_media'])
  })

  it('checks video duration and size', () => {
    const tiktok = { text: 'hi', mediaIds: ['v'], options: { privacyLevel: 'PUBLIC_TO_EVERYONE' } }
    expect(validateVariant('tiktok', tiktok, { media: [video(30_000)] })).toEqual([])
    expect(codes(validateVariant('tiktok', tiktok, { media: [video(2_000)] }))).toEqual(['video_too_short'])
    expect(codes(validateVariant('tiktok', tiktok, { media: [video(601_000)] }))).toEqual(['video_too_long'])
    expect(codes(validateVariant('tiktok', tiktok, { media: [video(30_000, 5e9)] }))).toEqual(['file_too_large'])
  })

  it('Facebook Reels are 3–90 s, other Facebook videos can be long', () => {
    const v = { text: 'hi', mediaIds: ['v'] }
    expect(validateVariant('facebook', v, { media: [video(600_000)] })).toEqual([])
    expect(codes(validateVariant('facebook', { ...v, options: { mediaType: 'REELS' } }, { media: [video(91_000)] }))).toEqual([
      'video_too_long',
    ])
  })

  it('rejects mixed media where unsupported and allows it on Instagram', () => {
    expect(codes(validateVariant('x', { text: 'hi', mediaIds: ['a', 'b'] }, { media: [video(5000), image()] }))).toEqual([
      'mixed_media_not_supported',
    ])
    expect(validateVariant('instagram', { text: 'hi', mediaIds: ['a', 'b'] }, { media: [video(5000), image()] })).toEqual([])
    expect(codes(validateVariant('x', { text: 'hi', mediaIds: ['a', 'b'] }, { media: [video(5000), video(5000)] }))).toEqual([
      'too_many_videos',
    ])
  })

  it('rejects images where unsupported, oversize images and non-visual media', () => {
    expect(codes(validateVariant('youtube', { text: '', title: 't', mediaIds: ['a'] }, { media: [image()] }))).toEqual([
      'media_not_supported',
    ])
    expect(codes(validateVariant('bluesky', { text: 'hi', mediaIds: ['a'] }, { media: [image(2_000_000)] }))).toEqual([
      'file_too_large',
    ])
    expect(codes(validateVariant('x', { text: 'hi', mediaIds: ['a'] }, { media: [{ kind: 'audio' }] }))).toEqual([
      'unsupported_media_kind',
    ])
  })
})

describe('validateVariant: image formats (integration)', () => {
  it('warns (never blocks) when Instagram gets a non-JPEG or TikTok a PNG', () => {
    const png = { kind: 'image' as const, bytes: 1000, mimeType: 'image/png' }
    const jpeg = { kind: 'image' as const, bytes: 1000, mimeType: 'image/jpeg' }
    const ig = validateVariant('instagram', { text: 'hi', mediaIds: ['a'] }, { media: [png] })
    expect(ig.map((i) => [i.code, i.severity])).toEqual([['image_format', 'warning']])
    expect(ig[0]?.message).toMatch(/JPEG images/)
    expect(validateVariant('instagram', { text: 'hi', mediaIds: ['a'] }, { media: [jpeg] })).toEqual([])
    const tt = { text: 'hi', mediaIds: ['a'], options: { privacyLevel: 'PUBLIC_TO_EVERYONE' } }
    expect(codes(validateVariant('tiktok', tt, { media: [png] }))).toEqual(['image_format'])
    expect(validateVariant('tiktok', tt, { media: [{ ...png, mimeType: 'image/webp' }] })).toEqual([])
    // other platforms take PNG; unknown types are not guessed
    expect(validateVariant('x', { text: 'hi', mediaIds: ['a'] }, { media: [png] })).toEqual([])
    expect(validateVariant('instagram', { text: 'hi', mediaIds: ['a'] }, { media: [{ kind: 'image', bytes: 1000 }] })).toEqual([])
  })
})

describe('validateVariant: options', () => {
  it('TikTok needs an explicit privacy level before publishing', () => {
    const v = { text: 'hi', mediaIds: ['v'] }
    expect(validateVariant('tiktok', v)).toEqual([expect.objectContaining({ code: 'option_required', severity: 'warning' })])
    expect(validateVariant('tiktok', v, { forPublish: true })[0]?.severity).toBe('error')
  })

  it('TikTok branded content cannot be private', () => {
    const v = { text: 'hi', mediaIds: ['v'], options: { privacyLevel: 'SELF_ONLY', brandContent: true } }
    expect(codes(validateVariant('tiktok', v))).toEqual(['option_invalid'])
  })

  it('Pinterest needs a board before publishing and has no first comment', () => {
    expect(codes(validateVariant('pinterest', { text: 'hi', mediaIds: ['i'] }))).toEqual(['option_required'])
    expect(
      codes(validateVariant('pinterest', { text: 'hi', mediaIds: ['i'], options: { boardId: 'b', firstComment: 'x' } })),
    ).toEqual(['first_comment_not_supported'])
  })

  it('first comments follow the body limit', () => {
    expect(codes(validateVariant('threads', { text: 'hi', options: { firstComment: 'a'.repeat(501) } }))).toEqual([
      'first_comment_too_long',
    ])
  })
})

describe('caps', () => {
  const at = new Date('2026-06-01T12:00:00Z')
  const h = (hours: number) => new Date(at.getTime() + hours * 3_600_000)

  it('counts the new post plus existing posts in the busiest window containing it', () => {
    expect(countInBusiestWindow([], at)).toBe(1)
    expect(countInBusiestWindow([h(-23), h(-1)], at)).toBe(3)
    expect(countInBusiestWindow([h(-25), h(25)], at)).toBe(1)
    // posts 20h before and 20h after are never in the same 24h window
    expect(countInBusiestWindow([h(-20), h(20)], at)).toBe(2)
    expect(countInBusiestWindow([h(-20), h(-10), h(10), h(20)], at)).toBe(3)
  })

  it('also counts the window that starts at the new post (posts right after it)', () => {
    // regression: only window starts at or before existing posts were tried, so a burst right
    // after `at` with nothing before it was counted as 1
    expect(countInBusiestWindow([h(1), h(2), h(3)], at)).toBe(4)
    expect(countInBusiestWindow([h(-30), h(5), h(23.9)], at)).toBe(3)
    const fifteenAfter = Array.from({ length: 15 }, (_, i) => h(i + 1))
    expect(wouldExceedCap('tiktok', fifteenAfter, at)).toBe(true)
    expect(wouldExceedCap('tiktok', fifteenAfter.slice(1), at)).toBe(false)
  })

  it('wouldExceedCap uses the platform cap', () => {
    const fourteen = Array.from({ length: 14 }, (_, i) => h(-i - 1))
    expect(wouldExceedCap('tiktok', fourteen, at)).toBe(false)
    expect(wouldExceedCap('tiktok', [...fourteen, h(1)], at)).toBe(true)
    expect(wouldExceedCap('instagram', [...fourteen, h(1)], at)).toBe(false)
  })
})

describe('contentKindFor', () => {
  it('picks text, video or photos', () => {
    expect(contentKindFor([])).toBe('text')
    expect(contentKindFor([{ kind: 'video' }])).toBe('video')
    expect(contentKindFor([{ kind: 'image' }, { kind: 'image' }])).toBe('photos')
    expect(contentKindFor([{ kind: 'video' }, { kind: 'image' }])).toBe('photos')
  })
})
