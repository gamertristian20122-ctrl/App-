// Posts: scheduling an approved draft (one post per variant), platform caps (rolling 24 h per
// connected account), reschedule / cancel / status / calendar, and the worker's publish cycle
// (preparePublish → provider.publish → recordPublishRequest → recordPublishStatus).

import { z } from 'zod'
import { AppError, isAppError } from '@app/core/errors'
import { CAPS_PER_24H, contentKindFor, countInBusiestWindow } from '@app/core/platforms'
import type { PublishInput, PublishStatus } from '@app/core/ports'
import { DAY_MS, POST_METRIC_CHECKPOINTS_MS, addMs, backoffMs, capQueryRange } from '@app/core/time'
import { PLATFORM_LABELS, PostStatusSchema, type Actor, type Platform, type PostStatus } from '@app/core/types'
import { IdSchema, PostStatusInputSchema, createScheduleAtSchema, createScheduleInputSchema } from '@app/core/validation'
import type { AccountRow, BoundRepos, PostRow, VariantRow } from '@app/db'
import { accountProblem, resolveAccountIn } from './accounts'
import { auditIn } from './audit'
import {
  conflict,
  errorMessage,
  fromZod,
  id,
  notFound,
  requireActiveBrand,
  requireDraft,
  requirePost,
  requireUser,
  userIdOf,
  validation,
  withErrors,
  type Ctx,
} from './context'
import { requireCanCreate, userEntitlements } from './entitlements'
import { enqueueJob } from './jobs'
import { recordConsumptionIn } from './usage'

// ---------------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------------

/**
 * The most posts in any rolling-24 h window that contains `at` (existing + the new one).
 * core's countInBusiestWindow now also tries the window that starts at `at`; the extra candidate
 * here is kept as a belt-and-braces check.
 */
export function busiestWindowCount(times: readonly Date[], at: Date): number {
  const t = at.getTime()
  const after = times.filter((d) => d.getTime() >= t && d.getTime() < t + DAY_MS).length + 1
  return Math.max(countInBusiestWindow(times, at), after)
}

/** Whether one more post at `at` would exceed the platform's rolling-24 h cap. */
export function exceedsCap(platform: Platform, times: readonly Date[], at: Date): boolean {
  return busiestWindowCount(times, at) > CAPS_PER_24H[platform]
}

/** The earliest time ≥ `at` (within 24 h) at which one more post fits under the cap, or null. */
export function nextFreeSlot(platform: Platform, times: readonly Date[], at: Date): Date | null {
  const candidates = [at.getTime(), ...times.map((t) => t.getTime() + DAY_MS)]
    .filter((t) => t >= at.getTime() && t <= at.getTime() + DAY_MS)
    .sort((a, b) => a - b)
  for (const t of candidates) {
    const when = new Date(t)
    if (!exceedsCap(platform, times, when)) return when
  }
  return null
}

function capError(platform: Platform, at: Date, suggested: Date | null): AppError {
  const cap = CAPS_PER_24H[platform]
  const label = PLATFORM_LABELS[platform]
  const hint = suggested ? ` The next free time is ${suggested.toISOString()}.` : ' Pick a later time.'
  return new AppError('cap_reached', `${label} allows ${cap} posts per account in any 24 hours; this time is full.${hint}`, {
    platform,
    cap,
    at: at.toISOString(),
    ...(suggested ? { suggestedAt: suggested.toISOString() } : {}),
  })
}

/** Active post times of an account around `at` (excluding one occurrence of `exclude`). */
async function capTimesIn(r: BoundRepos, userId: string, accountId: string, at: Date, exclude?: Date): Promise<Date[]> {
  const range = capQueryRange(at)
  const times = await r.posts.activeTimesInRange(userId, accountId, range.start, addMs(range.end, DAY_MS))
  if (exclude) {
    const i = times.findIndex((t) => t.getTime() === exclude.getTime())
    if (i >= 0) times.splice(i, 1)
  }
  return times
}

async function assertCapIn(r: BoundRepos, userId: string, account: AccountRow, at: Date, exclude?: Date): Promise<void> {
  const times = await capTimesIn(r, userId, account.id, at, exclude)
  if (exceedsCap(account.platform, times, at)) throw capError(account.platform, at, nextFreeSlot(account.platform, times, at))
}

// ---------------------------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------------------------

