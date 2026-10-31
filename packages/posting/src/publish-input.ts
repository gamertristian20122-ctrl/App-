// Validation shared by every PostingProvider: what a publish request may contain, whatever the
// caller (worker, tests) claims. Platform text/media limits are core's validateVariant job at
// approval time; here we re-check the structural rules a provider would otherwise reject later.

import { z } from 'zod'
import { AppError, fromZodError } from '@app/core/errors'
import type { PublishInput } from '@app/core/ports'
import { CONTENT_KINDS, PLATFORM_LABELS, PLATFORMS, PlatformSchema, type ContentKind, type Platform } from '@app/core/types'
import { HttpsUrlSchema, MAX_POST_TEXT, MAX_TITLE, PlatformOptionsSchemas, cleanText, type PlatformOptions } from '@app/core/validation'

/** Platforms that accept text-only posts through the provider. */
export const TEXT_PLATFORMS: readonly Platform[] = ['x', 'linkedin', 'facebook', 'threads', 'bluesky']
/** Platforms that accept photo posts. */
export const PHOTO_PLATFORMS: readonly Platform[] = PLATFORMS.filter((p) => p !== 'youtube')
/** Every platform accepts a single video. */
export const VIDEO_PLATFORMS: readonly Platform[] = PLATFORMS

/** Provider-side upper bound on media items in one post (platform rules are stricter). */
export const MAX_MEDIA_URLS = 35

/** Provider profile username: letters, digits, "_", "@", "-" (immutable once created). */
export const ProfileRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_@-]+$/, 'Must contain only letters, digits, "_", "@" or "-".')

/** Our idempotency keys: printable ASCII, no spaces (sent as a header and as external_id). */
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7E]+$/, 'Must be printable ASCII without spaces.')

/** Provider request ids we accept back (ours or the provider's). */
export const RequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'Must be a request id.')

/** Connect-flow return URL: https anywhere; http only for local development hosts. */
export const RedirectUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((s) => {
    try {
      const u = new URL(s)
      if (u.username || u.password) return false
      if (u.protocol === 'https:') return true
      return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    } catch {
      return false
    }
  }, 'Must be an https:// URL.')

export type ParsedPublishInput = {
  [P in Platform]: {
    profileRef: string
    platform: P
    kind: ContentKind
    text: string
    title: string | undefined
    mediaUrls: string[]
    options: PlatformOptions<P>
    idempotencyKey: string
  }
}[Platform]

const BaseSchema = z.strictObject({
  profileRef: ProfileRefSchema,
  platform: PlatformSchema,
  kind: z.enum(CONTENT_KINDS),
  text: z.string().max(MAX_POST_TEXT).transform(cleanText),
  title: z
    .string()
    .max(MAX_TITLE)
    .transform((s) => cleanText(s).replace(/\s*\n\s*/g, ' ').trim())
    .optional(),
  mediaUrls: z.array(z.string().trim().max(2_048)).max(MAX_MEDIA_URLS),
  options: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: IdempotencyKeySchema,
})

function invalid(message: string): AppError {
  return new AppError('validation', message)
}

export interface ParsePublishOptions {
  /** Accept http:// media URLs too (fake provider with local storage). Real providers need https. */
  allowHttpMedia?: boolean
}

function isMediaUrl(raw: string, allowHttp: boolean): boolean {
  if (HttpsUrlSchema.safeParse(raw).success) return true
  if (!allowHttp) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

/** Validates a publish request (structure, kind/platform fit, per-platform options). Throws AppError('validation'). */
export function parsePublishInput(input: PublishInput | unknown, opts: ParsePublishOptions = {}): ParsedPublishInput {
  const base = BaseSchema.safeParse(input)
  if (!base.success) throw fromZodError(base.error, 'Publish request')
  const v = base.data
  const label = PLATFORM_LABELS[v.platform]

  const badUrl = v.mediaUrls.findIndex((u) => !isMediaUrl(u, opts.allowHttpMedia === true))
  if (badUrl !== -1) throw invalid(`Publish request is invalid. mediaUrls.${badUrl}: Must be an https:// URL.`)

  const optionsResult = PlatformOptionsSchemas[v.platform].safeParse(v.options)
  if (!optionsResult.success) throw fromZodError(optionsResult.error, `${label} options`)

  if (new Set(v.mediaUrls).size !== v.mediaUrls.length) throw invalid('Each media item may appear once.')

  switch (v.kind) {
    case 'text':
      if (!TEXT_PLATFORMS.includes(v.platform)) throw invalid(`${label} does not support text-only posts; add a video or image.`)
      if (v.mediaUrls.length > 0) throw invalid('A text post cannot carry media.')
      if (v.text.trim() === '') throw invalid('A text post needs text.')
      break
    case 'video':
      if (v.mediaUrls.length !== 1) throw invalid('A video post needs exactly one video.')
      break
    case 'photos':
      if (!PHOTO_PLATFORMS.includes(v.platform)) throw invalid(`${label} does not support photo posts.`)
      if (v.mediaUrls.length === 0) throw invalid('A photo post needs at least one image.')
      break
  }
  const title = v.title === undefined || v.title === '' ? undefined : v.title
  if (v.platform === 'youtube' && title === undefined) throw invalid('YouTube needs a title.')
  if (v.platform === 'pinterest' && !(optionsResult.data as { boardId?: string }).boardId) {
    throw invalid('Pinterest needs a board (options.boardId).')
  }

  return {
    profileRef: v.profileRef,
    platform: v.platform,
    kind: v.kind,
    text: v.text,
    title,
    mediaUrls: v.mediaUrls,
    options: optionsResult.data,
    idempotencyKey: v.idempotencyKey,
  } as ParsedPublishInput
}
