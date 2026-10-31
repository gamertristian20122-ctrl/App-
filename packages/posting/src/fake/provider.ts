// FakePostingProvider: in-memory, deterministic and scriptable. Used by tests and local development
// (POSTING_PROVIDER=fake). Same input validation as the real adapter, no network.
//
// Local-dev friendliness: the web app and the worker are separate processes (and Next dev reloads
// modules), so state is not shared. The fake therefore treats unknown profiles as empty profiles and
// resolves well-formed fake request ids it never saw as published.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fromZodError } from '@app/core/errors'
import type { Clock, PastPostInput, PostingProvider, ProviderAccount, PublishInput, PublishStatus } from '@app/core/ports'
import { PLATFORM_LABELS, PLATFORMS, PlatformSchema, type AccountStatus, type Metrics, type Platform } from '@app/core/types'
import { providerError } from '../errors'
import { ProfileRefSchema, RedirectUrlSchema, RequestIdSchema, parsePublishInput } from '../publish-input'

const PROVIDER = 'fake' as const

export type FakeMethod = Exclude<keyof PostingProvider, 'name'>

export interface FakePostingProviderOptions {
  clock?: Clock
  /** Connect the requested platforms as soon as a connect link is created (local dev). Default true. */
  autoConnect?: boolean
  /** getStatus calls that answer "pending" before an upload resolves. Default 0 (first poll publishes). */
  statusDelay?: number
  /** Reject publishes to platforms the profile has not connected (as the real provider does). Default false. */
  strictAccounts?: boolean
  /** Past posts generated per platform when none were scripted. Default 12. */
  pastPostsPerPlatform?: number
  /** Origin of fake connect/post URLs. Default https://fake-posting.invalid */
  baseUrl?: string
}

export interface FakeUpload {
  requestId: string
  profileRef: string
  platform: Platform
  kind: PublishInput['kind']
  text: string
  title: string | undefined
  mediaUrls: string[]
  options: Record<string, unknown>
  idempotencyKey: string
  pollsLeft: number
  outcome: { state: 'published' } | { state: 'failed'; error: string }
  publishedAt: string | null
}

interface FakeProfile {
  profileRef: string
  displayName: string
  accounts: Map<Platform, ProviderAccount>
}

export interface FakeCall {
  method: FakeMethod
  input: unknown
}

const FAKE_REQUEST_ID = /^fake_([a-z]+)_[0-9a-f]{24}$/

function hash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

function num(h: string, offset: number, mod: number): number {
  return parseInt(h.slice(offset, offset + 8), 16) % mod
}

const parse = <S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> => {
  const r = schema.safeParse(input)
  if (!r.success) throw fromZodError(r.error, what)
  return r.data
}

