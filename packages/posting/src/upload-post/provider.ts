// UploadPostProvider: the PostingProvider backed by Upload-Post (docs/research/upload-post.md).
// The ONLY code allowed to call Upload-Post. Every input is re-validated with zod; every response is
// parsed leniently with zod (looseObject) and mapped onto provider-neutral types.

import { z } from 'zod'
import { AppError, fromZodError } from '@app/core/errors'
import type { Logger } from '@app/core/log'
import type { Clock, HealthCheckResult, PastPostInput, PostingProvider, ProviderAccount, PublishInput, PublishStatus } from '@app/core/ports'
import { PLATFORM_LABELS, PLATFORMS, PlatformSchema, type Metrics, type Platform } from '@app/core/types'
import { cleanText } from '@app/core/validation'
import { providerError, providerErrorReason } from '../errors'
import { ProfileRefSchema, RedirectUrlSchema, RequestIdSchema, parsePublishInput } from '../publish-input'
import { UploadPostClient, type FetchLike } from './client'
import {
  CONNECT_PAGE_PLATFORMS,
  DEFAULT_CONNECT_LINK_TTL_MS,
  MEDIA_NO_CURSOR,
  MEDIA_PAGE_DEFAULT,
  MEDIA_PAGE_MAX,
  POST_ANALYTICS_BY_ID_PLATFORMS,
} from './constants'
import { buildPublishRequest, platformFromRequestId, requestIdFor } from './fields'
import { normalizeMetrics } from './metrics'
import { PlatformResultSchema, StatusResponseSchema, mapUploadStatus, publicUrl } from './status'

const PROVIDER = 'upload_post' as const

export interface ConnectPageBranding {
  logoUrl?: string
  title?: string
  description?: string
  buttonText?: string
  language?: 'en' | 'es' | 'de' | 'fr' | 'pt' | 'pl' | 'tr'
}

export interface UploadPostProviderOptions {
  apiKey: string
  /** Override for tests and proxies; the adapter has the default. */
  baseUrl?: string
  fetch?: FetchLike
  clock?: Clock
  logger?: Logger
  timeoutMs?: number
  /**
   * Prefix of the provider profile username we derive from a brand id. Use a different prefix per
   * environment when several environments share one Upload-Post account (e.g. "stg_brand_").
   */
  profilePrefix?: string
  /** White-label text on the hosted connect page. */
  connectPage?: ConnectPageBranding
}

export interface UploadPostProfile {
  username: string
  displayName: string | null
  socialAccounts: Record<string, unknown>
}

export interface ProviderDestination {
  id: string
  name: string | null
}

const OptionsSchema = z.object({
  apiKey: z.string().trim().min(1, 'UPLOAD_POST_API_KEY is required.'),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  profilePrefix: z
    .string()
    .regex(/^[A-Za-z0-9_@-]{0,40}$/)
    .optional(),
  connectPage: z
    .object({
      logoUrl: z.string().url().startsWith('https://').optional(),
      title: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
      buttonText: z.string().max(100).optional(),
      language: z.enum(['en', 'es', 'de', 'fr', 'pt', 'pl', 'tr']).optional(),
    })
    .optional(),
})

// --- input schemas ---------------------------------------------------------

const BrandIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be an id.')

const EnsureProfileSchema = z.strictObject({
  brandId: BrandIdSchema,
  profileRef: ProfileRefSchema.nullish(),
  displayName: z.string().max(1_000),
})

const ConnectLinkSchema = z.strictObject({
  profileRef: ProfileRefSchema,
  platforms: z.array(PlatformSchema).max(PLATFORMS.length).default([]),
  redirectUrl: RedirectUrlSchema.optional(),
})

const DisconnectSchema = z.strictObject({ profileRef: ProfileRefSchema, platform: PlatformSchema })

const PostMetricsSchema = z
  .strictObject({
    requestId: RequestIdSchema.optional(),
    platformPostId: z.string().trim().min(1).max(256).optional(),
    platform: PlatformSchema,
    profileRef: ProfileRefSchema,
  })
  .refine((v) => v.requestId !== undefined || v.platformPostId !== undefined, 'Give a requestId or a platformPostId.')

const AccountMetricsSchema = z.strictObject({
  profileRef: ProfileRefSchema,
  platforms: z.array(PlatformSchema).max(PLATFORMS.length),
  /** Facebook analytics need a Page; resolved automatically when omitted. */
  facebookPageId: z.string().regex(/^\d{1,30}$/).optional(),
  /** LinkedIn analytics cover company pages only; defaults to the first administered page. */
  linkedinPageId: z.string().regex(/^\d{1,30}$/).optional(),
})