export interface CalendarItem {
  post: PostRow
  text: string
  title: string | null
}

export type PublishPlan =
  | { action: 'publish'; post: PostRow; input: PublishInput }
  | { action: 'skip'; reason: 'not_scheduled' | 'not_approved'; post: PostRow }
  /** Ran early (rescheduled post or clock skew): a job for `retryAt` exists; the worker may also retry this one then. */
  | { action: 'skip'; reason: 'not_due'; retryAt: Date; post: PostRow }
  | { action: 'deferred'; reason: 'cap' | 'held' | 'brand_paused'; until: Date; post: PostRow }
  | { action: 'failed'; reason: 'account' | 'media' | 'brand'; message: string; post: PostRow }

export interface StatusResult {
  post: PostRow
  /** When the next status poll is queued (pending). */
  nextPollAt?: Date
}

const PublishStatusSchema = z.object({
  state: z.enum(['pending', 'published', 'failed']),
  postId: z.string().max(500).optional(),
  url: z.string().max(2048).optional(),
  error: z.string().max(4000).optional(),
})

const CalendarSchema = z
  .strictObject({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    brandId: IdSchema.optional(),
    status: z.array(PostStatusSchema).max(5).optional(),
  })
  .refine((v) => new Date(v.to).getTime() > new Date(v.from).getTime(), 'to must be after from.')
  .refine((v) => new Date(v.to).getTime() - new Date(v.from).getTime() <= 93 * DAY_MS, 'Ask for at most 93 days.')

