import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fixedClock } from '../src/time'
import {
  ALLOWED_MIME,
  BrandInputSchema,
  ClipRangeSchema,
  ClipRequestSchema,
  MAX_CLIP_RANGES,
  DraftInputSchema,
  DriveLinkInputSchema,
  EditVariantInputSchema,
  GetAnalyticsInputSchema,
  GetTranscriptInputSchema,
  IdSchema,
  ImportPastPostsInputSchema,
  PlatformOptionsSchemas,
  PostStatusInputSchema,
  RenderCarouselInputSchema,
  RenderVideoInputSchema,
  SaveVoiceProfileInputSchema,
  TimestampMsSchema,
  TimezoneSchema,
  UploadRequestSchema,
  UpsertVariantInputSchema,
  VariantInputSchema,
  VoiceProfileSchema,
  cleanText,
  createScheduleInputSchema,
  mediaKindForMime,
  validateClipRanges,
} from '../src/validation'

const BRAND = '0b8d3b5e-3f4c-4a7e-9a0b-1c2d3e4f5a6b'
const DRAFT = '1b8d3b5e-3f4c-4a7e-9a0b-1c2d3e4f5a6b'
const MEDIA = '2b8d3b5e-3f4c-4a7e-9a0b-1c2d3e4f5a6b'

