// Upload-Post constants. This directory is the ONLY place allowed to name the provider's hosts
// (scripts/check-boundaries.mjs). Sources: docs/research/upload-post.md and docs/handoff/posting.md.

import type { Platform } from '@app/core/types'

export const UPLOAD_POST_DEFAULT_BASE_URL = 'https://api.upload-post.com'

/** Platforms the hosted connect page accepts in `platforms[]` (docs: generate-jwt, verified 2026-10-31). */
export const CONNECT_PAGE_PLATFORMS: readonly Platform[] = ['tiktok', 'instagram', 'linkedin', 'youtube', 'facebook', 'x', 'threads']

/** Connect links last 48 h (generate-jwt answers `duration: "48h"`). */
export const DEFAULT_CONNECT_LINK_TTL_MS = 48 * 60 * 60 * 1000

/** Per-platform page-size caps of GET /api/uploadposts/media (default 25, max 100). */
export const MEDIA_PAGE_MAX: Readonly<Partial<Record<Platform, number>>> = { tiktok: 20, youtube: 50 }
export const MEDIA_PAGE_DEFAULT = 25

/** Platforms whose media listing has no cursor (sending one is a 400). */
export const MEDIA_NO_CURSOR: readonly Platform[] = ['linkedin']

/** Platforms GET /api/uploadposts/post-analytics?platform_post_id= supports. */
export const POST_ANALYTICS_BY_ID_PLATFORMS: readonly Platform[] = [
  'youtube',
  'tiktok',
  'instagram',
  'facebook',
  'linkedin',
  'x',
  'threads',
  'pinterest',
]

/** Webhook headers (lower-case: Headers.get is case-insensitive, plain records are normalised). */
export const WEBHOOK_HEADERS = {
  signature: 'x-upload-post-signature',
  timestamp: 'x-upload-post-timestamp',
  event: 'x-upload-post-event',
  delivery: 'x-upload-post-delivery',
} as const

/** Reject webhook deliveries signed more than this long ago (docs: ~5 minutes). */
export const WEBHOOK_TOLERANCE_SEC = 300

/** Default HTTP timeout. Uploads use async_upload, so every call should answer quickly. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Removes dashboard directions and brand names from provider messages (we are white-label). */
export function rewriteProviderText(s: string): string {
  return s
    .replace(/(?:,?\s*\b(?:see|at|from|via|visit|on)\s+)?\(?\b(?:app|api|docs|www)\.upload-post\.com[^\s)]*\)?/gi, '')
    .replace(/\s*(?:at|from|in|via) (?:the )?Manage Users(?: page)?\b/gi, '')
    .replace(/\bupload[- ]?post\b/gi, 'the posting service')
}
