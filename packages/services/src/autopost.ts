// Auto-post: the ONE publish rule every path uses (publish_video, and the worker after make_clips /
// render_video / render_carousel / render_code_video when the AI asked for autoPublish).
//
// A draft an AI or the worker just made is approved by the rule (approved_via 'auto_post') and
// scheduled only when ALL of these hold; otherwise it waits for the person's approval (approval
// card / web queue) and the reason is returned and stored on the draft:
//   1. the brand's Auto-post switch is on (only the person turns it on, in the web app);
//   2. every platform of the draft is on the brand's Auto-post list (an empty list = all);
//   3. fewer than the brand's daily maximum drafts were approved by the rule in the last 24 h;
//   4. the draft passes the same checks as a human approval (publish-strict validation, media
//      ready, accounts connected, X link rule, plan not on hold, TikTok privacy chosen);
//   5. every post fits under its platform's rolling 24 h cap at its time (exactly as
//      schedule_post checks it). "best" picks the first default slot that fits.
// The rule decides once per draft (the decision is stored). While the draft's video is still
// processing it waits, and media.markIngested decides it in the same transaction that marks the
// file ready. The database refuses an 'auto_post' approval when the switch is off (0004 trigger),
// and posts can only be inserted for an approved draft at its current revision (0001 trigger).