const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`)

describe('primitives', () => {
  it('IdSchema accepts any hex UUID and lower-cases it', () => {
    expect(IdSchema.parse(' 11111111-1111-1111-1111-11111111111A ')).toBe('11111111-1111-1111-1111-11111111111a')
    expect(IdSchema.safeParse('not-a-uuid').success).toBe(false)
    expect(IdSchema.safeParse("1'; drop table users; --").success).toBe(false)
  })

  it('cleanText normalises newlines and strips control characters', () => {
    expect(cleanText('a\r\nb\rc\u0000d\u0007e\tf')).toBe('a\nb\ncde\tf')
  })

  it('TimezoneSchema accepts IANA zones only', () => {
    expect(TimezoneSchema.safeParse('Europe/Berlin').success).toBe(true)
    expect(TimezoneSchema.safeParse('Mars/Olympus').success).toBe(false)
  })
})

describe('variants and drafts', () => {
  it('parses a per-platform variant with defaults', () => {
    const v = VariantInputSchema.parse({ platform: 'tiktok', text: 'hi\r\n', options: { privacyLevel: 'SELF_ONLY' } })
    expect(v).toEqual({ platform: 'tiktok', text: 'hi\n', mediaIds: [], options: { privacyLevel: 'SELF_ONLY' } })
    const x = VariantInputSchema.parse({ platform: 'x' })
    expect(x).toEqual({ platform: 'x', text: '', mediaIds: [], options: {} })
  })

  it('rejects unknown platforms, unknown keys and other platforms’ options', () => {
    expect(VariantInputSchema.safeParse({ platform: 'myspace', text: 'hi' }).success).toBe(false)
    expect(VariantInputSchema.safeParse({ platform: 'x', text: 'hi', extra: 1 }).success).toBe(false)
    expect(VariantInputSchema.safeParse({ platform: 'x', text: 'hi', options: { privacyLevel: 'SELF_ONLY' } }).success).toBe(
      false,
    )
  })

  it('rejects duplicate media ids and too many media', () => {
    expect(VariantInputSchema.safeParse({ platform: 'x', text: 'a', mediaIds: [MEDIA, MEDIA] }).success).toBe(false)
    const many = Array.from({ length: 36 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`)
    expect(VariantInputSchema.safeParse({ platform: 'tiktok', text: 'a', mediaIds: many }).success).toBe(false)
  })

  it('validates option values', () => {
    expect(PlatformOptionsSchemas.threads.safeParse({ topicTag: 'a.b' }).success).toBe(false)
    expect(PlatformOptionsSchemas.threads.safeParse({ topicTag: 'ai tools' }).success).toBe(true)
    expect(PlatformOptionsSchemas.youtube.safeParse({ tags: ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100), 'e'.repeat(100)] }).success).toBe(false)
    expect(PlatformOptionsSchemas.youtube.safeParse({ tags: ['one', 'two words'] }).success).toBe(true)
    expect(PlatformOptionsSchemas.pinterest.safeParse({ link: 'http://insecure.example.com' }).success).toBe(false)
    expect(PlatformOptionsSchemas.pinterest.safeParse({ link: 'https://example.com/p' }).success).toBe(true)
    expect(PlatformOptionsSchemas.bluesky.safeParse({ langs: ['en', 'pt-BR'] }).success).toBe(true)
    expect(PlatformOptionsSchemas.bluesky.safeParse({ langs: ['en', 'de', 'fr', 'es'] }).success).toBe(false)
    expect(PlatformOptionsSchemas.instagram.safeParse({ collaborators: ['@a', 'b.c'] }).success).toBe(true)
    expect(PlatformOptionsSchemas.instagram.safeParse({ collaborators: ['bad handle!'] }).success).toBe(false)
  })

  it('accepts a valid multi-platform draft', () => {
    const r = DraftInputSchema.safeParse({
      brandId: BRAND,
      variants: [
        { platform: 'x', text: 'Short and sweet' },
        { platform: 'linkedin', text: 'Longer post with a link: https://example.com' },
        { platform: 'tiktok', text: 'caption', mediaIds: [MEDIA] },
      ],
      notes: 'from the AI',
    })
    expect(messages(r)).toEqual([])
  })

  it('runs platform rules inside the schema (errors only)', () => {
    const r = DraftInputSchema.safeParse({
      brandId: BRAND,
      variants: [
        { platform: 'x', text: 'a'.repeat(300) },
        { platform: 'x', text: 'dup' },
        { platform: 'instagram', text: 'no media yet is only a warning' },
        { platform: 'youtube', text: 'desc', mediaIds: [MEDIA] },
      ],
    })
    expect(messages(r)).toEqual([
      expect.stringMatching(/^variants\.0\.text: x: Text is 300/),
      'variants.1.platform: Only one x variant per draft.',
      'variants.3.title: youtube: A title is required.',
    ])
  })

  it('requires at least one variant and a brand id', () => {
    expect(DraftInputSchema.safeParse({ brandId: BRAND, variants: [] }).success).toBe(false)
    expect(DraftInputSchema.safeParse({ variants: [{ platform: 'x', text: 'a' }] }).success).toBe(false)
  })

  it('UpsertVariantInputSchema validates the variant', () => {
    expect(UpsertVariantInputSchema.safeParse({ draftId: DRAFT, variant: { platform: 'x', text: 'ok' } }).success).toBe(true)
    expect(
      messages(UpsertVariantInputSchema.safeParse({ draftId: DRAFT, variant: { platform: 'x', text: 'see example.com' } })),
    ).toEqual([expect.stringMatching(/^variant\.text: x: Links are not supported/)])
  })

  it('EditVariantInputSchema checks only the edited fields', () => {
    expect(EditVariantInputSchema.safeParse({ draftId: DRAFT, platform: 'youtube', text: 'new description' }).success).toBe(
      true,
    )
    expect(EditVariantInputSchema.safeParse({ draftId: DRAFT, platform: 'x' }).success).toBe(false)
    expect(messages(EditVariantInputSchema.safeParse({ draftId: DRAFT, platform: 'x', text: 'a'.repeat(281) }))).toEqual([
      expect.stringMatching(/^text: Text is 281/),
    ])
    expect(EditVariantInputSchema.safeParse({ draftId: DRAFT, platform: 'youtube', title: 'a <b>' }).success).toBe(false)
  })
})

