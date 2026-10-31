// Per-platform rules: text limits (with the right counting unit), media rules, rolling-24h caps,
// and validateVariant(). Sources: docs/research/platform-limits.md and upload-post.md.

import { countUniqueLinks, extractUrls, hasLink } from './links'
import { X_LINK_POSTS_PER_PLAN } from './plans'
import type { MediaKind, Platform } from './types'
import { PLATFORMS } from './types'

// ---------------------------------------------------------------------------
// Counting units
// ---------------------------------------------------------------------------

export type TextUnit = 'utf16' | 'graphemes' | 'utf8_bytes' | 'x_weighted'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const utf8 = new TextEncoder()

/** User-perceived characters (Intl.Segmenter graphemes). Bluesky counts these. */
export function graphemeCount(text: string): number {
  let n = 0
  for (const _ of graphemeSegmenter.segment(text)) n += 1
  return n
}

export function utf8Bytes(text: string): number {
  return utf8.encode(text).length
}

/** JavaScript string length. The safe default for platforms that don't state a unit. */
export function utf16Units(text: string): number {
  return text.length
}

// twitter-text config v3: weight 100 (= 1 char) for these code point ranges, 200 (= 2) otherwise;
// emoji sequences count 2; every URL counts 23 after NFC normalisation.
const X_LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
]
export const X_URL_LENGTH = 23
export const X_MAX_WEIGHTED_LENGTH = 280
/** Long posts (`longTextMode`): a thread, or one long post for Premium accounts. */
export const X_LONG_TEXT_MAX = 25_000

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}|\p{Regional_Indicator}|⃣|️|‍/u

function isEmojiGrapheme(g: string): boolean {
  return EMOJI_RE.test(g) && EMOJI_PRESENTATION_RE.test(g)
}

function xCodePointWeight(cp: number): number {
  for (const [lo, hi] of X_LIGHT_RANGES) if (cp >= lo && cp <= hi) return 1
  return 2
}

function xWeightOfPlainText(text: string): number {
  let weight = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (isEmojiGrapheme(segment)) {
      weight += 2
      continue
    }
    for (const ch of segment) weight += xCodePointWeight(ch.codePointAt(0) ?? 0)
  }
  return weight
}

/** X's weighted length: NFC, URLs count 23, emoji 2, CJK and most non-Latin scripts 2, the rest 1. */
export function xWeightedLength(text: string): number {
  const s = text.normalize('NFC')
  let weight = 0
  let cursor = 0
  for (const url of extractUrls(s)) {
    weight += xWeightOfPlainText(s.slice(cursor, url.start)) + X_URL_LENGTH
    cursor = url.end
  }
  return weight + xWeightOfPlainText(s.slice(cursor))
}

export function measureText(text: string, unit: TextUnit): number {
  switch (unit) {
    case 'utf16':
      return utf16Units(text)
    case 'graphemes':
      return graphemeCount(text)
    case 'utf8_bytes':
      return utf8Bytes(text)
    case 'x_weighted':
      return xWeightedLength(text)
  }
}