const PastPostsSchema = z.strictObject({
  profileRef: ProfileRefSchema,
  platform: PlatformSchema,
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

function parse<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const r = schema.safeParse(input)
  if (!r.success) throw fromZodError(r.error, what)
  return r.data
}

// --- response schemas --------------------------------------------------------

const ProfileSchema = z.looseObject({
  username: z.string(),
  display_name: z.string().nullish(),
  social_accounts: z.record(z.string(), z.unknown()).nullish(),
})
const ProfileResponseSchema = z.looseObject({ profile: ProfileSchema })

const SocialAccountSchema = z.looseObject({
  username: z.union([z.string(), z.number()]).nullish(),
  handle: z.string().nullish(),
  display_name: z.string().nullish(),
  reauth_required: z.boolean().nullish(),
})

const ConnectLinkResponseSchema = z.looseObject({
  access_url: z.string().url().startsWith('https://'),
  duration: z.string().nullish(),
})

const PublishResponseSchema = z.looseObject({
  request_id: z.string().nullish(),
  job_id: z.string().nullish(),
  results: z.record(z.string(), z.unknown()).nullish(),
})

const PostAnalyticsResponseSchema = z.looseObject({
  platforms: z.record(z.string(), z.unknown()).nullish(),
})
const PostAnalyticsPlatformSchema = z.looseObject({
  post_metrics: z.unknown().optional(),
  post_metrics_error: z.string().nullish(),
})

const MediaItemSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  caption: z.string().nullish(),
  media_type: z.string().nullish(),
  permalink: z.string().nullish(),
  timestamp: z.string().nullish(),
})
const MediaResponseSchema = z.looseObject({
  media: z.array(z.unknown()).nullish(),
  pagination: z
    .looseObject({
      next_cursor: z.string().nullish(),
      has_more: z.boolean().nullish(),
    })
    .nullish(),
})

const DestinationsResponseSchema = z.looseObject({
  pages: z.array(z.unknown()).nullish(),
  boards: z.array(z.unknown()).nullish(),
})
const DestinationSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  name: z.string().nullish(),
})

/** GET /api/uploadposts/users: the profiles of the account (only counted for the health check). */
const ProfilesResponseSchema = z.looseObject({
  profiles: z.array(z.unknown()).nullish(),
  limit: z.number().int().nonnegative().nullish(),
})

/** How long the owner's health check waits for Upload-Post. */
const HEALTH_CHECK_TIMEOUT_MS = 10_000

// --- helpers -------------------------------------------------------------------

/** Display names: one line, ≤ 100 characters (provider limit). */
export function cleanDisplayName(raw: string): string {
  return cleanText(raw).replace(/\s+/g, ' ').trim().slice(0, 100).trim()
}

/** Deterministic provider profile username for a brand. */
export function profileRefForBrand(brandId: string, prefix = 'brand_'): string {
  return `${prefix}${brandId.toLowerCase()}`
}

/** "48h" / "30m" / "2d" → ms (undefined when unreadable). */
export function parseDurationMs(raw: string | null | undefined): number | undefined {
  const m = /^\s*(\d{1,4})\s*([smhd])\s*$/i.exec(raw ?? '')
  if (!m?.[1] || !m[2]) return undefined
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd']
  return Number(m[1]) * unit
}

/** ISO 8601 from provider timestamps such as "2025-06-15T10:30:00+0000" (null when unreadable). */
export function toIsoTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null
  const fixed = raw.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const ms = Date.parse(fixed)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const PROVIDER_PLATFORM_KEYS: Readonly<Record<string, Platform>> = { twitter: 'x' }

function asString(v: unknown, max = 512): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s.slice(0, max)
}

/** Normalises the profile's social_accounts map onto ProviderAccounts (our platforms only). */
export function accountsFromSocialAccounts(social: Record<string, unknown>): ProviderAccount[] {
  const out = new Map<Platform, ProviderAccount>()
  for (const [rawKey, value] of Object.entries(social)) {
    const key = rawKey.toLowerCase()
    const platform = (PROVIDER_PLATFORM_KEYS[key] ?? key) as Platform
    if (!(PLATFORMS as readonly string[]).includes(platform) || out.has(platform)) continue
    if (value === null || value === undefined || value === '' || value === false) continue
    if (typeof value === 'string') {
      const id = asString(value)
      if (id) out.set(platform, { platform, externalId: id, handle: null, displayName: null, status: 'active' })
      continue
    }
    const parsed = SocialAccountSchema.safeParse(value)
    if (!parsed.success) continue
    const a = parsed.data
    const handle = asString(a.handle, 200)
    const displayName = asString(a.display_name, 200)
    const externalId = asString(a.username) ?? handle ?? displayName
    if (!externalId) continue
    out.set(platform, {
      platform,
      externalId,
      handle,
      displayName,
      status: a.reauth_required ? 'needs_reauth' : 'active',
    })
  }
  return PLATFORMS.flatMap((p) => {
    const a = out.get(p)
    return a ? [a] : []
  })
}