describe('scheduling', () => {
  const clock = fixedClock('2026-11-01T12:00:00Z')
  const Schedule = createScheduleInputSchema(clock)

  it('normalises a future time to UTC', () => {
    const r = Schedule.parse({ draftId: DRAFT, at: '2026-11-02T09:30:00+01:00' })
    expect(r.at).toBe('2026-11-02T08:30:00.000Z')
  })

  it('accepts "now"', () => {
    expect(Schedule.parse({ draftId: DRAFT, at: 'now' }).at).toBe('2026-11-01T12:00:00.000Z')
  })

  it('rejects past times, times beyond 120 days and local times without offset', () => {
    expect(messages(Schedule.safeParse({ draftId: DRAFT, at: '2026-11-01T11:59:59Z' }))[0]).toMatch(/in the past/)
    expect(Schedule.safeParse({ draftId: DRAFT, at: '2027-03-01T12:00:00Z' }).success).toBe(true)
    expect(messages(Schedule.safeParse({ draftId: DRAFT, at: '2027-03-02T12:00:01Z' }))[0]).toMatch(/120 days/)
    expect(Schedule.safeParse({ draftId: DRAFT, at: '2026-11-02T09:30:00' }).success).toBe(false)
    expect(Schedule.safeParse({ draftId: DRAFT, at: 'tomorrow' }).success).toBe(false)
  })

  it('validates the optional platform list', () => {
    expect(Schedule.safeParse({ draftId: DRAFT, at: 'now', platforms: ['x', 'x'] }).success).toBe(false)
    expect(Schedule.safeParse({ draftId: DRAFT, at: 'now', platforms: ['x', 'threads'] }).success).toBe(true)
  })

  it('post status needs exactly one id', () => {
    expect(PostStatusInputSchema.safeParse({ postId: DRAFT }).success).toBe(true)
    expect(PostStatusInputSchema.safeParse({}).success).toBe(false)
    expect(PostStatusInputSchema.safeParse({ postId: DRAFT, draftId: DRAFT }).success).toBe(false)
  })
})

describe('clips', () => {
  it('accepts ms numbers and timestamp strings', () => {
    expect(TimestampMsSchema.parse(1234.6)).toBe(1235)
    expect(TimestampMsSchema.parse('01:02.5')).toBe(62_500)
    expect(TimestampMsSchema.safeParse('soon').success).toBe(false)
    expect(TimestampMsSchema.safeParse(-1).success).toBe(false)
    expect(TimestampMsSchema.safeParse(5 * 3600 * 1000).success).toBe(false)
  })

  it('enforces 3 s ≤ length ≤ 180 s and end after start', () => {
    expect(ClipRangeSchema.safeParse({ startMs: 0, endMs: 3_000 }).success).toBe(true)
    expect(ClipRangeSchema.safeParse({ startMs: '0:10', endMs: '3:10' }).success).toBe(true)
    expect(messages(ClipRangeSchema.safeParse({ startMs: 5_000, endMs: 5_000 }))).toEqual(['endMs: endMs must be after startMs.'])
    expect(messages(ClipRangeSchema.safeParse({ startMs: 0, endMs: 2_999 }))[0]).toMatch(/at least 3 s/)
    expect(messages(ClipRangeSchema.safeParse({ startMs: 0, endMs: 180_001 }))[0]).toMatch(/at most 180 s/)
  })

  it('clip requests: 1–20 ranges, optional brand, caption style default', () => {
    const r = ClipRequestSchema.parse({ mediaId: MEDIA, ranges: [{ startMs: 0, endMs: 30_000, title: ' Hook\nline ' }] })
    expect(r.captionStyle).toBe('bold')
    expect(r.ranges[0]?.title).toBe('Hook line')
    expect(r.brandId).toBeUndefined()
    expect(ClipRequestSchema.parse({ mediaId: MEDIA, brandId: MEDIA.toUpperCase(), ranges: [{ startMs: 0, endMs: 5000 }] }).brandId).toBe(MEDIA)
    expect(ClipRequestSchema.safeParse({ mediaId: MEDIA, ranges: [] }).success).toBe(false)
    const twenty = Array.from({ length: MAX_CLIP_RANGES }, () => ({ startMs: 0, endMs: 10_000 }))
    expect(MAX_CLIP_RANGES).toBe(20)
    expect(ClipRequestSchema.safeParse({ mediaId: MEDIA, ranges: twenty }).success).toBe(true)
    const many = Array.from({ length: 21 }, () => ({ startMs: 0, endMs: 10_000 }))
    const tooMany = ClipRequestSchema.safeParse({ mediaId: MEDIA, ranges: many })
    expect(tooMany.success).toBe(false)
    expect(tooMany.error?.issues[0]?.message).toMatch(/at most 20 clips/)
    expect(ClipRequestSchema.safeParse({ mediaId: MEDIA, ranges: [{ startMs: 0, endMs: 5000 }], captionStyle: 'comic' }).success).toBe(false)
  })

  it('checks ranges against the source duration', () => {
    expect(
      validateClipRanges(
        [
          { startMs: 0, endMs: 10_000 },
          { startMs: 55_000, endMs: 65_000 },
          { startMs: 60_000, endMs: 70_000 },
        ],
        60_000,
      ),
    ).toEqual([
      { index: 1, message: 'Ends after the end of the video (60000 ms).' },
      { index: 2, message: 'Starts after the end of the video (60000 ms).' },
    ])
  })

  it('transcript queries', () => {
    expect(GetTranscriptInputSchema.safeParse({ mediaId: MEDIA, startMs: 0, endMs: 1000 }).success).toBe(true)
    expect(GetTranscriptInputSchema.safeParse({ mediaId: MEDIA, startMs: 1000, endMs: 10 }).success).toBe(false)
  })
})

