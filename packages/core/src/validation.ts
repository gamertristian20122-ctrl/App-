// Zod schemas shared by the MCP server and the web app. Everything an AI (or a browser) sends us
// is parsed with one of these before we act on it. Object schemas are strict: unknown keys fail.

import { z } from 'zod'
import { HOUR_SECONDS, SOURCE_LIMITS } from './plans'
import { validateVariant } from './platforms'
import type { Clock } from './ports'
import { DAY_MS, parseTimestampToMs, systemClock } from './time'
import type { Platform } from './types'
import { MEDIA_KINDS, PLATFORM_LABELS, PLATFORMS, PlatformSchema, DraftStatusSchema, TimedTextSchema, VOICE_PROFILE_SOURCES } from './types'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Any 8-4-4-4-12 hex id (Postgres uuid). Lower-cased. */
export const IdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'Must be a UUID.')
  .transform((s) => s.toLowerCase())

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Normalises user text: CRLF → LF, strips NUL and other control characters (Postgres rejects NUL). */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
}

/** Free text with a hard size cap (platform limits are checked separately by validateVariant). */
export const textSchema = (max: number) => z.string().max(max).transform(cleanText)

/** A single-line label: trimmed, no line breaks. */
export const lineSchema = (min: number, max: number) =>
  z
    .string()
    .transform((s) => cleanText(s).replace(/\s*\n\s*/g, ' ').trim())
    .pipe(z.string().min(min).max(max))

export const TimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }, 'Must be an IANA time zone such as "America/New_York".')

export const HttpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s)
      return u.protocol === 'https:' && u.username === '' && u.password === ''
    } catch {
      return false
    }
  }, 'Must be an https:// URL.')

export const PaginationSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
})

// ---------------------------------------------------------------------------
// Per-platform options (camelCase; the posting adapter maps them to provider fields)
// ---------------------------------------------------------------------------

const firstComment = textSchema(10_000).optional()
const handle = z.string().regex(/^@?[A-Za-z0-9._]{1,30}$/, 'Must be an account handle.')

export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number]

/**
 * How the approval UIs name TikTok's privacy levels. TikTok requires the person to pick one
 * explicitly (no default), so every approval surface offers this choice.
 */
export const TIKTOK_PRIVACY_LABELS: Readonly<Record<TikTokPrivacyLevel, string>> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (followers you follow back)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
}

/** The message for an edit that changes nothing (approval card, web queue, services). */
export const EMPTY_EDIT_MESSAGE = 'Change the text, the title or who can see the TikTok post.'

export const PlatformOptionsSchemas = {
  tiktok: z.strictObject({
    privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS).optional(),
    disableComment: z.boolean().optional(),
    disableDuet: z.boolean().optional(),
    disableStitch: z.boolean().optional(),
    brandContent: z.boolean().optional(),
    brandOrganic: z.boolean().optional(),
    isAiGenerated: z.boolean().optional(),
    coverTimestampMs: z.number().int().min(0).optional(),
    firstComment,
  }),
  youtube: z.strictObject({
    privacyStatus: z.enum(['public', 'unlisted', 'private']).optional(),
    tags: z
      .array(z.string().trim().min(1).max(100))
      .max(50)
      .optional()
      .refine(
        (tags) =>
          !tags ||
          tags.reduce((sum, t) => sum + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1) <=
            500,
        'Tags may total at most 500 characters (commas and quotes count).',
      ),
    categoryId: z.string().regex(/^\d{1,3}$/).optional(),
    madeForKids: z.boolean().optional(),
    containsSyntheticMedia: z.boolean().optional(),
    playlistId: z.string().regex(/^[A-Za-z0-9_-]{2,64}$/).optional(),
    firstComment,
  }),
  instagram: z.strictObject({
    mediaType: z.enum(['REELS', 'STORIES']).optional(),
    shareToFeed: z.boolean().optional(),
    collaborators: z.array(handle).max(3).optional(),
    thumbOffsetMs: z.number().int().min(0).optional(),
    locationId: z.string().regex(/^\d{1,30}$/).optional(),
    firstComment,
  }),
  facebook: z.strictObject({
    mediaType: z.enum(['REELS', 'STORIES', 'VIDEO']).optional(),
    pageId: z.string().regex(/^\d{1,30}$/).optional(),
    firstComment,
  }),
  threads: z.strictObject({
    topicTag: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .refine((t) => !/[.&]/.test(t), 'Topic tags may not contain "." or "&".')
      .optional(),
    replyControl: z.enum(['everyone', 'accounts_you_follow', 'mentioned_only']).optional(),
    firstComment,
  }),
  x: z.strictObject({
    /** Text over 280: "thread" splits it into a thread; "single_post" needs X Premium. */
    longTextMode: z.enum(['thread', 'single_post']).optional(),
    replySettings: z.enum(['everyone', 'following', 'mentionedUsers']).optional(),
    firstComment,
  }),
  linkedin: z.strictObject({
    visibility: z.enum(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN']).optional(),
    pageId: z.string().regex(/^\d{1,30}$/).optional(),
    firstComment,
  }),
  pinterest: z.strictObject({
    boardId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    link: HttpsUrlSchema.optional(),
    altText: textSchema(500).optional(),
  }),
  bluesky: z.strictObject({
    altText: textSchema(2_000).optional(),
    langs: z
      .array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Must be a language code such as "en".'))
      .max(3)
      .optional(),
    firstComment,
  }),
} as const satisfies Record<Platform, z.ZodType>