const ListPostsSchema = z.strictObject({
  brandId: IdSchema.optional(),
  draftId: IdSchema.optional(),
  status: z.array(PostStatusSchema).max(5).optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

const ProviderRequestSchema = z.string().trim().min(1).max(200)

const publishJobKey = (postId: string, at: Date) => `publish_post:${postId}:${at.getTime()}`

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export function createPostsService(ctx: Ctx) {
  async function enqueuePublish(r: BoundRepos, userId: string, postId: string, at: Date, key = publishJobKey(postId, at)) {
    return enqueueJob(r, { type: 'publish_post', payload: { userId, postId }, runAt: at, idempotencyKey: key })
  }

  async function onPublishedIn(r: BoundRepos, userId: string, post: PostRow): Promise<void> {
    const variant = await r.drafts.getVariant(userId, post.variantId)
    if (post.platform === 'x' && variant?.hasLink) {
      await recordConsumptionIn(ctx, r, userId, {
        meter: 'x_link_posts',
        amount: 1,
        idempotencyKey: `x_link_posts:${post.id}`,
        subjectType: 'post',
        subjectId: post.id,
      })
    }
    const base = post.publishedAt ?? ctx.now()
    for (const ms of POST_METRIC_CHECKPOINTS_MS) {
      await enqueueJob(r, {
        type: 'analytics_pull',
        payload: { scope: 'post', userId, postId: post.id, checkpointMs: ms },
        runAt: addMs(base, ms),
        idempotencyKey: `analytics_pull:${post.id}:${ms}`,
      })
    }
    await auditIn(r, userId, {
      actor: 'worker',
      action: 'post.published',
      subjectType: 'post',
      subjectId: post.id,
      meta: { platform: post.platform, url: post.postUrl },
    })
  }

  async function failIn(r: BoundRepos, userId: string, post: PostRow, message: string): Promise<PostRow> {
    const row = (await r.posts.markFailed(userId, post.id, message)) ?? post
    await auditIn(r, userId, {
      actor: 'worker',
      action: 'post.failed',
      subjectType: 'post',
      subjectId: post.id,
      meta: { platform: post.platform, reason: message.slice(0, 300) },
    })
    return row
  }

  return withErrors({
    /**
     * schedule_post: one post per variant of an approved draft (optionally only some platforms)
     * at `at` (ISO with offset, or "now"). Only drafts approved at their current revision can be
     * scheduled. Platform caps are checked per connected account for every 24 h window around
     * `at`. Scheduling a variant that is already scheduled moves it (no re-approval; audited).
     */
    async schedule(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<PostRow[]> {
      const uid = userIdOf(userId)
      const data = fromZod(createScheduleInputSchema(ctx.clock), input, 'Schedule')
      const at = new Date(data.at)
      const via = options.via ?? 'mcp'
      return ctx.tx(async (r) => {
        // the user lock serialises cap checks for all of the user's accounts
        const user = await requireUser(r, uid, true)
        requireCanCreate(userEntitlements(user, ctx.now()))
        const draft = await r.drafts.lockForUpdate(uid, data.draftId)
        if (!draft) throw notFound('Draft')
        if (draft.status !== 'approved' || draft.approvedRevision !== draft.revision) {
          throw conflict(
            draft.status === 'approved'
              ? 'The draft changed after it was approved. Approve it again first.'
              : 'Only approved drafts can be scheduled. Ask the user to approve it first.',
            { reason: 'not_approved', status: draft.status },
          )
        }
        const brand = await requireActiveBrand(r, uid, draft.brandId)
        const variants = await r.drafts.listVariants(uid, draft.id)
        let selected: VariantRow[] = variants
        if (data.platforms) {
          const missing = data.platforms.filter((p) => !variants.some((v) => v.platform === p))
          if (missing.length > 0) {
            throw validation(`This draft has no ${missing.map((p) => PLATFORM_LABELS[p]).join(', ')} version.`, { missing })
          }
          selected = variants.filter((v) => data.platforms?.includes(v.platform))
        }
        const existing = await r.posts.list(uid, { draftId: draft.id, limit: 1000 })
        const out: PostRow[] = []
        for (const variant of selected) {
          const account = await resolveAccountIn(r, uid, brand.id, variant)
          const problem = accountProblem(variant.platform, account)
          if (problem || !account) throw validation(problem ?? 'Connect an account first.', { platform: variant.platform })
          const active = existing.find((p) => p.variantId === variant.id && (p.status === 'scheduled' || p.status === 'publishing' || p.status === 'published'))
          if (active && active.status !== 'scheduled') {
            throw conflict(`The ${PLATFORM_LABELS[variant.platform]} post was already published for this approval.`, {
              postId: active.id,
              status: active.status,
            })
          }
          if (active) {
            await assertCapIn(r, uid, account, at, active.scheduledFor)
            const moved = await r.posts.reschedule(uid, active.id, at)
            if (!moved) throw conflict('The post could not be moved.')
            await enqueuePublish(r, uid, moved.id, at)
            await auditIn(r, uid, {
              actor: via,
              action: 'post.rescheduled',
              subjectType: 'post',
              subjectId: moved.id,
              meta: { from: active.scheduledFor.toISOString(), to: at.toISOString() },
            })
            out.push(moved)
            continue
          }
          await assertCapIn(r, uid, account, at)
          const post = await r.posts.create(uid, {
            brandId: brand.id,
            draftId: draft.id,
            variantId: variant.id,
            connectedAccountId: account.id,
            platform: variant.platform,
            scheduledFor: at,
            approvedRevision: draft.revision,
            provider: ctx.provider.name,
          })
          await enqueuePublish(r, uid, post.id, at)
          await auditIn(r, uid, {
            actor: via,
            action: 'post.scheduled',
            subjectType: 'post',
            subjectId: post.id,
            meta: { platform: post.platform, at: at.toISOString(), revision: draft.revision },
          })
          out.push(post)
        }
        return out
      })
    },

    /** Moves a scheduled post (no re-approval needed; audited; caps re-checked). */
    async reschedule(userId: string, postId: string, atInput: string, options: { via?: Actor } = {}): Promise<PostRow> {
      const uid = userIdOf(userId)
      const at = new Date(fromZod(createScheduleAtSchema(ctx.clock), atInput, 'Time'))
      return ctx.tx(async (r) => {
        const user = await requireUser(r, uid, true)
        requireCanCreate(userEntitlements(user, ctx.now()))
        const post = await requirePost(r, uid, postId)
        if (post.status !== 'scheduled') throw conflict('Only scheduled posts can be moved.', { status: post.status })
        const account = await r.accounts.get(uid, post.connectedAccountId)
        if (!account) throw notFound('Connected account')
        await assertCapIn(r, uid, account, at, post.scheduledFor)
        const moved = await r.posts.reschedule(uid, post.id, at)
        if (!moved) throw conflict('The post could not be moved.')
        await enqueuePublish(r, uid, moved.id, at)
        await auditIn(r, uid, {
          actor: options.via ?? 'web',
          action: 'post.rescheduled',
          subjectType: 'post',
          subjectId: post.id,
          meta: { from: post.scheduledFor.toISOString(), to: at.toISOString() },
        })
        return moved
      })
    },

    /** Cancels a scheduled (or failed) post. Publishing / published posts cannot be canceled. */
    async cancel(userId: string, postId: string, options: { via?: Actor; reason?: string } = {}): Promise<PostRow> {
      const uid = userIdOf(userId)
      return ctx.tx(async (r) => {
        const post = await requirePost(r, uid, postId)
        if (post.status === 'canceled') return post
        const row = await r.posts.cancel(uid, post.id, options.reason?.slice(0, 500) ?? 'Canceled by the user.')
        if (!row) throw conflict('This post is already publishing or published and cannot be canceled.', { status: post.status })
        await auditIn(r, uid, { actor: options.via ?? 'web', action: 'post.canceled', subjectType: 'post', subjectId: post.id })
        return row
      })
    },

    async get(userId: string, postId: string): Promise<PostRow> {
      return requirePost(ctx.repos, userIdOf(userId), postId)
    },

    /** post_status: one post, or every post of a draft. */
    async status(userId: string, input: unknown): Promise<PostRow[]> {
      const uid = userIdOf(userId)
      const data = fromZod(PostStatusInputSchema, input, 'Status request')
      if (data.postId) return [await requirePost(ctx.repos, uid, data.postId)]
      const draft = await requireDraft(ctx.repos, uid, data.draftId)
      return ctx.repos.posts.list(uid, { draftId: draft.id, limit: 100 })
    },

    async list(userId: string, input: unknown = {}): Promise<PostRow[]> {
      const uid = userIdOf(userId)
      const data = fromZod(ListPostsSchema, input ?? {}, 'Filter')
      return ctx.repos.posts.list(uid, {
        ...(data.brandId ? { brandId: data.brandId } : {}),
        ...(data.draftId ? { draftId: data.draftId } : {}),
        ...(data.status ? { status: data.status as PostStatus[] } : {}),
        limit: data.limit,
      })
    },

    /** Posts whose time falls in [from, to), with the variant text (calendar view). */
    async calendar(userId: string, input: unknown): Promise<CalendarItem[]> {
      const uid = userIdOf(userId)
      const data = fromZod(CalendarSchema, input, 'Calendar range')
      const posts = await ctx.repos.posts.list(uid, {
        from: new Date(data.from),
        to: new Date(data.to),
        ...(data.brandId ? { brandId: data.brandId } : {}),
        ...(data.status ? { status: data.status as PostStatus[] } : {}),
        limit: 1000,
      })
      const variants = await ctx.repos.drafts.listVariantsForDrafts(uid, [...new Set(posts.map((p) => p.draftId))])
      const byId = new Map(variants.map((v) => [v.id, v]))
      return posts.map((post) => {
        const v = byId.get(post.variantId)
        return { post, text: (v?.text ?? '').slice(0, 500), title: v?.title ?? null }
      })
    },

    // -------------------------------------------------------------------------------------------
    // Worker
    // -------------------------------------------------------------------------------------------

    /**
     * publish_post job: decides what to do with a due post and, when it may publish, claims it
     * (scheduled → publishing) and returns the provider input (media as presigned GET URLs).
     * Re-checks at dispatch: approval at the post's revision, entitlements (held accounts wait),
     * the brand, the connected account, media, and the platform cap (full → moved +1 h).
     */
    async preparePublish(userId: string, postId: string): Promise<PublishPlan> {
      const uid = userIdOf(userId)
      const now = ctx.now()
      const post = await requirePost(ctx.repos, uid, postId)
      if (post.status !== 'scheduled') return { action: 'skip', reason: 'not_scheduled', post }
      if (post.scheduledFor.getTime() > now.getTime() + ctx.config.publishEarlyToleranceMs) {
        await enqueuePublish(ctx.repos, uid, post.id, post.scheduledFor)
        return { action: 'skip', reason: 'not_due', retryAt: post.scheduledFor, post }
      }
      const brand = await ctx.repos.brands.get(uid, post.brandId)
      if (!brand || brand.status === 'archived') {
        const failed = await ctx.tx((r) => failIn(r, uid, post, 'The brand was archived.'))
        return { action: 'failed', reason: 'brand', message: 'The brand was archived.', post: failed }
      }
      let profileRef = brand.providerProfileRef
      if (!profileRef) {
        profileRef = (await ctx.provider.ensureProfile({ brandId: brand.id, profileRef: null, displayName: brand.name })).profileRef
        await ctx.repos.brands.setProviderProfileRef(uid, brand.id, profileRef)
      }

      return ctx.tx(async (r): Promise<PublishPlan> => {
        const user = await requireUser(r, uid, true)
        const ent = userEntitlements(user, now)
        if (!ent.canPublish || brand.status === 'suspended') {
          const until = addMs(now, ctx.config.heldRetryDelayMs)
          await enqueuePublish(r, uid, post.id, until, `publish_post:${post.id}:held:${until.getTime()}`)
          return { action: 'deferred', reason: ent.canPublish ? 'brand_paused' : 'held', until, post }
        }
        const account = await r.accounts.get(uid, post.connectedAccountId)
        const problem = accountProblem(post.platform, account)
        if (problem) return { action: 'failed', reason: 'account', message: problem, post: await failIn(r, uid, post, problem) }

        const times = await capTimesIn(r, uid, post.connectedAccountId, now, post.scheduledFor)
        if (exceedsCap(post.platform, times, now)) {
          const until = addMs(now, ctx.config.capRetryDelayMs)
          const moved = (await r.posts.reschedule(uid, post.id, until)) ?? post
          await enqueuePublish(r, uid, post.id, until)
          await auditIn(r, uid, {
            actor: 'worker',
            action: 'post.cap_deferred',
            subjectType: 'post',
            subjectId: post.id,
            meta: { platform: post.platform, until: until.toISOString() },
          })
          return { action: 'deferred', reason: 'cap', until, post: moved }
        }

        const variant = await r.drafts.getVariant(uid, post.variantId)
        if (!variant) return { action: 'skip', reason: 'not_approved', post }
        const media = await r.media.getMany(uid, variant.mediaIds)
        const byId = new Map(media.map((m) => [m.id, m]))
        const ordered = variant.mediaIds.map((m) => byId.get(m))
        if (ordered.some((m) => !m || m.status !== 'ready')) {
          const message = 'An attached file is missing or not ready.'
          return { action: 'failed', reason: 'media', message, post: await failIn(r, uid, post, message) }
        }
        const ready = ordered.filter((m): m is NonNullable<typeof m> => m !== undefined)
        const mediaUrls: string[] = []
        for (const m of ready) mediaUrls.push(await ctx.storage.presignGet(m.storageKey, ctx.config.publishUrlTtlSec))

        const claimed = await r.posts.claimForPublish(uid, post.id)
        if (!claimed) return { action: 'skip', reason: 'not_approved', post }
        const input: PublishInput = {
          profileRef: profileRef as string,
          platform: post.platform,
          kind: contentKindFor(ready),
          text: variant.text,
          ...(variant.title ? { title: variant.title } : {}),
          mediaUrls,
          options: variant.options,
          idempotencyKey: `post:${post.id}`,
        }
        return { action: 'publish', post: claimed, input }
      })
    },

    /** After provider.publish: stores the request id and queues the first status poll. */
    async recordPublishRequest(userId: string, postId: string, requestId: string): Promise<PostRow> {
      const uid = userIdOf(userId)
      const rid = fromZod(ProviderRequestSchema, requestId, 'Request id')
      return ctx.tx(async (r) => {
        const post = await requirePost(r, uid, postId)
        const row = (await r.posts.setProviderRequest(uid, post.id, { providerRequestId: rid, provider: ctx.provider.name })) ?? post
        await enqueueJob(r, {
          type: 'check_post_status',
          payload: { userId: uid, postId: post.id, poll: 1 },
          runAt: addMs(ctx.now(), ctx.config.statusPollDelayMs),
          idempotencyKey: `check_post_status:${post.id}:1`,
        })
        await auditIn(r, uid, { actor: 'worker', action: 'post.submitted', subjectType: 'post', subjectId: post.id })
        return row
      })
    },

    /**
     * check_post_status job / provider webhook: applies the provider's answer. published → live
     * (X link metering, analytics checkpoints queued); failed → failed; pending → next poll
     * (backing off), or failed after the poll budget.
     */
    async recordPublishStatus(userId: string, postId: string, status: PublishStatus, options: { poll?: number } = {}): Promise<StatusResult> {
      const uid = userIdOf(userId)
      const s = fromZod(PublishStatusSchema, status, 'Status')
      const poll = Math.max(0, Math.floor(options.poll ?? 0))
      return ctx.tx(async (r): Promise<StatusResult> => {
        const post = await requirePost(r, uid, postId)
        if (s.state === 'published') {
          if (post.status === 'published') return { post }
          if (post.status !== 'publishing' && post.status !== 'failed') return { post }
          const url = s.url && /^https?:\/\//.test(s.url) ? s.url : null
          const row = await r.posts.markPublished(uid, post.id, { providerPostId: s.postId ?? null, postUrl: url, publishedAt: ctx.now() })
          if (!row) return { post }
          await onPublishedIn(r, uid, row)
          return { post: row }
        }
        if (post.status !== 'publishing') return { post }
        if (s.state === 'failed') {
          return { post: await failIn(r, uid, post, s.error?.slice(0, 1000) || 'The platform rejected the post.') }
        }
        if (poll >= ctx.config.statusPollMaxPolls) {
          return { post: await failIn(r, uid, post, 'The platform did not confirm the post in time. Check the account before retrying.') }
        }
        const delay = Math.min(ctx.config.statusPollMaxDelayMs, ctx.config.statusPollDelayMs * 2 ** Math.min(poll, 20))
        const nextPollAt = addMs(ctx.now(), delay)
        await enqueueJob(r, {
          type: 'check_post_status',
          payload: { userId: uid, postId: post.id, poll: poll + 1 },
          runAt: nextPollAt,
          idempotencyKey: `check_post_status:${post.id}:${poll + 1}`,
        })
        return { post, nextPollAt }
      })
    },

    /**
     * provider.publish threw. Retryable errors (rate limits, outages, the provider's cap) put the
     * post back to scheduled at a later time (provider retryAfter, else backoff); others fail it.
     */
    async recordPublishError(
      userId: string,
      postId: string,
      error: unknown,
      options: { retryable?: boolean; retryAfterMs?: number; maxAttempts?: number } = {},
    ): Promise<PostRow> {
      const uid = userIdOf(userId)
      const message = errorMessage(error, 'Publishing failed.')
      const retryable = options.retryable ?? (isAppError(error) && error.retryable)
      return ctx.tx(async (r) => {
        const post = await requirePost(r, uid, postId)
        if (post.status !== 'publishing' && post.status !== 'scheduled') return post
        const maxAttempts = options.maxAttempts ?? 5
        if (retryable && post.attempts < maxAttempts) {
          const delay = Math.max(1_000, options.retryAfterMs ?? backoffMs(post.attempts))
          const at = addMs(ctx.now(), delay)
          const row = post.status === 'publishing' ? await r.posts.requeue(uid, post.id, at, message) : await r.posts.reschedule(uid, post.id, at)
          if (!row) return failIn(r, uid, post, message)
          await enqueuePublish(r, uid, post.id, at)
          await auditIn(r, uid, {
            actor: 'worker',
            action: 'post.retry_scheduled',
            subjectType: 'post',
            subjectId: post.id,
            meta: { at: at.toISOString(), attempts: post.attempts },
          })
          return row
        }
        return failIn(r, uid, post, message)
      })
    },

    /** Upload-Post webhook lookup (system: verify the webhook before calling). */
    async findByProviderRequest(providerRequestId: string, platform?: Platform): Promise<PostRow[]> {
      const rid = fromZod(ProviderRequestSchema, providerRequestId, 'Request id')
      return ctx.repos.posts.findByProviderRequest(ctx.provider.name, rid, platform)
    },

    /** Sweeper (cron/cleanup): re-queues publish jobs for due scheduled posts whose job was lost. */
    async enqueueDue(now: Date = ctx.now(), limit = 200): Promise<number> {
      const due = await ctx.repos.maintenance.listDuePosts(now, limit)
      let created = 0
      for (const post of due) {
        const result = await enqueuePublish(ctx.repos, post.userId, post.id, now, `publish_post:${post.id}:sweep:${post.scheduledFor.getTime()}`)
        if (result.created) created += 1
      }
      return created
    },

    /** Validated post id helper for callers holding raw input. */
    parsePostId: (value: unknown) => id(value, 'Post'),
  })
}

export type PostsService = ReturnType<typeof createPostsService>