describe('uploads and drive links', () => {
  it('maps MIME types to kinds and never accepts SVG', () => {
    expect(mediaKindForMime('VIDEO/MP4')).toBe('video')
    expect(mediaKindForMime('image/svg+xml')).toBeNull()
    expect(Object.values(ALLOWED_MIME).flat()).not.toContain('image/svg+xml')
  })

  it('validates upload requests', () => {
    const ok = UploadRequestSchema.parse({ filename: 'talk.mp4', contentType: 'video/mp4', bytes: 1_000, rightsAttested: true })
    expect(ok.rightsAttested).toBe(true)
    expect(UploadRequestSchema.safeParse({ filename: '../etc/passwd', contentType: 'video/mp4', bytes: 1 }).success).toBe(false)
    expect(UploadRequestSchema.safeParse({ filename: 'a.svg', contentType: 'image/svg+xml', bytes: 1 }).success).toBe(false)
    expect(UploadRequestSchema.safeParse({ filename: 'a.png', contentType: 'image/png', bytes: 30_000_000 }).success).toBe(false)
    expect(UploadRequestSchema.safeParse({ filename: 'a.mp4', contentType: 'video/mp4', bytes: 11_000_000_000 }).success).toBe(false)
  })

  it('drive links require the rights attestation', () => {
    expect(DriveLinkInputSchema.safeParse({ url: 'https://drive.google.com/x', rightsAttested: true }).success).toBe(true)
    expect(messages(DriveLinkInputSchema.safeParse({ url: 'https://drive.google.com/x', rightsAttested: false }))).toEqual([
      'rightsAttested: Confirm that you own this video or have the rights to use it.',
    ])
  })
})

describe('voice profiles', () => {
  it('fills defaults and cleans lists', () => {
    const p = VoiceProfileSchema.parse({ tone: 'warm, direct', vocabulary: [' ship it '], sample_posts: [{ text: 'Hello' }] })
    expect(p).toEqual({
      tone: 'warm, direct',
      audience: '',
      vocabulary: ['ship it'],
      do: [],
      dont: [],
      emoji_policy: 'sparing',
      hashtag_policy: 'few',
      sample_posts: [{ text: 'Hello' }],
    })
  })

  it('rejects unknown keys, empty samples and oversized lists', () => {
    expect(VoiceProfileSchema.safeParse({ tone: 'x', mood: 'y' }).success).toBe(false)
    expect(VoiceProfileSchema.safeParse({ sample_posts: [{ text: '' }] }).success).toBe(false)
    expect(VoiceProfileSchema.safeParse({ do: Array.from({ length: 31 }, () => 'x') }).success).toBe(false)
  })

  it('save input defaults the source to manual', () => {
    expect(SaveVoiceProfileInputSchema.parse({ brandId: BRAND, profile: {} }).source).toBe('manual')
  })
})