export type PlatformOptions<P extends Platform> = z.output<(typeof PlatformOptionsSchemas)[P]>

type OptionKey<P extends Platform> = keyof z.input<(typeof PlatformOptionsSchemas)[P]> & string

/**
 * How the approval surfaces (card, /approve page, web queue) name every publishable option. The
 * type forces a label for every key of every options schema, so a new option cannot ship without
 * being shown to the person who approves it.
 */
export const PLATFORM_OPTION_LABELS: { readonly [P in Platform]: Readonly<Record<OptionKey<P>, string>> } = {
  tiktok: {
    privacyLevel: 'Who can see',
    disableComment: 'Comments off',
    disableDuet: 'Duets off',
    disableStitch: 'Stitches off',
    brandContent: 'Paid partnership (branded content)',
    brandOrganic: 'Promotes own brand',
    isAiGenerated: 'Labelled AI-generated',
    coverTimestampMs: 'Cover frame at',
    firstComment: 'First comment',
  },
  youtube: {
    privacyStatus: 'Visibility',
    tags: 'Tags',
    categoryId: 'Category id',
    madeForKids: 'Made for kids',
    containsSyntheticMedia: 'Contains synthetic media',
    playlistId: 'Add to playlist',
    firstComment: 'First comment',
  },
  instagram: {
    mediaType: 'Post as',
    shareToFeed: 'Also share to feed',
    collaborators: 'Collaborators (invited)',
    thumbOffsetMs: 'Cover frame at',
    locationId: 'Location id',
    firstComment: 'First comment',
  },
  facebook: {
    mediaType: 'Post as',
    pageId: 'Facebook page id',
    firstComment: 'First comment',
  },
  threads: {
    topicTag: 'Topic tag',
    replyControl: 'Who can reply',
    firstComment: 'First comment',
  },
  x: {
    longTextMode: 'Long text',
    replySettings: 'Who can reply',
    firstComment: 'First comment',
  },
  linkedin: {
    visibility: 'Visibility',
    pageId: 'Company page id',
    firstComment: 'First comment',
  },
  pinterest: {
    boardId: 'Board id',
    link: 'Pin link',
    altText: 'Alt text',
  },
  bluesky: {
    altText: 'Alt text',
    langs: 'Languages',
    firstComment: 'First comment',
  },
}

/** One option of a variant as the approval surfaces show it. */
export interface OptionLine {
  key: string
  label: string
  value: string
}

function optionValueText(platform: Platform, key: string, value: unknown): string {
  if (platform === 'tiktok' && key === 'privacyLevel' && typeof value === 'string' && value in TIKTOK_PRIVACY_LABELS) {
    return TIKTOK_PRIVACY_LABELS[value as TikTokPrivacyLevel]
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number' && key.endsWith('Ms')) return `${(value / 1000).toFixed(1)} s`
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) return value.join(', ')
  return JSON.stringify(value) ?? String(value)
}

