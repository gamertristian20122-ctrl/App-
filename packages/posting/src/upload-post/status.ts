// Maps GET /api/uploadposts/status (and webhook results) onto our PublishStatus.
// Documented statuses (verified 2026-10-31): top level pending | queued | processing | in_progress |
// completed | failed | not_found; per platform queued | processing | completed | failed | retryable | skipped.
// Results do not always carry `status` (examples show only success + message), so we fall back to
// success flags, ids and the top-level status.

import { z } from 'zod'
import type { PublishStatus } from '@app/core/ports'
import { PLATFORM_LABELS, isPlatform, type Platform } from '@app/core/types'

export const PlatformResultSchema = z.looseObject({
  platform: z.string().optional(),
  success: z.boolean().nullish(),
  status: z.string().nullish(),
  message: z.string().nullish(),
  error: z.string().nullish(),
  error_message: z.string().nullish(),
  error_code: z.string().nullish(),
  skipped: z.boolean().nullish(),
  skip_reason: z.string().nullish(),
  fallback_to_inbox: z.boolean().nullish(),
  post_url: z.string().nullish(),
  url: z.string().nullish(),
  platform_post_id: z.union([z.string(), z.number()]).nullish(),
  post_id: z.union([z.string(), z.number()]).nullish(),
  publish_id: z.union([z.string(), z.number()]).nullish(),
  video_id: z.union([z.string(), z.number()]).nullish(),
})
export type PlatformResult = z.output<typeof PlatformResultSchema>

export const StatusResponseSchema = z.looseObject({
  request_id: z.string().nullish(),
  job_id: z.string().nullish(),
  status: z.string().nullish(),
  message: z.string().nullish(),
  error: z.string().nullish(),
  completed: z.number().nullish(),
  total: z.number().nullish(),
  results: z.array(z.unknown()).nullish(),
})
export type StatusResponse = z.output<typeof StatusResponseSchema>

const PENDING_STATES = new Set(['pending', 'queued', 'processing', 'in_progress', 'retryable', 'scheduled', 'uploading'])

/** A public http(s) URL, or undefined (TikTok inbox results carry prose in post_url). */
export function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

function idString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (typeof v === 'string' && v.trim() !== '' && v.length <= 512) return v.trim()
  }
  return undefined
}

export type SafeMessage = (raw: unknown) => string | null

/** State of one platform result, or null when it says nothing conclusive. */
export function resultToStatus(
  r: PlatformResult,
  platform: Platform | undefined,
  topStatus: string | undefined,
  safe: SafeMessage,
): PublishStatus | null {
  const label = platform ? PLATFORM_LABELS[platform] : 'this platform'
  const status = r.status?.toLowerCase() ?? undefined

  if (r.fallback_to_inbox) {
    return {
      state: 'failed',
      error:
        "TikTok's daily limit was reached, so the post went to the TikTok app's inbox as a draft instead of going live. Open TikTok to publish it.",
    }
  }
  if (status === 'skipped' || r.skipped) {
    return { state: 'failed', error: `No ${label} account is connected to this brand. Connect it and try again.` }
  }
  if (r.error_code === 'reached_active_user_cap') {
    return { state: 'failed', error: "TikTok's daily posting limit for this account was reached. Try again tomorrow." }
  }
  const postId = idString(r.platform_post_id, r.post_id, r.publish_id, r.video_id)
  const url = publicUrl(r.post_url) ?? publicUrl(r.url)
  const published = (): PublishStatus => ({
    state: 'published',
    ...(postId ? { postId } : {}),
    ...(url ? { url } : {}),
  })
  const failed = (): PublishStatus => ({
    state: 'failed',
    error: safe(r.error) ?? safe(r.error_message) ?? safe(r.message) ?? `Publishing to ${label} failed.`,
  })

  if (status === 'failed') return failed()
  if (status && PENDING_STATES.has(status)) return { state: 'pending' }
  if (status === 'completed' || status === 'published' || status === 'success') {
    return r.success === false ? failed() : published()
  }
  if (r.success === false) return failed()
  if (r.success === true && (postId !== undefined || url !== undefined || topStatus === 'completed')) return published()
  return null
}

/**
 * Overall state for a single-platform upload. `platform` (from our request id) selects the result;
 * without it the latest result is used. Throws nothing: not_found is handled by the caller.
 */
export function mapUploadStatus(body: StatusResponse, platform: Platform | undefined, safe: SafeMessage): PublishStatus {
  const top = body.status?.toLowerCase() ?? undefined
  const results: PlatformResult[] = []
  for (const raw of body.results ?? []) {
    const parsed = PlatformResultSchema.safeParse(raw)
    if (parsed.success) results.push(parsed.data)
  }
  const mine = platform ? results.filter((r) => r.platform === platform) : results
  // A single result is ours even if the provider spells the platform differently (e.g. "twitter").
  const candidates = mine.length > 0 ? mine : !platform || results.length === 1 ? results : []
  const result = candidates[candidates.length - 1]
  const resultPlatform = platform ?? (result?.platform && isPlatform(result.platform) ? result.platform : undefined)

  if (result) {
    const state = resultToStatus(result, resultPlatform, top, safe)
    if (state) return state
  }
  if (top === 'failed') {
    return { state: 'failed', error: safe(body.message) ?? safe(body.error) ?? 'Publishing failed at the posting service.' }
  }
  if (top === 'completed' && !result) {
    return { state: 'failed', error: 'The posting service finished without a result for this platform.' }
  }
  return { state: 'pending' }
}
