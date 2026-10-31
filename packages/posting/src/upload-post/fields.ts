// Maps a validated publish request onto Upload-Post's multipart fields. Pure: no I/O.
// One platform per request (posts are per variant), so the generic `title` / `description`
// fields are unambiguous; per-platform option names follow the upload docs (see docs/handoff/posting.md).

import { createHash } from 'node:crypto'
import type { Platform } from '@app/core/types'
import type { ParsedPublishInput } from '../publish-input'

export type FormField = readonly [string, string]

export interface PublishRequest {
  path: '/api/upload' | '/api/upload_photos' | '/api/upload_text'
  fields: FormField[]
}

const REQUEST_ID_RE = /^upr_([a-z]+)_[0-9a-f]{32}$/

/**
 * Our own Upload-Post request_id for a post: deterministic in (platform, idempotencyKey), so a retry
 * after a lost response polls the same upload, and the platform can be read back in getStatus.
 */
export function requestIdFor(platform: Platform, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${platform}\n${idempotencyKey}`).digest('hex').slice(0, 32)
  return `upr_${platform}_${digest}`
}

/** The platform encoded in one of our request ids (undefined for provider-generated ids). */
export function platformFromRequestId(requestId: string, platforms: readonly Platform[]): Platform | undefined {
  const m = REQUEST_ID_RE.exec(requestId)
  const p = m?.[1]
  return p && (platforms as readonly string[]).includes(p) ? (p as Platform) : undefined
}

const bool = (b: boolean): string => (b ? 'true' : 'false')

/** Builds the endpoint and form fields for one publish. */
export function buildPublishRequest(input: ParsedPublishInput, requestId: string): PublishRequest {
  const fields: FormField[] = []
  const add = (key: string, value: string | number | boolean | undefined | null) => {
    if (value === undefined || value === null) return
    if (typeof value === 'string' && value === '') return
    fields.push([key, typeof value === 'boolean' ? bool(value) : String(value)])
  }

  const path: PublishRequest['path'] =
    input.kind === 'video' ? '/api/upload' : input.kind === 'photos' ? '/api/upload_photos' : '/api/upload_text'

  add('user', input.profileRef)
  add('platform[]', input.platform)
  add('async_upload', true)
  add('request_id', requestId)
  add('external_id', input.idempotencyKey)

  // Media: public HTTPS URLs (presigned R2 GETs) that the provider downloads itself.
  if (input.kind === 'video') add('video', input.mediaUrls[0])
  if (input.kind === 'photos') for (const url of input.mediaUrls) add('photos[]', url)

  // Text and title -----------------------------------------------------------
  const { text, title } = input
  if (input.kind === 'text') {
    add('title', text)
  } else {
    switch (input.platform) {
      case 'youtube':
        add('title', title)
        add('description', text)
        break
      case 'facebook':
        if (input.kind === 'video') {
          add('title', title)
          add('description', text)
        } else {
          add('title', text)
        }
        break
      case 'linkedin':
      case 'pinterest':
        add('title', title)
        add('description', text)
        break
      case 'tiktok':
        if (input.kind === 'photos') {
          add('title', title)
          add('tiktok_description', text)
        } else {
          add('title', text)
        }
        break
      default:
        // instagram, threads, x, bluesky: one text per post
        add('title', text)
    }
  }

  // Per-platform options -----------------------------------------------------
  switch (input.platform) {
    case 'tiktok': {
      const o = input.options
      add('post_mode', 'DIRECT_POST')
      // Fail instead of silently landing in the TikTok inbox when the daily cap is hit (research §3).
      add('disable_inbox_fallback', true)
      add('privacy_level', o.privacyLevel)
      add('disable_comment', o.disableComment)
      if (input.kind === 'video') {
        add('disable_duet', o.disableDuet)
        add('disable_stitch', o.disableStitch)
        add('cover_timestamp', o.coverTimestampMs)
        add('is_aigc', o.isAiGenerated)
      }
      add('brand_content_toggle', o.brandContent)
      add('brand_organic_toggle', o.brandOrganic)
      add('first_comment', o.firstComment)
      break
    }
    case 'youtube': {
      const o = input.options
      for (const tag of o.tags ?? []) add('tags[]', tag)
      add('categoryId', o.categoryId)
      add('privacyStatus', o.privacyStatus)
      add('selfDeclaredMadeForKids', o.madeForKids)
      add('containsSyntheticMedia', o.containsSyntheticMedia)
      add('youtube_playlist_id', o.playlistId)
      add('first_comment', o.firstComment)
      break
    }
    case 'instagram': {
      const o = input.options
      if (input.kind === 'video') {
        add('media_type', o.mediaType)
        if (o.mediaType !== 'STORIES') add('share_to_feed', o.shareToFeed)
        add('thumb_offset', o.thumbOffsetMs)
      } else if (o.mediaType === 'STORIES') {
        add('media_type', 'STORIES')
      }
      if (o.collaborators && o.collaborators.length > 0) {
        add('collaborators', o.collaborators.map((c) => c.replace(/^@/, '')).join(','))
      }
      add('location_id', o.locationId)
      add('first_comment', o.firstComment)
      break
    }
    case 'facebook': {
      const o = input.options
      add('facebook_page_id', o.pageId)
      if (input.kind === 'video') add('facebook_media_type', o.mediaType)
      else if (input.kind === 'photos' && o.mediaType === 'STORIES') add('facebook_media_type', 'STORIES')
      add('first_comment', o.firstComment)
      break
    }
    case 'threads': {
      const o = input.options
      add('threads_topic_tag', o.topicTag)
      add('threads_reply_control', o.replyControl)
      add('first_comment', o.firstComment)
      break
    }
    case 'x': {
      const o = input.options
      if (o.longTextMode === 'single_post') add('x_long_text_as_post', true)
      if (o.replySettings && o.replySettings !== 'everyone') add('reply_settings', o.replySettings)
      add('first_comment', o.firstComment)
      break
    }
    case 'linkedin': {
      const o = input.options
      add('visibility', o.visibility)
      add('target_linkedin_page_id', o.pageId)
      add('first_comment', o.firstComment)
      break
    }
    case 'pinterest': {
      const o = input.options
      add('pinterest_board_id', o.boardId)
      add('pinterest_link', o.link)
      add('pinterest_alt_text', o.altText)
      break
    }
    case 'bluesky': {
      const o = input.options
      add('bluesky_alt_text', o.altText)
      if (o.langs && o.langs.length > 0) add('bluesky_langs', o.langs.join(','))
      add('first_comment', o.firstComment)
      break
    }
  }

  return { path, fields }
}