/**
 * Every option a variant publishes with, as label/value lines (labels from
 * PLATFORM_OPTION_LABELS; unknown keys, e.g. from older rows, are shown by name so nothing that
 * gets published is ever hidden). Unset (undefined/null) options are skipped.
 */
export function describeOptions(platform: Platform, options: Readonly<Record<string, unknown>> | null | undefined): OptionLine[] {
  if (!options) return []
  const labels = PLATFORM_OPTION_LABELS[platform] as Readonly<Record<string, string>>
  const known = Object.keys(labels)
  const keys = [...known.filter((k) => k in options), ...Object.keys(options).filter((k) => !known.includes(k)).sort()]
  const lines: OptionLine[] = []
  for (const key of keys) {
    const value = options[key]
    if (value === undefined || value === null) continue
    lines.push({ key, label: labels[key] ?? key, value: optionValueText(platform, key, value) })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** Hard caps before platform rules (which validateVariant checks). */
export const MAX_POST_TEXT = 70_000
export const MAX_TITLE = 500
export const MAX_MEDIA_PER_VARIANT = 35

const mediaIds = z
  .array(IdSchema)
  .max(MAX_MEDIA_PER_VARIANT)
  .default([])
  .refine((ids) => new Set(ids).size === ids.length, 'Each media item may appear once.')

function variantSchema<P extends Platform, O extends z.ZodType>(platform: P, options: O) {
  return z.strictObject({
    platform: z.literal(platform),
    text: textSchema(MAX_POST_TEXT).default(''),
    title: lineSchema(0, MAX_TITLE).optional(),
    mediaIds,
    connectedAccountId: IdSchema.optional(),
    // every options schema has only optional keys, so {} is a valid default
    options: options.default({} as never),
  })
}

export const VariantInputSchema = z.discriminatedUnion('platform', [
  variantSchema('tiktok', PlatformOptionsSchemas.tiktok),
  variantSchema('youtube', PlatformOptionsSchemas.youtube),
  variantSchema('instagram', PlatformOptionsSchemas.instagram),
  variantSchema('facebook', PlatformOptionsSchemas.facebook),
  variantSchema('threads', PlatformOptionsSchemas.threads),
  variantSchema('x', PlatformOptionsSchemas.x),
  variantSchema('linkedin', PlatformOptionsSchemas.linkedin),
  variantSchema('pinterest', PlatformOptionsSchemas.pinterest),
  variantSchema('bluesky', PlatformOptionsSchemas.bluesky),
])
export type VariantInput = z.output<typeof VariantInputSchema>

/** Adds validateVariant() errors (not warnings) as zod issues under `path`. */
function refineVariant(variant: VariantInput, ctx: z.RefinementCtx, path: (string | number)[]): void {
  for (const issue of validateVariant(variant.platform, variant)) {
    if (issue.severity !== 'error') continue
    ctx.addIssue({ code: 'custom', path: [...path, issue.field], message: `${PLATFORM_LABELS[variant.platform]}: ${issue.message}` })
  }
}

export const DraftInputSchema = z
  .strictObject({
    brandId: IdSchema,
    variants: z.array(VariantInputSchema).min(1).max(PLATFORMS.length),
    notes: textSchema(2_000).optional(),
    sourceClipId: IdSchema.optional(),
  })
  .superRefine((draft, ctx) => {
    const seen = new Set<Platform>()
    draft.variants.forEach((v, i) => {
      if (seen.has(v.platform)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', i, 'platform'],
          message: `Only one ${PLATFORM_LABELS[v.platform]} variant per draft.`,
        })
      }
      seen.add(v.platform)
      refineVariant(v, ctx, ['variants', i])
    })
  })
export type DraftInput = z.output<typeof DraftInputSchema>

/** Replace one variant of an existing draft (adds it when the platform is new). */
export const UpsertVariantInputSchema = z
  .strictObject({ draftId: IdSchema, variant: VariantInputSchema })
  .superRefine((input, ctx) => refineVariant(input.variant, ctx, ['variant']))