// --- provider --------------------------------------------------------------------

export class UploadPostProvider implements PostingProvider {
  readonly name = PROVIDER
  // Private on purpose: nothing outside this adapter may call Upload-Post endpoints directly.
  private readonly client: UploadPostClient
  /** Same key, shorter timeout, separate rate-limit state: the owner's health check never blocks posting. */
  private readonly healthClient: UploadPostClient
  private readonly clock: Clock
  private readonly logger: Logger | undefined
  private readonly profilePrefix: string
  private readonly connectPage: ConnectPageBranding

  constructor(options: UploadPostProviderOptions) {
    const o = OptionsSchema.safeParse(options)
    if (!o.success) {
      // Name the fields, never the values (the key may be in there).
      const fields = [...new Set(o.error.issues.map((i) => i.path.join('.') || 'options'))].join(', ')
      throw new AppError('internal', `Upload-Post provider is misconfigured (${fields}).`)
    }
    this.clock = options.clock ?? { now: () => new Date() }
    this.logger = options.logger
    this.profilePrefix = o.data.profilePrefix ?? 'brand_'
    this.connectPage = o.data.connectPage ?? {}
    this.client = new UploadPostClient({
      apiKey: o.data.apiKey,
      baseUrl: o.data.baseUrl,
      fetch: options.fetch,
      timeoutMs: o.data.timeoutMs,
      logger: options.logger,
      now: () => this.clock.now().getTime(),
    })
    this.healthClient = new UploadPostClient({
      apiKey: o.data.apiKey,
      baseUrl: o.data.baseUrl,
      fetch: options.fetch,
      timeoutMs: Math.min(o.data.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS, HEALTH_CHECK_TIMEOUT_MS),
      logger: options.logger,
      now: () => this.clock.now().getTime(),
    })
  }

  // --- health -------------------------------------------------------------------

  /**
   * The cheapest authenticated read (docs/research/upload-post.md): GET /api/uploadposts/users
   * lists the account's profiles. Proves the API key and the plan work. Never throws; the detail
   * never contains the key.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const res = await this.healthClient.request({ method: 'GET', path: '/api/uploadposts/users' })
      const parsed = ProfilesResponseSchema.safeParse(res.body)
      const count = parsed.success && parsed.data.profiles ? parsed.data.profiles.length : null
      const limit = parsed.success ? (parsed.data.limit ?? null) : null
      if (count === null) return { ok: true, detail: 'Upload-Post accepted the API key.' }
      const of = limit !== null ? ` of ${limit}` : ''
      return { ok: true, detail: `Upload-Post accepted the API key (${count}${of} profile${count === 1 && !of ? '' : 's'} in use).` }
    } catch (err) {
      const reason = providerErrorReason(err)
      if (reason === 'provider_auth') {
        return { ok: false, detail: 'Upload-Post refused the API key, or the plan is not active. Check UPLOAD_POST_API_KEY and your Upload-Post plan.' }
      }
      if (reason === 'rate_limited') return { ok: false, detail: 'Upload-Post is busy right now. Try again in a minute.' }
      if (reason === 'provider_unavailable') return { ok: false, detail: 'Upload-Post could not be reached. Try again in a minute.' }
      return { ok: false, detail: 'Upload-Post answered in an unexpected way. Try again in a minute.' }
    }
  }

  // --- profiles ------------------------------------------------------------------

  async ensureProfile(i: { brandId: string; profileRef?: string | null; displayName: string }): Promise<{ profileRef: string }> {
    const input = parse(EnsureProfileSchema, i, 'Profile request')
    const displayName = cleanDisplayName(input.displayName)
    if (input.profileRef) {
      const existing = await this.getProfile(input.profileRef)
      if (existing) {
        if (displayName !== '' && existing.displayName !== displayName) await this.renameProfile(input.profileRef, displayName)
        return { profileRef: input.profileRef }
      }
      await this.createProfile(input.profileRef, displayName)
      return { profileRef: input.profileRef }
    }
    const profileRef = profileRefForBrand(input.brandId, this.profilePrefix)
    parse(ProfileRefSchema, profileRef, 'Profile id')
    await this.createProfile(profileRef, displayName)
    return { profileRef }
  }

  /** POST /api/uploadposts/users. A 409 (already exists) counts as success: usernames are ours and deterministic. */
  async createProfile(profileRef: string, displayName: string): Promise<void> {
    const username = parse(ProfileRefSchema, profileRef, 'Profile id')
    const name = cleanDisplayName(displayName)
    await this.client.request({
      method: 'POST',
      path: '/api/uploadposts/users',
      json: name === '' ? { username } : { username, display_name: name },
      passStatuses: [409],
    })
  }

