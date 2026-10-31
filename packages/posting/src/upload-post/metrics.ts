// Normalises Upload-Post metric objects (profile analytics, post analytics, media items) onto our
// Metrics keys. Unknown keys are dropped; only finite, non-negative numbers survive.

import { pickMetrics, type MetricKey, type Metrics } from '@app/core/types'

/** Provider spellings per metric key, in priority order (first present wins). */
const ALIASES: Readonly<Record<MetricKey, readonly string[]>> = {
  views: ['views', 'video_views', 'plays', 'view_count'],
  likes: ['likes', 'like_count', 'reactions'],
  comments: ['comments', 'comment_count', 'replies', 'reply_count'],
  shares: ['shares', 'share_count', 'reposts', 'retweets', 'repost_count'],
  saves: ['saves', 'saved', 'bookmarks', 'bookmark_count'],
  followers: ['followers', 'followers_count', 'follower_count', 'subscribers'],
  reach: ['reach'],
  impressions: ['impressions', 'impression_count'],
}

export function normalizeMetrics(input: unknown): Metrics {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  const flat: Record<string, unknown> = {}
  for (const [key, aliases] of Object.entries(ALIASES) as Array<[MetricKey, readonly string[]]>) {
    for (const alias of aliases) {
      const value = record[alias]
      if (value === undefined || value === null) continue
      const picked = pickMetrics({ [key]: value })
      if (picked[key] !== undefined) {
        flat[key] = picked[key]
        break
      }
    }
  }
  return pickMetrics(flat)
}