export type UpsertVariantInput = z.output<typeof UpsertVariantInputSchema>

/**
 * Quick edit from the approval card / web queue: the text and/or title of one variant, and for
 * TikTok who can see the post (privacyLevel, which TikTok requires the person to choose; drafts
 * made by the worker from clips and renders arrive without it).
 */
export const EditVariantInputSchema = z
  .strictObject({
    draftId: IdSchema,
    platform: PlatformSchema,
    text: textSchema(MAX_POST_TEXT).optional(),
    title: lineSchema(0, MAX_TITLE).optional(),
    privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS).optional(),
  })
  .refine((v) => v.text !== undefined || v.title !== undefined || v.privacyLevel !== undefined, EMPTY_EDIT_MESSAGE)
  .superRefine((v, ctx) => {
    if (v.privacyLevel !== undefined && v.platform !== 'tiktok') {
      ctx.addIssue({ code: 'custom', path: ['privacyLevel'], message: 'privacyLevel can only be set on the TikTok variant.' })
    }
    const edited = new Set<string>()
    if (v.text !== undefined) edited.add('text')
    if (v.title !== undefined) edited.add('title')
    // mediaIds: assume media exists so an empty caption on a video post is not flagged here
    for (const issue of validateVariant(v.platform, { text: v.text ?? '', title: v.title, mediaIds: ['media'] })) {
      if (issue.severity === 'error' && edited.has(issue.field)) {
        ctx.addIssue({ code: 'custom', path: [issue.field], message: issue.message })
      }
    }
  })
export type EditVariantInput = z.output<typeof EditVariantInputSchema>

export const ListDraftsInputSchema = z.strictObject({
  brandId: IdSchema.optional(),
  status: DraftStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
})

export const DraftRefSchema = z.strictObject({ draftId: IdSchema })

export const RejectDraftInputSchema = z.strictObject({
  draftId: IdSchema,
  reason: textSchema(500).optional(),
})

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export const SCHEDULE_MAX_DAYS = 120

/**
 * An ISO 8601 timestamp with an explicit offset ("2026-11-02T15:00:00Z" or "...+01:00"), or "now".
 * Must not be in the past and at most SCHEDULE_MAX_DAYS ahead. Output: normalised UTC ISO string.
 */