  /** GET /api/uploadposts/users/{username}; null when the profile does not exist. */
  async getProfile(profileRef: string): Promise<UploadPostProfile | null> {
    const username = parse(ProfileRefSchema, profileRef, 'Profile id')
    const res = await this.client.request({
      method: 'GET',
      path: `/api/uploadposts/users/${encodeURIComponent(username)}`,
      passStatuses: [404],
    })
    if (res.status === 404) return null
    const body = this.parseResponse(ProfileResponseSchema, res.body)
    return {
      username: body.profile.username,
      displayName: body.profile.display_name ?? null,
      socialAccounts: body.profile.social_accounts ?? {},
    }
  }

  /** PATCH /api/uploadposts/users/{username}: only display_name can change. */
  async renameProfile(profileRef: string, displayName: string): Promise<void> {
    const username = parse(ProfileRefSchema, profileRef, 'Profile id')
    await this.client.request({
      method: 'PATCH',
      path: `/api/uploadposts/users/${encodeURIComponent(username)}`,
      json: { display_name: cleanDisplayName(displayName) || null },
    })
  }

  /** DELETE /api/uploadposts/users; a missing profile counts as deleted. */
  async deleteProfile(profileRef: string): Promise<void> {
    const username = parse(ProfileRefSchema, profileRef, 'Profile id')
    await this.client.request({ method: 'DELETE', path: '/api/uploadposts/users', json: { username }, passStatuses: [404] })
  }

  // --- accounts ------------------------------------------------------------------

  async createConnectLink(i: { profileRef: string; platforms: Platform[]; redirectUrl?: string }): Promise<{ url: string; expiresAt: string }> {
    const input = parse(ConnectLinkSchema, i, 'Connect request')
    const body: Record<string, unknown> = {
      username: input.profileRef,
      // The hosted calendar lets users create and edit posts, which would bypass our approval step.
      show_calendar: false,
    }
    if (input.redirectUrl) body.redirect_url = input.redirectUrl
    // The page filters only on the platforms it documents; for others show everything rather than hide them.
    const wanted = [...new Set(input.platforms)]
    if (wanted.length > 0 && wanted.every((p) => CONNECT_PAGE_PLATFORMS.includes(p))) body.platforms = wanted
    const b = this.connectPage
    if (b.logoUrl) body.logo_image = b.logoUrl
    if (b.title) body.connect_title = b.title
    if (b.description) body.connect_description = b.description
    if (b.buttonText) body.redirect_button_text = b.buttonText
    if (b.language) body.language = b.language

    const res = await this.client.request({ method: 'POST', path: '/api/uploadposts/users/generate-jwt', json: body })
    const data = this.parseResponse(ConnectLinkResponseSchema, res.body)
    const ttl = parseDurationMs(data.duration) ?? DEFAULT_CONNECT_LINK_TTL_MS
    return { url: data.access_url, expiresAt: new Date(this.clock.now().getTime() + ttl).toISOString() }
  }

  async listAccounts(profileRef: string): Promise<ProviderAccount[]> {
    const profile = await this.getProfile(profileRef)
    if (!profile) {
      throw providerError('not_found', 'This brand has no profile at the posting service yet.', { provider: PROVIDER, status: 404 })
    }
    return accountsFromSocialAccounts(profile.socialAccounts)
  }

  /** DELETE /api/uploadposts/users/social; already-disconnected (200) and never-connected (404) both succeed. */
  async disconnect(i: { profileRef: string; platform: Platform }): Promise<void> {
    const input = parse(DisconnectSchema, i, 'Disconnect request')
    await this.client.request({
      method: 'DELETE',
      path: '/api/uploadposts/users/social',
      json: { profile_username: input.profileRef, social_platform: input.platform },
      passStatuses: [404],
    })
  }