const EnsureSchema = z.strictObject({
  brandId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  profileRef: ProfileRefSchema.nullish(),
  displayName: z.string().max(1_000),
})
const ConnectSchema = z.strictObject({
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
const AccountMetricsSchema = z.object({ profileRef: ProfileRefSchema, platforms: z.array(PlatformSchema).max(PLATFORMS.length) })
const PastPostsSchema = z.strictObject({
  profileRef: ProfileRefSchema,
  platform: PlatformSchema,
  cursor: z.string().regex(/^o:\d{1,6}$/, 'Unknown cursor.').optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export class FakePostingProvider implements PostingProvider {
  readonly name = PROVIDER
  /** Every call, in order (inputs as given), for assertions. */
  readonly calls: FakeCall[] = []
  readonly uploads = new Map<string, FakeUpload>()

  private readonly clock: Clock
  private readonly baseUrl: string
  private readonly autoConnect: boolean
  private readonly strictAccounts: boolean
  private readonly pastPostsPerPlatform: number
  private statusDelay: number
  private readonly profiles = new Map<string, FakeProfile>()
  private readonly failures = new Map<FakeMethod, Error[]>()
  private nextUploadFailure: string | null = null
  private readonly postMetrics = new Map<string, Metrics>()
  private readonly accountMetrics = new Map<string, Metrics>()
  private readonly pastPosts = new Map<string, PastPostInput[]>()

  constructor(options: FakePostingProviderOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date() }
    this.baseUrl = (options.baseUrl ?? 'https://fake-posting.invalid').replace(/\/+$/, '')
    this.autoConnect = options.autoConnect ?? true
    this.strictAccounts = options.strictAccounts ?? false
    this.statusDelay = Math.max(0, options.statusDelay ?? 0)
    this.pastPostsPerPlatform = Math.max(0, options.pastPostsPerPlatform ?? 12)
  }

  // --- scripting ----------------------------------------------------------------

  /** The next call of `method` throws `error` (default: provider_unavailable). Calls queue up. */
  failNext(method: FakeMethod, error?: Error): this {
    const queue = this.failures.get(method) ?? []
    queue.push(error ?? providerError('provider_unavailable', 'The fake posting service is unavailable.', { provider: PROVIDER }))
    this.failures.set(method, queue)
    return this
  }

  /** The next publish() throws (default: provider_unavailable). */
  failNextPublish(error?: Error): this {
    return this.failNext('publish', error)
  }

  /** The next publish() is accepted but its upload resolves as failed with `error`. */
  failNextUpload(error = 'The platform rejected the post.'): this {
    this.nextUploadFailure = error
    return this
  }

  /** Make an existing upload resolve as failed. */
  failUpload(requestId: string, error = 'The platform rejected the post.'): this {
    const upload = this.uploads.get(requestId)
    if (upload) upload.outcome = { state: 'failed', error }
    return this
  }

  /** getStatus answers "pending" `polls` more times: for one upload, or for every future upload. */
  delayStatus(polls: number, requestId?: string): this {
    const n = Math.max(0, Math.floor(polls))
    if (requestId === undefined) this.statusDelay = n
    else {
      const upload = this.uploads.get(requestId)
      if (upload) upload.pollsLeft = n
    }
    return this
  }

  /** Simulate the user finishing the hosted connect flow. */
  connectAccount(profileRef: string, platform: Platform, account: Partial<Omit<ProviderAccount, 'platform'>> = {}): ProviderAccount {
    const profile = this.profile(profileRef)
    const h = hash(profileRef, platform)
    const a: ProviderAccount = {
      platform,
      externalId: account.externalId ?? `fake-${platform}-${h.slice(0, 12)}`,
      handle: account.handle !== undefined ? account.handle : `${profileRef}_${platform}`,
      displayName: account.displayName !== undefined ? account.displayName : `${profile.displayName || profileRef} on ${PLATFORM_LABELS[platform]}`,
      status: account.status ?? 'active',
    }
    profile.accounts.set(platform, a)
    return a
  }

  setAccountStatus(profileRef: string, platform: Platform, status: AccountStatus): this {
    const a = this.profiles.get(profileRef)?.accounts.get(platform)
    if (a) a.status = status
    return this
  }

  /** Metrics returned by getPostMetrics for a requestId or platformPostId. */
  setPostMetrics(idOrRequestId: string, metrics: Metrics): this {
    this.postMetrics.set(idOrRequestId, { ...metrics })
    return this
  }

  setAccountMetrics(profileRef: string, platform: Platform, metrics: Metrics): this {
    this.accountMetrics.set(`${profileRef}\n${platform}`, { ...metrics })
    return this
  }

  setPastPosts(profileRef: string, platform: Platform, posts: PastPostInput[]): this {
    this.pastPosts.set(`${profileRef}\n${platform}`, posts.map((p) => ({ ...p })))
    return this
  }

  hasProfile(profileRef: string): boolean {
    return this.profiles.has(profileRef)
  }

  /** Forget everything (profiles, uploads, scripts, calls). */
  reset(): void {
    this.calls.length = 0
    this.uploads.clear()
    this.profiles.clear()
    this.failures.clear()
    this.postMetrics.clear()
    this.accountMetrics.clear()
    this.pastPosts.clear()
    this.nextUploadFailure = null
  }

  // --- PostingProvider ------------------------------------------------------------

  async ensureProfile(i: { brandId: string; profileRef?: string | null; displayName: string }): Promise<{ profileRef: string }> {
    this.enter('ensureProfile', i)
    const input = parse(EnsureSchema, i, 'Profile request')
    const profileRef = input.profileRef ?? `fake_brand_${input.brandId.toLowerCase()}`
    const profile = this.profile(profileRef)
    const name = input.displayName.replace(/\s+/g, ' ').trim().slice(0, 100)
    if (name) profile.displayName = name
    return { profileRef }
  }

  async createConnectLink(i: { profileRef: string; platforms: Platform[]; redirectUrl?: string }): Promise<{ url: string; expiresAt: string }> {
    this.enter('createConnectLink', i)
    const input = parse(ConnectSchema, i, 'Connect request')
    this.profile(input.profileRef)
    const platforms = [...new Set(input.platforms)]
    if (this.autoConnect) for (const p of platforms) if (!this.profile(input.profileRef).accounts.has(p)) this.connectAccount(input.profileRef, p)
    let url: URL
    if (input.redirectUrl) {
      url = new URL(input.redirectUrl)
      url.searchParams.set('connect_status', 'success')
      if (platforms[0]) url.searchParams.set('platform', platforms[0])
      url.searchParams.set('fake', '1')
    } else {
      url = new URL(`${this.baseUrl}/connect/${encodeURIComponent(input.profileRef)}`)
      if (platforms.length > 0) url.searchParams.set('platforms', platforms.join(','))
    }
    const expiresAt = new Date(this.clock.now().getTime() + 48 * 3_600_000).toISOString()
    return { url: url.toString(), expiresAt }
  }

  async listAccounts(profileRef: string): Promise<ProviderAccount[]> {
    this.enter('listAccounts', profileRef)
    const ref = parse(ProfileRefSchema, profileRef, 'Profile id')
    const accounts = this.profiles.get(ref)?.accounts
    return PLATFORMS.flatMap((p) => {
      const a = accounts?.get(p)
      return a ? [{ ...a }] : []
    })
  }

  async disconnect(i: { profileRef: string; platform: Platform }): Promise<void> {
    this.enter('disconnect', i)
    const input = parse(DisconnectSchema, i, 'Disconnect request')
    this.profiles.get(input.profileRef)?.accounts.delete(input.platform)
  }

  async deleteProfile(profileRef: string): Promise<void> {
    this.enter('deleteProfile', profileRef)
    this.profiles.delete(parse(ProfileRefSchema, profileRef, 'Profile id'))
  }

  async publish(i: PublishInput): Promise<{ requestId: string }> {
    this.enter('publish', i)
    const input = parsePublishInput(i, { allowHttpMedia: true })
    const requestId = `fake_${input.platform}_${hash(input.platform, input.idempotencyKey).slice(0, 24)}`
    if (this.uploads.has(requestId)) return { requestId } // idempotent replay

    if (this.strictAccounts) {
      const account = this.profiles.get(input.profileRef)?.accounts.get(input.platform)
      if (!account || account.status !== 'active') {
        throw providerError(
          'provider_rejected',
          `No ${PLATFORM_LABELS[input.platform]} account is connected to this brand. Connect it and try again.`,
          { provider: PROVIDER, status: 400 },
        )
      }
    }
    const failure = this.nextUploadFailure
    this.nextUploadFailure = null
    this.uploads.set(requestId, {
      requestId,
      profileRef: input.profileRef,
      platform: input.platform,
      kind: input.kind,
      text: input.text,
      title: input.title,
      mediaUrls: [...input.mediaUrls],
      options: { ...(input.options as Record<string, unknown>) },
      idempotencyKey: input.idempotencyKey,
      pollsLeft: this.statusDelay,
      outcome: failure === null ? { state: 'published' } : { state: 'failed', error: failure },
      publishedAt: null,
    })
    return { requestId }
  }

  async getStatus(requestId: string): Promise<PublishStatus> {
    this.enter('getStatus', requestId)
    const id = parse(RequestIdSchema, requestId, 'Request id')
    const upload = this.uploads.get(id)
    if (!upload) {
      const platform = FAKE_REQUEST_ID.exec(id)?.[1]
      if (platform && (PLATFORMS as readonly string[]).includes(platform)) return this.publishedStatus(id, platform as Platform)
      throw providerError('not_found', 'The posting service has no record of this upload.', { provider: PROVIDER, status: 404 })
    }
    if (upload.pollsLeft > 0) {
      upload.pollsLeft -= 1
      return { state: 'pending' }
    }
    if (upload.outcome.state === 'failed') return { state: 'failed', error: upload.outcome.error }
    upload.publishedAt ??= this.clock.now().toISOString()
    return this.publishedStatus(id, upload.platform)
  }

  async getPostMetrics(i: { requestId?: string; platformPostId?: string; platform: Platform; profileRef: string }): Promise<Metrics> {
    this.enter('getPostMetrics', i)
    const input = parse(PostMetricsSchema, i, 'Post metrics request')
    const key = input.requestId ?? input.platformPostId ?? ''
    const scripted = this.postMetrics.get(key) ?? (input.platformPostId ? this.postMetrics.get(input.platformPostId) : undefined)
    if (scripted) return { ...scripted }
    const h = hash('post', input.platform, key)
    const views = 100 + num(h, 0, 9_900)
    return {
      views,
      likes: Math.floor(views / 10) + num(h, 8, 50),
      comments: num(h, 16, 40),
      shares: num(h, 24, 30),
      saves: num(h, 32, 25),
    }
  }

  async getAccountMetrics(i: { profileRef: string; platforms: Platform[] }): Promise<Array<{ platform: Platform; metrics: Metrics }>> {
    this.enter('getAccountMetrics', i)
    const input = parse(AccountMetricsSchema, i, 'Account metrics request')
    return [...new Set(input.platforms)].map((platform) => {
      const scripted = this.accountMetrics.get(`${input.profileRef}\n${platform}`)
      if (scripted) return { platform, metrics: { ...scripted } }
      const h = hash('account', input.profileRef, platform)
      const followers = 50 + num(h, 0, 20_000)
      return {
        platform,
        metrics: {
          followers,
          views: followers * 3 + num(h, 8, 1_000),
          reach: followers * 2 + num(h, 16, 500),
          impressions: followers * 4 + num(h, 24, 2_000),
          likes: num(h, 32, 3_000),
          comments: num(h, 40, 400),
        },
      }
    })
  }

  async listPastPosts(i: { profileRef: string; platform: Platform; cursor?: string; limit?: number }): Promise<{
    posts: PastPostInput[]
    nextCursor?: string
  }> {
    this.enter('listPastPosts', i)
    const input = parse(PastPostsSchema, i, 'Past posts request')
    const all = this.pastPosts.get(`${input.profileRef}\n${input.platform}`) ?? this.generatedPastPosts(input.profileRef, input.platform)
    const offset = input.cursor ? Number(input.cursor.slice(2)) : 0
    const limit = input.limit ?? 25
    const posts = all.slice(offset, offset + limit).map((p) => ({ ...p, metrics: { ...p.metrics } }))
    const next = offset + limit
    return next < all.length ? { posts, nextCursor: `o:${next}` } : { posts }
  }

  // --- internals ------------------------------------------------------------------

  private enter(method: FakeMethod, input: unknown): void {
    this.calls.push({ method, input })
    const queue = this.failures.get(method)
    const error = queue?.shift()
    if (error) throw error
  }

  private profile(profileRef: string): FakeProfile {
    let p = this.profiles.get(profileRef)
    if (!p) {
      p = { profileRef, displayName: '', accounts: new Map() }
      this.profiles.set(profileRef, p)
    }
    return p
  }

  private publishedStatus(requestId: string, platform: Platform): PublishStatus {
    const postId = `fake-post-${hash('post-id', requestId).slice(0, 16)}`
    return { state: 'published', postId, url: `${this.baseUrl}/${platform}/posts/${postId}` }
  }

  private generatedPastPosts(profileRef: string, platform: Platform): PastPostInput[] {
    const now = this.clock.now().getTime()
    return Array.from({ length: this.pastPostsPerPlatform }, (_, n) => {
      const h = hash('past', profileRef, platform, String(n))
      const externalPostId = `fake-past-${h.slice(0, 16)}`
      return {
        platform,
        externalPostId,
        text: `Sample ${PLATFORM_LABELS[platform]} post #${n + 1} from ${profileRef}.`,
        mediaType: platform === 'tiktok' || platform === 'youtube' ? 'VIDEO' : n % 3 === 0 ? 'TEXT' : 'IMAGE',
        postedAt: new Date(now - (n + 1) * 86_400_000).toISOString(),
        permalink: `${this.baseUrl}/${platform}/p/${externalPostId}`,
        metrics: { views: 100 + num(h, 0, 5_000), likes: num(h, 8, 500), comments: num(h, 16, 60) },
      }
    })
  }
}