describe('render requests', () => {
  it('carousel: 1–20 slides with content, theme colours validated', () => {
    const r = RenderCarouselInputSchema.parse({ brandId: BRAND, slides: [{ heading: 'One' }] })
    expect(r).toMatchObject({ template: 'minimal', aspect: '4:5' })
    expect(RenderCarouselInputSchema.safeParse({ brandId: BRAND, slides: [{}] }).success).toBe(false)
    expect(
      RenderCarouselInputSchema.safeParse({ brandId: BRAND, slides: [{ body: 'x' }], theme: { background: 'red' } }).success,
    ).toBe(false)
    expect(
      RenderCarouselInputSchema.safeParse({ brandId: BRAND, slides: [{ body: 'x' }], imageUrl: 'https://evil' }).success,
    ).toBe(false)
  })

  it('video: total length at most 180 s', () => {
    const slides = Array.from({ length: 12 }, () => ({ text: 'x', durationMs: 15_000 }))
    expect(RenderVideoInputSchema.safeParse({ brandId: BRAND, slides }).success).toBe(true)
    const tooLong = [...slides, { text: 'one more' }]
    expect(messages(RenderVideoInputSchema.safeParse({ brandId: BRAND, slides: tooLong }))[0]).toMatch(/at most 180 s/)
    expect(RenderVideoInputSchema.parse({ brandId: BRAND, slides: [{ text: 'a' }] }).slides[0]?.durationMs).toBe(5_000)
  })
})

describe('misc inputs', () => {
  it('brands, imports and analytics', () => {
    expect(BrandInputSchema.parse({ name: '  My Brand ' })).toEqual({ name: 'My Brand', timezone: 'UTC' })
    expect(BrandInputSchema.safeParse({ name: '' }).success).toBe(false)
    expect(ImportPastPostsInputSchema.parse({ brandId: BRAND }).limitPerPlatform).toBe(50)
    expect(GetAnalyticsInputSchema.parse({}).days).toBe(7)
    expect(GetAnalyticsInputSchema.safeParse({ days: 365 }).success).toBe(false)
  })
})

describe('JSON Schema export (MCP tool input schemas use io: "input")', () => {
  it.each([
    ['DraftInputSchema', DraftInputSchema],
    ['UpsertVariantInputSchema', UpsertVariantInputSchema],
    ['EditVariantInputSchema', EditVariantInputSchema],
    ['ScheduleInputSchema', createScheduleInputSchema()],
    ['PostStatusInputSchema', PostStatusInputSchema],
    ['ClipRequestSchema', ClipRequestSchema],
    ['GetTranscriptInputSchema', GetTranscriptInputSchema],
    ['SaveVoiceProfileInputSchema', SaveVoiceProfileInputSchema],
    ['RenderCarouselInputSchema', RenderCarouselInputSchema],
    ['RenderVideoInputSchema', RenderVideoInputSchema],
    ['ImportPastPostsInputSchema', ImportPastPostsInputSchema],
    ['GetAnalyticsInputSchema', GetAnalyticsInputSchema],
    ['DriveLinkInputSchema', DriveLinkInputSchema],
    ['UploadRequestSchema', UploadRequestSchema],
    ['BrandInputSchema', BrandInputSchema],
  ] as const)('%s converts to an object JSON Schema', (_name, schema) => {
    const json = z.toJSONSchema(schema, { io: 'input' }) as { type?: string; properties?: object }
    expect(json.type).toBe('object')
    expect(json.properties).toBeDefined()
  })
})