  /** Facebook Pages, LinkedIn company pages or Pinterest boards available to the profile (destination pickers). */
  async listDestinations(profileRef: string, platform: 'facebook' | 'linkedin' | 'pinterest'): Promise<ProviderDestination[]> {
    const username = parse(ProfileRefSchema, profileRef, 'Profile id')
    const path = {
      facebook: '/api/uploadposts/facebook/pages',
      linkedin: '/api/uploadposts/linkedin/pages',
      pinterest: '/api/uploadposts/pinterest/boards',
    }[platform]
    const res = await this.client.request({ method: 'GET', path, query: { profile: username } })
    const body = this.parseResponse(DestinationsResponseSchema, res.body)
    const items = (platform === 'pinterest' ? body.boards : body.pages) ?? []
    const out: ProviderDestination[] = []
    for (const raw of items) {
      const d = DestinationSchema.safeParse(raw)
      if (!d.success) continue
      let id = String(d.data.id).trim()
      if (platform === 'linkedin') id = id.replace(/^urn:li:organization:/, '')
      if (id === '' || id.length > 128) continue
      out.push({ id, name: asString(d.data.name, 200) })
    }
    return out
  }

  // --- publishing ------------------------------------------------------------------

  async publish(i: PublishInput): Promise<{ requestId: string }> {
    const input = parsePublishInput(i)
    const requestId = requestIdFor(input.platform, input.idempotencyKey)
    const { path, fields } = buildPublishRequest(input, requestId)
    const res = await this.client.request({
      method: 'POST',
      path,
      form: fields,
      headers: { 'Idempotency-Key': input.idempotencyKey },
    })
    const body = this.parseResponse(PublishResponseSchema, res.body)

    // A synchronous answer (or a 400-less partial) can already carry this platform's outcome.
    const raw = body.results?.[input.platform]
    if (raw !== undefined) {
      const r = PlatformResultSchema.safeParse(raw)
      if (r.success && (r.data.success === false || r.data.skipped)) {
        const label = PLATFORM_LABELS[input.platform]
        const msg = r.data.skipped
          ? `No ${label} account is connected to this brand. Connect it and try again.`
          : `${label} rejected the post: ${this.client.safeMessage(r.data.error ?? r.data.message) ?? 'no reason given.'}`
        throw providerError('provider_rejected', msg, {
          provider: PROVIDER,
          status: res.status,
          ...(r.data.error_code && /^[A-Za-z0-9_.-]{1,64}$/.test(r.data.error_code) ? { providerCode: r.data.error_code } : {}),
        })
      }
    }
    const returned = body.request_id && RequestIdSchema.safeParse(body.request_id).success ? body.request_id : requestId
    this.logger?.info('upload_post.published', { platform: input.platform, kind: input.kind, requestId: returned })
    return { requestId: returned }
  }

  async getStatus(requestId: string): Promise<PublishStatus> {
    const id = parse(RequestIdSchema, requestId, 'Request id')
    const res = await this.client.request({
      method: 'GET',
      path: '/api/uploadposts/status',
      query: { request_id: id },
      passStatuses: [404],
    })
    const notFound = () => providerError('not_found', 'The posting service has no record of this upload.', { provider: PROVIDER, status: 404 })
    if (res.status === 404) throw notFound()
    const body = this.parseResponse(StatusResponseSchema, res.body)
    if (body.status === 'not_found') throw notFound()
    return mapUploadStatus(body, platformFromRequestId(id, PLATFORMS), (m) => this.client.safeMessage(m))
  }

  // --- analytics ---------------------------------------------------------------------

  async getPostMetrics(i: { requestId?: string; platformPostId?: string; platform: Platform; profileRef: string }): Promise<Metrics> {
    const input = parse(PostMetricsSchema, i, 'Post metrics request')
    let res
    if (input.requestId) {
      res = await this.client.request({
        method: 'GET',
        path: `/api/uploadposts/post-analytics/${encodeURIComponent(input.requestId)}`,
        query: { platform: input.platform },
      })
    } else {
      if (!POST_ANALYTICS_BY_ID_PLATFORMS.includes(input.platform)) return {}
      res = await this.client.request({
        method: 'GET',
        path: '/api/uploadposts/post-analytics',
        query: { platform_post_id: input.platformPostId, platform: input.platform, user: input.profileRef },
      })
    }
    const body = this.parseResponse(PostAnalyticsResponseSchema, res.body)
    const entry = PostAnalyticsPlatformSchema.safeParse(body.platforms?.[input.platform])
    if (!entry.success) return {}
    if (entry.data.post_metrics_error && entry.data.post_metrics === undefined) {
      this.logger?.warn('upload_post.post_metrics_unavailable', { platform: input.platform })
      return {}
    }
    return normalizeMetrics(entry.data.post_metrics)
  }