import { AppError, isAppError } from '@app/core/errors'
import { AUTO_POST_OUTCOME_LABELS, bestSlotTimes, nextMinute, type AutoPostOutcome } from '@app/core/autopost'
import { PLATFORM_RULES } from '@app/core/platforms'
import { DAY_MS } from '@app/core/time'
import { PLATFORM_LABELS, type Actor, type Platform } from '@app/core/types'
import { AutoPublishSchema, PublishVideoInputSchema, createScheduleAtSchema, type AutoPublishWhen } from '@app/core/validation'
import type { AccountRow, BoundRepos, BrandRow, DraftRow, MediaRow, PostRow, VariantRow } from '@app/db'
import { resolveAccountIn } from './accounts'
import { auditIn } from './audit'
import { conflict, fromZod, id, notFound, requireActiveBrand, requireDraft, requireMedia, requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { draftReadinessIn, type DraftsService, type DraftView } from './drafts'
import { requireCanCreate, userEntitlements } from './entitlements'
import { ensureUploadsComplete } from './media'
import { capError, capTimesIn, enqueuePublishIn, exceedsCap, nextFreeSlot } from './posts'

export type AutoPostDecision = AutoPostOutcome | 'waiting_for_media'

export interface AutoPostResult {
  draftId: string
  /** What the rule decided ('waiting_for_media': it decides when the file is ready). */
  outcome: AutoPostDecision
  /** Approved by the rule and scheduled. */
  autoPosted: boolean
  /** Why, in words for the AI and the person. */
  message: string
  /** The scheduled posts (auto-posted only). */
  posts: PostRow[]
}

export interface PublishVideoResult {
  draft: DraftView
  autoPost: AutoPostResult
}

const WAITING = "It waits for the user's approval (approval card or the web app's approval queue)."

function labels(platforms: readonly Platform[]): string {
  const names = platforms.map((p) => PLATFORM_LABELS[p])
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Normalises "now" | "best" | ISO; an ISO time must be ahead and within the scheduling window. */
function checkWhen(ctx: Ctx, when: AutoPublishWhen, options: { allowPast?: boolean } = {}): string {
  if (when === 'now' || when === 'best') return when
  const at = new Date(when)
  if (options.allowPast && !Number.isNaN(at.getTime()) && at.getTime() <= ctx.now().getTime()) return at.toISOString()
  return fromZod(createScheduleAtSchema(ctx.clock), when, 'when')
}

/** Candidate publish times for one platform (one for "now" / ISO, the day's slots for "best"). */
function candidateTimes(when: string | null, platform: Platform, now: Date, timeZone: string): Date[] {
  if (when === 'best') return bestSlotTimes(platform, now, timeZone)
  if (when && when !== 'now') {
    const at = new Date(when)
    // the requested time passed while the video was processing: post at the next minute
    if (!Number.isNaN(at.getTime()) && at.getTime() > now.getTime()) return [at]
  }
  return [nextMinute(now)]
}

function cleanTitle(title: string, max: number, forbidden?: string): string {
  let out = title.replace(/\s+/g, ' ').trim()
  if (forbidden) out = [...out].filter((ch) => !forbidden.includes(ch)).join('')
  return [...out].slice(0, max).join('').trim()
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim()
}

async function resultFor(r: BoundRepos, userId: string, draft: DraftRow): Promise<AutoPostResult> {
  const outcome = draft.autoPostOutcome ?? 'waiting_for_media'
  const posts = outcome === 'posted' ? await r.posts.list(userId, { draftId: draft.id, limit: 50 }) : []
  return {
    draftId: draft.id,
    outcome,
    autoPosted: outcome === 'posted',
    message: draft.autoPostNote ?? (draft.autoPostOutcome ? AUTO_POST_OUTCOME_LABELS[draft.autoPostOutcome] : 'Waiting for the video to finish processing.'),
    posts,
  }
}

/**
 * Applies the rule to a draft whose Auto-post was requested (in the caller's transaction). Reads
 * everything first; writes only once it knows the answer, so a refusal never leaves half an
 * approval behind.
 */
async function decideIn(ctx: Ctx, r: BoundRepos, userId: string, draftId: string): Promise<AutoPostResult> {
  const now = ctx.now()
  // the user lock serialises cap checks with schedule_post (same lock order: user, draft, brand)
  const user = await requireUser(r, userId, true)
  const draft = await r.drafts.lockForUpdate(userId, draftId)
  if (!draft) throw notFound('Draft')
  if (!draft.autoPostRequestedAt) throw conflict('Auto-post was not requested for this draft.')
  if (draft.autoPostDecidedAt) return resultFor(r, userId, draft)

  const decide = async (outcome: AutoPostOutcome, message: string, posts: PostRow[] = []): Promise<AutoPostResult> => {
    await r.drafts.decideAutoPost(userId, draft.id, { outcome, note: message, at: now })
    if (outcome !== 'posted') {
      await auditIn(r, userId, {
        actor: 'auto_post',
        action: 'draft.auto_post_declined',
        subjectType: 'draft',
        subjectId: draft.id,
        meta: { outcome, brandId: draft.brandId },
      })
    }
    return { draftId: draft.id, outcome, autoPosted: outcome === 'posted', message, posts }
  }

  if (draft.status !== 'draft') return decide('skipped', 'The draft is no longer waiting for approval (it was approved, rejected or archived).')
  if (draft.createdVia !== 'mcp' && draft.createdVia !== 'worker') return decide('skipped', 'Only drafts made by an AI or the worker are auto-posted.')
  const brand = await r.brands.lockForUpdate(userId, draft.brandId)
  if (!brand) throw notFound('Brand')
  if (!brand.autoPostEnabled) {
    return decide(
      'switch_off',
      `Auto-post is off for ${brand.name}, so this draft was not posted. ${WAITING} Only the user can turn Auto-post on, on the Brands page of the web app.`,
    )
  }
  if (brand.status !== 'active') return decide('not_ready', `The brand ${brand.name} is not active. ${WAITING}`)

  const variants = await r.drafts.listVariants(userId, draft.id)
  if (variants.length === 0) return decide('not_ready', `The draft has no platforms. ${WAITING}`)
  const allowed = brand.autoPostPlatforms
  const outside = allowed.length > 0 ? variants.map((v) => v.platform).filter((p) => !allowed.includes(p)) : []
  if (outside.length > 0) {
    return decide(
      'platform_not_allowed',
      `Auto-post for ${brand.name} covers ${labels(allowed)} only; this draft also targets ${labels(outside)}. ${WAITING}`,
    )
  }

  const media = await r.media.getMany(userId, variants.flatMap((v) => v.mediaIds))
  if (media.some((m) => m.status === 'pending')) {
    return {
      draftId: draft.id,
      outcome: 'waiting_for_media',
      autoPosted: false,
      message: `The video is still processing. Auto-post is on for ${brand.name}: the draft is checked and posted automatically as soon as the file is ready (see post_status with this draftId).`,
      posts: [],
    }
  }

  const used = await r.drafts.countAutoPostedSince(userId, brand.id, new Date(now.getTime() - DAY_MS))
  if (used >= brand.autoPostDailyMax) {
    return decide(
      'daily_max',
      `Auto-post already posted ${used} draft${used === 1 ? '' : 's'} for ${brand.name} in the last 24 hours (the user's daily limit is ${brand.autoPostDailyMax}). ${WAITING}`,
    )
  }
  try {
    requireCanCreate(userEntitlements(user, now))
  } catch (error) {
    if (!isAppError(error)) throw error
    return decide('not_ready', `${error.message} ${WAITING}`)
  }

  // TikTok requires the person to choose who can see a post: the Auto-post settings hold it
  const effective: VariantRow[] = variants.map((v) =>
    v.platform === 'tiktok' && typeof v.options.privacyLevel !== 'string' && brand.autoPostTiktokPrivacy
      ? { ...v, options: { ...v.options, privacyLevel: brand.autoPostTiktokPrivacy } }
      : v,
  )
  const readiness = await draftReadinessIn(r, userId, draft, effective)
  if (!readiness.ready) {
    const tiktok = effective.find((v) => v.platform === 'tiktok' && typeof v.options.privacyLevel !== 'string')
    const issue = readiness.variants.flatMap((v) => v.issues.filter((i) => i.severity === 'error').map((i) => `${PLATFORM_LABELS[v.platform]}: ${i.message}`))[0]
    const first = tiktok
      ? 'Choose who can see auto-posted TikTok videos in the Auto-post settings (Brands page of the web app).'
      : (readiness.problems[0] ?? issue ?? 'The draft is not ready to publish.')
    return decide('not_ready', `This draft cannot be posted yet. ${first} ${WAITING}`)
  }

  // a time for every platform, each under its rolling 24 h cap
  const plan: Array<{ variant: VariantRow; account: AccountRow; at: Date }> = []
  for (const variant of effective) {
    const account = await resolveAccountIn(r, userId, brand.id, variant)
    if (!account) return decide('not_ready', `Connect ${PLATFORM_LABELS[variant.platform]} first. ${WAITING}`)
    const candidates = candidateTimes(draft.autoPostWhen, variant.platform, now, brand.timezone)
    let chosen: Date | null = null
    for (const at of candidates) {
      if (!exceedsCap(variant.platform, await capTimesIn(r, userId, account.id, at), at)) {
        chosen = at
        break
      }
    }
    if (!chosen) {
      const at = candidates[0] ?? nextMinute(now)
      const times = await capTimesIn(r, userId, account.id, at)
      return decide('cap_reached', `${capError(variant.platform, at, nextFreeSlot(variant.platform, times, at)).message} ${WAITING}`)
    }
    plan.push({ variant, account, at: chosen })
  }

  // approve (as 'auto_post') and schedule
  for (const v of effective) {
    const before = variants.find((x) => x.id === v.id)
    if (before && before.options !== v.options) await r.drafts.updateVariant(userId, v.id, { options: v.options })
  }
  const current = (await r.drafts.get(userId, draft.id)) ?? draft
  const approved = await r.drafts.approve(userId, draft.id, { revision: current.revision, via: 'auto_post' })
  if (!approved) throw conflict('The draft changed while it was being auto-posted. Try again.')
  await auditIn(r, userId, {
    actor: 'auto_post',
    action: 'draft.approved',
    subjectType: 'draft',
    subjectId: draft.id,
    meta: { revision: approved.revision, platforms: plan.map((p) => p.variant.platform), brandId: brand.id, rule: 'auto_post' },
  })
  const posts: PostRow[] = []
  for (const p of plan) {
    const post = await r.posts.create(userId, {
      brandId: brand.id,
      draftId: draft.id,
      variantId: p.variant.id,
      connectedAccountId: p.account.id,
      platform: p.variant.platform,
      scheduledFor: p.at,
      approvedRevision: approved.revision,
      provider: ctx.provider.name,
    })
    await enqueuePublishIn(r, userId, post.id, p.at)
    await auditIn(r, userId, {
      actor: 'auto_post',
      action: 'post.scheduled',
      subjectType: 'post',
      subjectId: post.id,
      meta: { platform: post.platform, at: p.at.toISOString(), revision: approved.revision },
    })
    posts.push(post)
  }
  const when = posts.map((p) => `${PLATFORM_LABELS[p.platform]} at ${p.scheduledFor.toISOString()}`).join(', ')
  return decide('posted', `Posted automatically because Auto-post is on for ${brand.name}: ${when}. The user can still cancel it in the web app's calendar.`, posts)
}

/** Records the request (first one wins) and applies the rule, in the caller's transaction. */
async function requestIn(ctx: Ctx, r: BoundRepos, userId: string, draft: DraftRow, when: string, via: Actor): Promise<AutoPostResult> {
  if (!draft.autoPostRequestedAt) {
    await r.drafts.requestAutoPost(userId, draft.id, { when, at: ctx.now() })
    await auditIn(r, userId, { actor: via, action: 'draft.auto_post_requested', subjectType: 'draft', subjectId: draft.id, meta: { when } })
  }
  return decideIn(ctx, r, userId, draft.id)
}

/**
 * media.markIngested hook: the file of drafts that asked for Auto-post is ready, so the rule
 * decides them now (same transaction as the media update).
 */
export async function decideWaitingForMediaIn(ctx: Ctx, r: BoundRepos, userId: string, media: MediaRow): Promise<void> {
  if (media.status !== 'ready') return
  const waiting = await r.drafts.listAwaitingAutoPost(userId, media.id)
  for (const draft of waiting) {
    const result = await decideIn(ctx, r, userId, draft.id)
    ctx.log.info('auto-post decided after processing', { draftId: draft.id, outcome: result.outcome })
  }
}

export function createAutoPostService(ctx: Ctx, deps: { drafts: DraftsService }) {
  return withErrors({
    /**
     * publish_video: one finished video (an upload_media / URL import / render media id) and its
     * caption → a draft for the brand's connected video platforms (or `platforms`) → the rule.
     * Auto-posted when the brand's switch allows it; otherwise the draft waits for approval and
     * the result says why.
     */
    async publishVideo(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<PublishVideoResult> {
      const uid = userIdOf(userId)
      const via = options.via ?? 'mcp'
      const data = fromZod(PublishVideoInputSchema, input, 'Publish request')
      const when = checkWhen(ctx, data.when)
      const brand: BrandRow = await requireActiveBrand(ctx.repos, uid, data.brandId)
      await ensureUploadsComplete(ctx, uid, [data.mediaId], via)
      const media = await requireMedia(ctx.repos, uid, data.mediaId)
      if (media.kind !== 'video') throw validation('publish_video takes a video. For images, use create_draft (or render_carousel).', { mediaId: media.id })
      if (media.status === 'failed') throw validation('This video could not be processed. Send the file again with upload_media.', { mediaId: media.id })

      const accounts = await ctx.repos.accounts.list(uid, { brandId: brand.id, status: 'active' })
      const connected = [...new Set(accounts.map((a) => a.platform))]
      let targets: Platform[]
      if (data.platforms) {
        const noVideo = data.platforms.filter((p) => !PLATFORM_RULES[p].video)
        if (noVideo.length > 0) throw validation(`${labels(noVideo)} ${noVideo.length === 1 ? 'does' : 'do'} not take videos.`, { platforms: noVideo })
        const missing = data.platforms.filter((p) => !connected.includes(p))
        if (missing.length > 0) {
          throw validation(`${labels(missing)} ${missing.length === 1 ? 'is' : 'are'} not connected to ${brand.name}. Connect with connect_account first, or leave it out.`, {
            platforms: missing,
          })
        }
        targets = data.platforms
      } else {
        targets = connected.filter((p) => PLATFORM_RULES[p].video !== null)
      }
      if (targets.length === 0) {
        throw validation(`${brand.name} has no connected account that takes videos. Connect TikTok, YouTube, Instagram or another video platform with connect_account first.`)
      }

      const variants = targets.map((platform) => {
        const o = data.overrides?.[platform]
        const text = o?.text ?? data.caption ?? ''
        const rule = PLATFORM_RULES[platform].title
        const title = rule ? cleanTitle(o?.title ?? data.title ?? firstLine(text), rule.max, rule.forbidden) : ''
        return { platform, text, ...(title ? { title } : {}), mediaIds: [media.id] }
      })
      const view = await deps.drafts.create(uid, { brandId: brand.id, variants, notes: 'Sent by your AI with publish_video.' }, { via })
      const autoPost = await ctx.tx(async (r) => {
        const draft = await requireDraft(r, uid, view.draft.id)
        return requestIn(ctx, r, uid, draft, when, via)
      })
      return { draft: await deps.drafts.get(uid, view.draft.id), autoPost }
    },

    /**
     * Worker (after a render made a draft for a job with autoPublish) and MCP: apply the rule to a
     * draft an AI or the worker made. The rule decides once; later calls return that decision.
     */
    async requestForDraft(userId: string, draftId: string, autoPublish: unknown, options: { via?: Actor } = {}): Promise<AutoPostResult> {
      const uid = userIdOf(userId)
      const via = options.via ?? 'worker'
      if (via !== 'worker' && via !== 'mcp') {
        throw new AppError('forbidden', 'Auto-post is requested by an AI or the worker; people approve drafts directly.', { reason: 'not_ai' })
      }
      const data = fromZod(AutoPublishSchema, autoPublish ?? {}, 'autoPublish')
      const when = checkWhen(ctx, data.when, { allowPast: true })
      return ctx.tx(async (r) => {
        const draft = await requireDraft(r, uid, id(draftId, 'Draft'))
        return requestIn(ctx, r, uid, draft, when, via)
      })
    },

    /** The rule's decision for a draft, or null when Auto-post was never requested for it. */
    async status(userId: string, draftId: string): Promise<AutoPostResult | null> {
      const uid = userIdOf(userId)
      const draft = await requireDraft(ctx.repos, uid, draftId)
      if (!draft.autoPostRequestedAt) return null
      return resultFor(ctx.repos, uid, draft)
    },
  })
}

export type AutoPostService = ReturnType<typeof createAutoPostService>