export function createScheduleAtSchema(clock: Clock = systemClock, maxDays: number = SCHEDULE_MAX_DAYS) {
  return z.union([z.literal('now'), z.iso.datetime({ offset: true })]).transform((value, ctx) => {
    const now = clock.now()
    if (value === 'now') return now.toISOString()
    const at = new Date(value)
    if (Number.isNaN(at.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Not a valid date and time.' })
      return z.NEVER
    }
    if (at.getTime() < now.getTime()) {
      ctx.addIssue({ code: 'custom', message: `That time is in the past (it is now ${now.toISOString()}).` })
      return z.NEVER
    }
    if (at.getTime() > now.getTime() + maxDays * DAY_MS) {
      ctx.addIssue({ code: 'custom', message: `Schedule at most ${maxDays} days ahead.` })
      return z.NEVER
    }
    return at.toISOString()
  })
}

export function createScheduleInputSchema(clock: Clock = systemClock) {
  return z.strictObject({
    draftId: IdSchema,
    at: createScheduleAtSchema(clock),
    /** Defaults to every approved variant of the draft. */
    platforms: z
      .array(PlatformSchema)
      .min(1)
      .max(PLATFORMS.length)
      .refine((p) => new Set(p).size === p.length, 'List each platform once.')
      .optional(),
  })
}
export const ScheduleAtSchema = createScheduleAtSchema()
export const ScheduleInputSchema = createScheduleInputSchema()
export type ScheduleInput = z.output<typeof ScheduleInputSchema>

export const PostStatusInputSchema = z
  .strictObject({ postId: IdSchema.optional(), draftId: IdSchema.optional() })
  .refine((v) => (v.postId === undefined) !== (v.draftId === undefined), 'Give either postId or draftId.')

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export const MIN_CLIP_MS = 3_000
export const MAX_CLIP_MS = 180_000
/** Clips per make_clips request (product limit). */
export const MAX_CLIP_RANGES = 20
export const CAPTION_STYLES = ['bold', 'minimal', 'karaoke', 'none'] as const
export type CaptionStyle = (typeof CAPTION_STYLES)[number]

/** Milliseconds as a number, or a "hh:mm:ss.mmm" / "mm:ss" / "12.5s" string. */
export const TimestampMsSchema = z.union([
  z
    .number()
    .finite()
    .min(0)
    .max(SOURCE_LIMITS.maxDurationMs)
    .transform((n) => Math.round(n)),
  z
    .string()
    .max(20)
    .transform((s, ctx) => {
      const ms = parseTimestampToMs(s)
      if (ms === null || ms > SOURCE_LIMITS.maxDurationMs) {
        ctx.addIssue({ code: 'custom', message: 'Use milliseconds or a timestamp like "01:23.500".' })
        return z.NEVER
      }
      return ms
    }),
])

export const ClipRangeSchema = z
  .strictObject({
    startMs: TimestampMsSchema,
    endMs: TimestampMsSchema,
    title: lineSchema(0, 100).optional(),
    hook: lineSchema(0, 200).optional(),
  })
  .superRefine((r, ctx) => {
    const length = r.endMs - r.startMs
    if (length <= 0) {
      ctx.addIssue({ code: 'custom', path: ['endMs'], message: 'endMs must be after startMs.' })
    } else if (length < MIN_CLIP_MS) {
      ctx.addIssue({ code: 'custom', path: ['endMs'], message: `Clips must be at least ${MIN_CLIP_MS / 1000} s long.` })
    } else if (length > MAX_CLIP_MS) {
      ctx.addIssue({ code: 'custom', path: ['endMs'], message: `Clips may be at most ${MAX_CLIP_MS / 1000} s long.` })
    }
  })
export type ClipRange = z.output<typeof ClipRangeSchema>

export const ClipRequestSchema = z.strictObject({
  mediaId: IdSchema,
  /** The brand the clip drafts are for (default: the source's brand, or the user's only active brand). */
  brandId: IdSchema.optional(),
  ranges: z
    .array(ClipRangeSchema)
    .min(1)
    .max(MAX_CLIP_RANGES, `Ask for at most ${MAX_CLIP_RANGES} clips at a time.`),
  captionStyle: z.enum(CAPTION_STYLES).default('bold'),
})
export type ClipRequest = z.output<typeof ClipRequestSchema>

export interface RangeIssue {
  index: number
  message: string
}

/** Checks ranges against the source duration (known only after ingest). */
export function validateClipRanges(
  ranges: readonly Pick<ClipRange, 'startMs' | 'endMs'>[],
  durationMs: number,
): RangeIssue[] {
  const issues: RangeIssue[] = []
  ranges.forEach((r, index) => {
    if (r.startMs >= durationMs) {
      issues.push({ index, message: `Starts after the end of the video (${durationMs} ms).` })
    } else if (r.endMs > durationMs) {
      issues.push({ index, message: `Ends after the end of the video (${durationMs} ms).` })
    }
  })
  return issues
}

export const GetTranscriptInputSchema = z
  .strictObject({
    mediaId: IdSchema,
    startMs: TimestampMsSchema.optional(),
    endMs: TimestampMsSchema.optional(),
    query: lineSchema(1, 200).optional(),
  })
  .refine((v) => v.startMs === undefined || v.endMs === undefined || v.endMs > v.startMs, {
    message: 'endMs must be after startMs.',
    path: ['endMs'],
  })

export const TranscriptResultSchema = z.strictObject({
  language: z.string().min(2).max(16),
  durationMs: z.number().int().min(0),
  text: z.string(),
  words: z.array(TimedTextSchema),
  segments: z.array(TimedTextSchema),
})

// ---------------------------------------------------------------------------
// Media uploads and source links
// ---------------------------------------------------------------------------

/** Accepted MIME types per media kind. SVG is never accepted. */
export const ALLOWED_MIME = {
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'],
  captions: ['text/vtt', 'application/x-subrip'],
} as const satisfies Record<(typeof MEDIA_KINDS)[number], readonly string[]>

export const MAX_UPLOAD_BYTES = {
  video: SOURCE_LIMITS.maxBytes,
  image: 20_000_000,
  audio: 500_000_000,
  captions: 2_000_000,
} as const

export function mediaKindForMime(mime: string): (typeof MEDIA_KINDS)[number] | null {
  const m = mime.toLowerCase()
  for (const kind of MEDIA_KINDS) if ((ALLOWED_MIME[kind] as readonly string[]).includes(m)) return kind
  return null
}

export const UploadRequestSchema = z
  .strictObject({
    brandId: IdSchema.optional(),
    filename: lineSchema(1, 255).refine((f) => !/[\\/]/.test(f), 'File name may not contain slashes.'),
    contentType: z
      .string()
      .trim()
      .toLowerCase()
      .refine((m) => mediaKindForMime(m) !== null, 'This file type is not supported.'),
    bytes: z.number().int().min(1),
    /** Required for videos that will be clipped: "I own this content or have the rights to it". */
    rightsAttested: z.boolean().default(false),
  })
  .superRefine((u, ctx) => {
    const kind = mediaKindForMime(u.contentType)
    if (kind && u.bytes > MAX_UPLOAD_BYTES[kind]) {
      ctx.addIssue({
        code: 'custom',
        path: ['bytes'],
        message: `Files of this type may be at most ${MAX_UPLOAD_BYTES[kind].toLocaleString('en-US')} bytes.`,
      })
    }
  })

/** A cloud-drive link to the user's own video. checkSourceUrl() (links.ts) enforces the host policy. */
export const DriveLinkInputSchema = z.strictObject({
  brandId: IdSchema.optional(),
  url: z.string().trim().min(1).max(2048),
  rightsAttested: z.literal(true, { error: 'Confirm that you own this video or have the rights to use it.' }),
})

// ---------------------------------------------------------------------------
// Voice profiles (stored as voice_profiles.profile jsonb; keys are snake_case)
// ---------------------------------------------------------------------------

export const EMOJI_POLICIES = ['none', 'sparing', 'moderate', 'heavy'] as const
export const HASHTAG_POLICIES = ['none', 'few', 'moderate', 'many'] as const

const listOf = (maxItems: number, maxLen: number) => z.array(lineSchema(1, maxLen)).max(maxItems).default([])

export const VoiceProfileSchema = z.strictObject({
  tone: textSchema(500).default(''),
  audience: textSchema(500).default(''),
  /** Words and phrases the brand uses (and how). */
  vocabulary: listOf(100, 80),
  do: listOf(30, 200),
  dont: listOf(30, 200),
  emoji_policy: z.enum(EMOJI_POLICIES).default('sparing'),
  hashtag_policy: z.enum(HASHTAG_POLICIES).default('few'),
  sample_posts: z
    .array(
      z.strictObject({
        platform: PlatformSchema.optional(),
        text: textSchema(5_000).pipe(z.string().min(1)),
      }),
    )
    .max(30)
    .default([]),
})
export type VoiceProfile = z.output<typeof VoiceProfileSchema>

export const SaveVoiceProfileInputSchema = z.strictObject({
  brandId: IdSchema,
  profile: VoiceProfileSchema,
  source: z.enum(VOICE_PROFILE_SOURCES).default('manual'),
})
export type SaveVoiceProfileInput = z.output<typeof SaveVoiceProfileInputSchema>

// ---------------------------------------------------------------------------
// Rendering (template renders, not AI generation). Media only by asset id; no URLs.
// ---------------------------------------------------------------------------

export const RENDER_LIMITS = {
  maxCarouselSlides: 20,
  maxVideoSlides: 35,
  maxVideoMs: 180_000,
  defaultSlideMs: 5_000,
  minSlideMs: 1_000,
  maxSlideMs: 15_000,
} as const

export const FONT_PRESETS = ['sans', 'serif', 'mono', 'rounded', 'condensed'] as const
export const CAROUSEL_TEMPLATES = ['minimal', 'bold', 'quote', 'list', 'photo'] as const
export const VIDEO_TEMPLATES = ['text_slides', 'quote', 'captioned_images'] as const

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like "#1a2b3c".')

export const ThemeSchema = z.strictObject({
  background: HexColorSchema.default('#ffffff'),
  foreground: HexColorSchema.default('#111111'),
  accent: HexColorSchema.default('#4f46e5'),
  font: z.enum(FONT_PRESETS).default('sans'),
})

export const CarouselSlideSchema = z
  .strictObject({
    heading: lineSchema(0, 120).optional(),
    body: textSchema(600).optional(),
    footer: lineSchema(0, 80).optional(),
    imageMediaId: IdSchema.optional(),
  })
  .refine((s) => Boolean(s.heading || s.body || s.imageMediaId), 'Each slide needs a heading, body or image.')

export const RenderCarouselInputSchema = z.strictObject({
  brandId: IdSchema,
  template: z.enum(CAROUSEL_TEMPLATES).default('minimal'),
  aspect: z.enum(['4:5', '1:1', '9:16']).default('4:5'),
  theme: ThemeSchema.optional(),
  slides: z.array(CarouselSlideSchema).min(1).max(RENDER_LIMITS.maxCarouselSlides),
})
export type RenderCarouselInput = z.output<typeof RenderCarouselInputSchema>

export const VideoSlideSchema = z
  .strictObject({
    text: textSchema(300).optional(),
    imageMediaId: IdSchema.optional(),
    durationMs: z
      .number()
      .int()
      .min(RENDER_LIMITS.minSlideMs)
      .max(RENDER_LIMITS.maxSlideMs)
      .default(RENDER_LIMITS.defaultSlideMs),
  })
  .refine((s) => Boolean(s.text || s.imageMediaId), 'Each slide needs text or an image.')

export const RenderVideoInputSchema = z
  .strictObject({
    brandId: IdSchema,
    template: z.enum(VIDEO_TEMPLATES).default('text_slides'),
    aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
    theme: ThemeSchema.optional(),
    slides: z.array(VideoSlideSchema).min(1).max(RENDER_LIMITS.maxVideoSlides),
    audioMediaId: IdSchema.optional(),
    captions: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const total = v.slides.reduce((sum, s) => sum + s.durationMs, 0)
    if (total > RENDER_LIMITS.maxVideoMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['slides'],
        message: `Videos may be at most ${RENDER_LIMITS.maxVideoMs / 1000} s long; these slides add up to ${total / 1000} s.`,
      })
    }
  })