  async getAccountMetrics(i: {
    profileRef: string
    platforms: Platform[]
    facebookPageId?: string
    linkedinPageId?: string
  }): Promise<Array<{ platform: Platform; metrics: Metrics }>> {
    const input = parse(AccountMetricsSchema, i, 'Account metrics request')
    const platforms = [...new Set(input.platforms)]
    if (platforms.length === 0) return []

    let facebookPageId = input.facebookPageId
    if (platforms.includes('facebook') && !facebookPageId) {
      // Best effort: without a Page, Facebook simply gets empty metrics; the analytics call below
      // still surfaces auth / availability problems.
      facebookPageId = await this.listDestinations(input.profileRef, 'facebook').then(
        (pages) => pages[0]?.id,
        () => undefined,
      )
    }
    const query: Record<string, string | undefined> = {
      platforms: platforms.filter((p) => p !== 'facebook' || facebookPageId).join(','),
      page_id: facebookPageId,
      page_urn: input.linkedinPageId,
    }
    const results: Array<{ platform: Platform; metrics: Metrics }> = platforms.map((platform) => ({ platform, metrics: {} }))
    if (!query.platforms) return results

    const res = await this.client.request({
      method: 'GET',
      path: `/api/analytics/${encodeURIComponent(input.profileRef)}`,
      query,
    })
    const body = res.body !== null && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {}
    const nested = body.analytics !== null && typeof body.analytics === 'object' ? (body.analytics as Record<string, unknown>) : {}
    for (const r of results) {
      r.metrics = normalizeMetrics(body[r.platform] ?? nested[r.platform])
    }
    return results
  }

  async listPastPosts(i: { profileRef: string; platform: Platform; cursor?: string; limit?: number }): Promise<{
    posts: PastPostInput[]
    nextCursor?: string
  }> {
    const input = parse(PastPostsSchema, i, 'Past posts request')
    const noCursor = MEDIA_NO_CURSOR.includes(input.platform)
    // These platforms return one page only; a cursor can only be stale.
    if (noCursor && input.cursor) return { posts: [] }
    const limit = Math.min(input.limit ?? MEDIA_PAGE_DEFAULT, MEDIA_PAGE_MAX[input.platform] ?? 100)
    const res = await this.client.request({
      method: 'GET',
      path: '/api/uploadposts/media',
      query: { platform: input.platform, user: input.profileRef, limit, cursor: input.cursor },
    })
    const body = this.parseResponse(MediaResponseSchema, res.body)
    const posts: PastPostInput[] = []
    for (const raw of body.media ?? []) {
      const item = MediaItemSchema.safeParse(raw)
      if (!item.success) continue
      const externalPostId = asString(item.data.id, 256)
      if (!externalPostId) continue
      // Captions and metadata only: never media URLs (we only clip content users upload themselves).
      posts.push({
        platform: input.platform,
        externalPostId,
        text: typeof item.data.caption === 'string' ? cleanText(item.data.caption).slice(0, 70_000) : null,
        mediaType: asString(item.data.media_type, 32),
        postedAt: toIsoTimestamp(item.data.timestamp),
        permalink: publicUrl(item.data.permalink) ?? null,
        metrics: normalizeMetrics(raw),
      })
    }
    const next = body.pagination?.has_more !== false ? asString(body.pagination?.next_cursor, 4_096) : null
    return !noCursor && next ? { posts, nextCursor: next } : { posts }
  }

  /** Last X-RateLimit state seen (metrics / debugging). */
  rateLimitState(): { remaining: number; resetAt: string } | null {
    return this.client.rateLimitState()
  }

  // --- internals -------------------------------------------------------------------

  private parseResponse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
    const r = schema.safeParse(body)
    if (!r.success) {
      this.logger?.warn('upload_post.unexpected_response', { issues: r.error.issues.slice(0, 5).map((x) => x.path.join('.')) })
      throw providerError('provider_unavailable', 'The posting service returned an unexpected response. Please try again shortly.', {
        provider: PROVIDER,
        providerCode: 'invalid_response',
      })
    }
    return r.data
  }
}