const UNIT_LABEL: Readonly<Record<TextUnit, string>> = {
  utf16: 'characters',
  graphemes: 'characters',
  utf8_bytes: 'bytes',
  x_weighted: 'characters (X counts links as 23 and emoji as 2)',
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface TextLimit {
  max: number
  unit: TextUnit
}

export interface TitleRule extends TextLimit {
  required: boolean
  /** Characters the title may not contain. */
  forbidden?: string
}

export interface VideoRule {
  minMs: number
  maxMs: number
  maxBytes: number
}

export interface ImageRule {
  min: number
  max: number
  maxBytes: number
}

export interface PlatformRules {
  platform: Platform
  /** Limits on the post text (caption / description / commentary); all must hold. */
  text: readonly TextLimit[]
  title: TitleRule | null
  /** Whether a text-only post is possible. */
  textOnly: boolean
  /** At most one video per post on every platform. */
  video: VideoRule | null
  image: ImageRule | null
  /** Images and a video together in one carousel. */
  mixedMedia: boolean
  /** Unique links allowed in the text (null = no limit). */
  maxLinks: number | null
  /** Whether links in the text are allowed at all. */
  linksAllowed: boolean
  maxHashtags: number | null
  maxMentions: number | null
  firstComment: boolean
  /** Posts per connected account per rolling 24h that we allow (lower of platform and Upload-Post caps). */
  capPer24h: number
}

const MB = 1_000_000
const GB_BYTES = 1_000_000_000
const SEC = 1_000
const MIN = 60 * SEC
const HOUR = 60 * MIN

export const PLATFORM_RULES: Readonly<Record<Platform, PlatformRules>> = {
  tiktok: {
    platform: 'tiktok',
    text: [{ max: 2_200, unit: 'utf16' }],
    title: { max: 90, unit: 'utf16', required: false },
    textOnly: false,
    video: { minMs: 3 * SEC, maxMs: 10 * MIN, maxBytes: 4 * GB_BYTES },
    image: { min: 1, max: 35, maxBytes: 20 * MB },
    mixedMedia: false,
    maxLinks: null,
    linksAllowed: true,
    maxHashtags: null,
    maxMentions: null,
    firstComment: true,
    capPer24h: 15,
  },
  youtube: {
    platform: 'youtube',
    text: [{ max: 5_000, unit: 'utf8_bytes' }],
    title: { max: 100, unit: 'utf16', required: true, forbidden: '<>' },
    textOnly: false,
    video: { minMs: 1 * SEC, maxMs: 12 * HOUR, maxBytes: 256 * GB_BYTES },
    image: null,
    mixedMedia: false,
    maxLinks: null,
    linksAllowed: true,
    maxHashtags: null,
    maxMentions: null,
    firstComment: true,
    capPer24h: 10,
  },
  instagram: {
    platform: 'instagram',
    text: [{ max: 2_200, unit: 'utf16' }],
    title: null,
    textOnly: false,
    video: { minMs: 3 * SEC, maxMs: 15 * MIN, maxBytes: 300 * MB },
    image: { min: 1, max: 10, maxBytes: 8 * MB },
    mixedMedia: true,
    maxLinks: null,
    linksAllowed: true,
    maxHashtags: 30,
    maxMentions: 20,
    firstComment: true,
    capPer24h: 50,
  },
  facebook: {
    platform: 'facebook',
    text: [{ max: 63_206, unit: 'utf16' }],
    title: { max: 255, unit: 'utf16', required: false },
    textOnly: true,
    video: { minMs: 1 * SEC, maxMs: 4 * HOUR, maxBytes: 10 * GB_BYTES },
    image: { min: 1, max: 10, maxBytes: 4 * MB },
    mixedMedia: false,
    maxLinks: null,
    linksAllowed: true,
    maxHashtags: null,
    maxMentions: null,
    firstComment: true,
    capPer24h: 25,
  },
  threads: {
    platform: 'threads',
    text: [{ max: 500, unit: 'utf8_bytes' }],
    title: null,
    textOnly: true,
    video: { minMs: 0, maxMs: 5 * MIN, maxBytes: 1 * GB_BYTES },
    image: { min: 1, max: 20, maxBytes: 8 * MB },
    mixedMedia: true,
    maxLinks: 5,
    linksAllowed: true,
    maxHashtags: null,
    maxMentions: null,
    firstComment: true,
    capPer24h: 50,
  },
  x: {
    platform: 'x',
    text: [{ max: X_MAX_WEIGHTED_LENGTH, unit: 'x_weighted' }],
    title: null,
    textOnly: true,
    video: { minMs: 500, maxMs: 20 * MIN, maxBytes: 8 * GB_BYTES },
    image: { min: 1, max: 4, maxBytes: 5 * MB },
    mixedMedia: false,
    maxLinks: null,
    linksAllowed: X_LINK_POSTS_PER_PLAN > 0,
    maxHashtags: null,
    maxMentions: null,
    firstComment: true,
    capPer24h: 20,
  },
  linkedin: {
    platform: 'linkedin',
    text: [{ max: 3_000, unit: 'utf16' }],
    title: { max: 400, unit: 'utf16', required: false },
    textOnly: true,
    video: { minMs: 3 * SEC, maxMs: 30 * MIN, maxBytes: 500 * MB },
    image: { min: 1, max: 20, maxBytes: 20 * MB },
    mixedMedia: false,
    maxLinks: null,
    linksAllowed: true,
    maxHashtags: null,
    maxMentions: null,
    firstComment: true,
    capPer24h: 25,
  },
  pinterest: {
    platform: 'pinterest',
    text: [{ max: 800, unit: 'utf16' }],
    title: { max: 100, unit: 'utf16', required: false },
    textOnly: false,
    video: { minMs: 4 * SEC, maxMs: 15 * MIN, maxBytes: 2 * GB_BYTES },
    image: { min: 1, max: 5, maxBytes: 20 * MB },
    mixedMedia: false,
    maxLinks: null,
    linksAllowed: true,
    maxHashtags: null,
    maxMentions: null,
    firstComment: false,
    capPer24h: 20,
  },
  bluesky: {
    platform: 'bluesky',
    text: [
      { max: 300, unit: 'graphemes' },
      { max: 3_000, unit: 'utf8_bytes' },
    ],
    title: null,
    textOnly: true,
    video: { minMs: 0, maxMs: 10 * MIN, maxBytes: 300 * MB },
    image: { min: 1, max: 4, maxBytes: 1 * MB },
    mixedMedia: false,
    maxLinks: null,
    linksAllowed: true,
    maxHashtags: null,
    maxMentions: null,
    firstComment: true,
    capPer24h: 25,
  },
}

/** Rolling-24h post caps per connected account (scheduled + publishing + published). */
export const CAPS_PER_24H: Readonly<Record<Platform, number>> = Object.fromEntries(
  PLATFORMS.map((p) => [p, PLATFORM_RULES[p].capPer24h]),
) as Record<Platform, number>

/** Facebook Reels must be 3–90 s. */
export const FACEBOOK_REELS_MAX_MS = 90 * SEC
/** YouTube Shorts are at most 3 minutes. */
export const YOUTUBE_SHORTS_MAX_MS = 3 * MIN

/** Platforms that can publish a post with no media. */
export const TEXT_ONLY_PLATFORMS: readonly Platform[] = PLATFORMS.filter((p) => PLATFORM_RULES[p].textOnly)

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * The most posts in any `windowMs` window that contains `at`, counting `times` plus the new post.
 * Load `times` with `capQueryRange(at)` from time.ts. Compare against CAPS_PER_24H.
 */
export function countInBusiestWindow(times: readonly Date[], at: Date, windowMs: number = 24 * HOUR): number {
  const t = at.getTime()
  const sorted = times
    .map((d) => d.getTime())
    .filter((x) => x > t - windowMs && x < t + windowMs)
    .sort((a, b) => a - b)
  // Candidate window starts: just after (t − window), every existing post in (t − window, t], and
  // t itself (the window that starts at the new post and holds the posts right after it).
  const starts = [t - windowMs + 1, ...sorted.filter((x) => x <= t), t]
  let best = 0
  for (const s of starts) {
    const e = s + windowMs
    let n = 1 // the new post at t (always inside [s, e))
    for (const x of sorted) if (x >= s && x < e) n += 1
    if (n > best) best = n
  }
  return best
}

/** Whether a post at `at` would exceed the platform's rolling-24h cap. */
export function wouldExceedCap(platform: Platform, existing: readonly Date[], at: Date): boolean {
  return countInBusiestWindow(existing, at) > CAPS_PER_24H[platform]
}

// ---------------------------------------------------------------------------
// Variant validation
// ---------------------------------------------------------------------------

/** What we know about an attached media asset (all optional except kind). */
export interface MediaFacts {
  kind: MediaKind
  bytes?: number | null
  durationMs?: number | null
  width?: number | null
  height?: number | null
  mimeType?: string | null
}

export interface VariantContent {
  text: string
  title?: string | null
  mediaIds?: readonly string[]
  options?: Readonly<Record<string, unknown>>
}

export type IssueSeverity = 'error' | 'warning'
export type IssueField = 'text' | 'title' | 'media' | 'options' | 'platform'

export type IssueCode =
  | 'text_required'
  | 'text_too_long'
  | 'title_required'
  | 'title_too_long'
  | 'title_invalid_chars'
  | 'title_ignored'
  | 'media_required'
  | 'media_not_supported'
  | 'unsupported_media_kind'
  | 'too_many_media'
  | 'too_few_images'
  | 'too_many_videos'
  | 'mixed_media_not_supported'
  | 'file_too_large'
  | 'video_too_short'
  | 'video_too_long'
  | 'links_not_allowed'
  | 'too_many_links'
  | 'too_many_hashtags'
  | 'too_many_mentions'
  | 'first_comment_not_supported'
  | 'first_comment_too_long'
  | 'option_required'
  | 'option_invalid'

export interface ValidationIssue {
  platform: Platform
  field: IssueField
  code: IssueCode
  severity: IssueSeverity
  message: string
  limit?: number
  actual?: number
}

export interface ValidateVariantContext {
  /** Facts for the attached media, in order. Media checks beyond counts run only when given. */
  media?: readonly MediaFacts[]
  /** At publish/schedule time, things a draft may still lack (media, required options) become errors. */
  forPublish?: boolean
}

const HASHTAG_RE = /(?:^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*/gu
const MENTION_RE = /(?:^|[^\p{L}\p{N}_.@])@[A-Za-z0-9._]{1,30}/gu

export function countHashtags(text: string): number {
  return text.match(HASHTAG_RE)?.length ?? 0
}

export function countMentions(text: string): number {
  return text.match(MENTION_RE)?.length ?? 0
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`
}

/** The text limits that apply to this variant (X long-text mode raises the limit). */
export function textLimitsFor(platform: Platform, options?: Readonly<Record<string, unknown>>): readonly TextLimit[] {
  if (platform === 'x' && (options?.longTextMode === 'thread' || options?.longTextMode === 'single_post')) {
    return [{ max: X_LONG_TEXT_MAX, unit: 'x_weighted' }]
  }
  return PLATFORM_RULES[platform].text
}

/**
 * Checks one platform variant against that platform's rules. Returns every problem found
 * (empty = fine). `error` issues block saving; `warning` issues are shown in the approval card
 * and become errors with `forPublish`.
 */
export function validateVariant(
  platform: Platform,
  variant: VariantContent,
  ctx: ValidateVariantContext = {},
): ValidationIssue[] {
  const rules = PLATFORM_RULES[platform]
  const issues: ValidationIssue[] = []
  const incomplete: IssueSeverity = ctx.forPublish ? 'error' : 'warning'
  const add = (issue: Omit<ValidationIssue, 'platform'>) => issues.push({ platform, ...issue })
  const text = variant.text ?? ''
  const options = variant.options ?? {}
  const mediaCount = variant.mediaIds?.length ?? ctx.media?.length ?? 0

  // Text ---------------------------------------------------------------
  if (text.trim() === '' && mediaCount === 0) {
    add({ field: 'text', code: 'text_required', severity: 'error', message: 'Add some text or media.' })
  }
  for (const limit of textLimitsFor(platform, options)) {
    const actual = measureText(text, limit.unit)
    if (actual > limit.max) {
      const hint =
        platform === 'x' && limit.max === X_MAX_WEIGHTED_LENGTH
          ? ' Shorten it, or set longTextMode to "thread".'
          : ' Shorten it.'
      add({
        field: 'text',
        code: 'text_too_long',
        severity: 'error',
        message: `Text is ${fmt(actual)} ${UNIT_LABEL[limit.unit]}; the limit is ${fmt(limit.max)}.${hint}`,
        limit: limit.max,
        actual,
      })
    }
  }
  if (!rules.linksAllowed && hasLink(text)) {
    add({
      field: 'text',
      code: 'links_not_allowed',
      severity: 'error',
      message:
        'Links are not supported in X posts (they would be removed when publishing). Remove the link, or put it in your profile.',
    })
  }
  if (rules.maxLinks !== null) {
    const links = countUniqueLinks(text)
    if (links > rules.maxLinks) {
      add({
        field: 'text',
        code: 'too_many_links',
        severity: 'error',
        message: `At most ${rules.maxLinks} different links are allowed; found ${links}.`,
        limit: rules.maxLinks,
        actual: links,
      })
    }
  }
  if (rules.maxHashtags !== null) {
    const n = countHashtags(text)
    if (n > rules.maxHashtags) {
      add({
        field: 'text',
        code: 'too_many_hashtags',
        severity: 'error',
        message: `At most ${rules.maxHashtags} hashtags are allowed; found ${n}.`,
        limit: rules.maxHashtags,
        actual: n,
      })
    }
  }
  if (rules.maxMentions !== null) {
    const n = countMentions(text)
    if (n > rules.maxMentions) {
      add({
        field: 'text',
        code: 'too_many_mentions',
        severity: 'error',
        message: `At most ${rules.maxMentions} @mentions are allowed; found ${n}.`,
        limit: rules.maxMentions,
        actual: n,
      })
    }
  }

  // Title --------------------------------------------------------------
  const title = variant.title ?? ''
  if (rules.title === null) {
    if (title.trim() !== '') {
      add({
        field: 'title',
        code: 'title_ignored',
        severity: 'warning',
        message: 'This platform has no title; it will be ignored.',
      })
    }
  } else {
    if (rules.title.required && title.trim() === '') {
      add({ field: 'title', code: 'title_required', severity: 'error', message: 'A title is required.' })
    }
    const actual = measureText(title, rules.title.unit)
    if (actual > rules.title.max) {
      add({
        field: 'title',
        code: 'title_too_long',
        severity: 'error',
        message: `Title is ${fmt(actual)} ${UNIT_LABEL[rules.title.unit]}; the limit is ${fmt(rules.title.max)}.`,
        limit: rules.title.max,
        actual,
      })
    }
    const forbidden = rules.title.forbidden
    if (forbidden && Array.from(forbidden).some((c) => title.includes(c))) {
      add({
        field: 'title',
        code: 'title_invalid_chars',
        severity: 'error',
        message: `Title may not contain ${Array.from(forbidden).join(' or ')}.`,
      })
    }
  }

  // First comment ------------------------------------------------------
  const firstComment = str(options.firstComment)
  if (firstComment !== undefined && firstComment !== '') {
    if (!rules.firstComment) {
      add({
        field: 'options',
        code: 'first_comment_not_supported',
        severity: 'error',
        message: 'This platform does not support a first comment.',
      })
    } else {
      for (const limit of rules.text) {
        const actual = measureText(firstComment, limit.unit)
        if (actual > limit.max) {
          add({
            field: 'options',
            code: 'first_comment_too_long',
            severity: 'error',
            message: `First comment is ${fmt(actual)} ${UNIT_LABEL[limit.unit]}; the limit is ${fmt(limit.max)}.`,
            limit: limit.max,
            actual,
          })
        }
      }
      if (!rules.linksAllowed && hasLink(firstComment)) {
        add({
          field: 'options',
          code: 'links_not_allowed',
          severity: 'error',
          message: 'Links are not supported in X posts, including the first comment.',
        })
      }
    }
  }

  // Media --------------------------------------------------------------
  const maxItems = Math.max(rules.image?.max ?? 0, rules.video ? 1 : 0)
  if (mediaCount === 0 && !rules.textOnly) {
    add({
      field: 'media',
      code: 'media_required',
      severity: incomplete,
      message: rules.image ? 'Attach a video or at least one image.' : 'Attach a video.',
    })
  }
  if (mediaCount > maxItems) {
    add({
      field: 'media',
      code: 'too_many_media',
      severity: 'error',
      message: `At most ${maxItems} media item${maxItems === 1 ? '' : 's'} per post.`,
      limit: maxItems,
      actual: mediaCount,
    })
  }
  if (ctx.media && ctx.media.length > 0) validateMedia(rules, ctx.media, options, add)

  // Options that must be set before publishing ---------------------------
  if (platform === 'tiktok') {
    if (str(options.privacyLevel) === undefined) {
      add({
        field: 'options',
        code: 'option_required',
        severity: incomplete,
        message: 'Choose who can see this TikTok post (privacyLevel); TikTok requires an explicit choice.',
      })
    }
    if (options.brandContent === true && options.privacyLevel === 'SELF_ONLY') {
      add({
        field: 'options',
        code: 'option_invalid',
        severity: 'error',
        message: 'Branded content cannot be private on TikTok.',
      })
    }
  }
  if (platform === 'pinterest' && str(options.boardId) === undefined) {
    add({
      field: 'options',
      code: 'option_required',
      severity: incomplete,
      message: 'Choose the Pinterest board to pin to (boardId).',
    })
  }
  return issues
}

function validateMedia(
  rules: PlatformRules,
  media: readonly MediaFacts[],
  options: Readonly<Record<string, unknown>>,
  add: (issue: Omit<ValidationIssue, 'platform'>) => void,
): void {
  const videos = media.filter((m) => m.kind === 'video')
  const images = media.filter((m) => m.kind === 'image')
  const other = media.filter((m) => m.kind !== 'video' && m.kind !== 'image')
  if (other.length > 0) {
    add({
      field: 'media',
      code: 'unsupported_media_kind',
      severity: 'error',
      message: 'Only videos and images can be attached to a post.',
    })
  }
  if (videos.length > 0 && !rules.video) {
    add({ field: 'media', code: 'media_not_supported', severity: 'error', message: 'Videos are not supported here.' })
  }
  if (images.length > 0 && !rules.image) {
    add({ field: 'media', code: 'media_not_supported', severity: 'error', message: 'Images are not supported here.' })
  }
  if (videos.length > 1 && !rules.mixedMedia) {
    add({
      field: 'media',
      code: 'too_many_videos',
      severity: 'error',
      message: 'Only one video per post.',
      limit: 1,
      actual: videos.length,
    })
  }
  if (videos.length > 0 && images.length > 0 && !rules.mixedMedia) {
    add({
      field: 'media',
      code: 'mixed_media_not_supported',
      severity: 'error',
      message: 'Attach either one video or images, not both.',
    })
  }
  if (rules.image && images.length > rules.image.max) {
    add({
      field: 'media',
      code: 'too_many_media',
      severity: 'error',
      message: `At most ${rules.image.max} images per post.`,
      limit: rules.image.max,
      actual: images.length,
    })
  }
  if (rules.image && images.length > 0 && videos.length === 0 && images.length < rules.image.min) {
    add({
      field: 'media',
      code: 'too_few_images',
      severity: 'error',
      message: `At least ${rules.image.min} images are needed.`,
      limit: rules.image.min,
      actual: images.length,
    })
  }
  if (rules.image) {
    for (const img of images) {
      if (typeof img.bytes === 'number' && img.bytes > rules.image.maxBytes) {
        add({
          field: 'media',
          code: 'file_too_large',
          severity: 'error',
          message: `An image is ${fmt(img.bytes)} bytes; the limit is ${fmt(rules.image.maxBytes)}.`,
          limit: rules.image.maxBytes,
          actual: img.bytes,
        })
      }
    }
  }
  if (rules.video) {
    let maxMs = rules.video.maxMs
    let minMs = rules.video.minMs
    if (rules.platform === 'facebook' && options.mediaType === 'REELS') {
      maxMs = FACEBOOK_REELS_MAX_MS
      minMs = 3_000
    }
    for (const v of videos) {
      if (typeof v.bytes === 'number' && v.bytes > rules.video.maxBytes) {
        add({
          field: 'media',
          code: 'file_too_large',
          severity: 'error',
          message: `The video is ${fmt(v.bytes)} bytes; the limit is ${fmt(rules.video.maxBytes)}.`,
          limit: rules.video.maxBytes,
          actual: v.bytes,
        })
      }
      if (typeof v.durationMs === 'number') {
        if (v.durationMs < minMs) {
          add({
            field: 'media',
            code: 'video_too_short',
            severity: 'error',
            message: `The video is ${seconds(v.durationMs)}; the minimum is ${seconds(minMs)}.`,
            limit: minMs,
            actual: v.durationMs,
          })
        }
        if (v.durationMs > maxMs) {
          add({
            field: 'media',
            code: 'video_too_long',
            severity: 'error',
            message: `The video is ${seconds(v.durationMs)}; the maximum is ${seconds(maxMs)}.`,
            limit: maxMs,
            actual: v.durationMs,
          })
        }
      }
    }
  }
}

/** Only issues that block saving or publishing. */
export const blockingIssues = (issues: readonly ValidationIssue[]): ValidationIssue[] =>
  issues.filter((i) => i.severity === 'error')

/** Picks the publish kind for a variant from its media. */
export function contentKindFor(media: readonly Pick<MediaFacts, 'kind'>[]): 'text' | 'video' | 'photos' {
  if (media.some((m) => m.kind === 'video') && !media.some((m) => m.kind === 'image')) return 'video'
  if (media.length === 0) return 'text'
  return 'photos'
}