export type RenderVideoInput = z.output<typeof RenderVideoInputSchema>

/** Pixel size of a render for an aspect ratio. */
export const RENDER_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
}

// ---------------------------------------------------------------------------
// Brands, accounts, imports, analytics
// ---------------------------------------------------------------------------

export const BrandInputSchema = z.strictObject({
  name: lineSchema(1, 80),
  timezone: TimezoneSchema.default('UTC'),
})

export const BrandUpdateSchema = z
  .strictObject({ name: lineSchema(1, 80).optional(), timezone: TimezoneSchema.optional() })
  .refine((v) => v.name !== undefined || v.timezone !== undefined, 'Nothing to change.')

export const ConnectAccountInputSchema = z.strictObject({
  brandId: IdSchema,
  platform: PlatformSchema,
})

export const ListAccountsInputSchema = z.strictObject({
  brandId: IdSchema.optional(),
})

export const ImportPastPostsInputSchema = z.strictObject({
  brandId: IdSchema,
  platforms: z
    .array(PlatformSchema)
    .min(1)
    .max(PLATFORMS.length)
    .refine((p) => new Set(p).size === p.length, 'List each platform once.')
    .optional(),
  limitPerPlatform: z.number().int().min(1).max(200).default(50),
})

export const GetAnalyticsInputSchema = z.strictObject({
  brandId: IdSchema.optional(),
  platform: PlatformSchema.optional(),
  days: z.number().int().min(1).max(90).default(7),
})

/** Seconds of source video → whole clipping hours for display. */
export const clipHoursLabel = (seconds: number): string => `${(seconds / HOUR_SECONDS).toFixed(1)} h`
