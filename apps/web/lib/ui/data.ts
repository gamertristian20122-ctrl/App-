// Data loaders for the dashboard pages. Each takes the services and the signed-in user's id and
// returns plain data for the (synchronous) view components, so the same code runs in pages and
// in tests against PGlite-backed services. Server-only.

import { LIVE_ACCOUNT_STATUSES, PLATFORMS, type Platform, type PostStatus } from '@app/core/types'
import type { AccountRow, BrandRow, ClipRow, PostRow, UserRow } from '@app/db'
import {
  isClipSource,
  type CalendarItem,
  type DraftPreview,
  type DraftSummary,
  type MediaView,
  type OAuthConnection,
  type Services,
  type TranscriptView,
  type UsageBalance,
  type UserEntitlements,
  type VoiceProfileView,
  type WeeklyReview,
} from '@app/services'
import { isServiceError } from './errors'
import { addDaysToKey, dayKey, monthRange, weekRange, type DayRange } from './time'

// ---------------------------------------------------------------------------------------------
// Brand selection
// ---------------------------------------------------------------------------------------------

/** The brand the dashboard works on: the preferred one if usable, else the first active brand. */
export function pickBrand(brands: readonly BrandRow[], preferredId: string | null | undefined): BrandRow | null {
  const usable = brands.filter((b) => b.status !== 'archived')
  return (
    usable.find((b) => b.id === preferredId && b.status === 'active') ??
    usable.find((b) => b.id === preferredId) ??
    usable.find((b) => b.status === 'active') ??
    usable[0] ??
    null
  )
}

// ---------------------------------------------------------------------------------------------
// Shell (layout): user, entitlements, brands, approval count, billing banner
// ---------------------------------------------------------------------------------------------

export interface BillingBanner {
  tone: 'info' | 'warning' | 'danger'
  title: string
  body: string
  cta: string
}

/** The banner shown on every dashboard page for trials and billing problems (null when all is well). */
export function billingBanner(ent: Pick<UserEntitlements, 'status' | 'trial' | 'trialEndsAt' | 'trialExpired' | 'plan'>, now: Date): BillingBanner | null {
  if (ent.trialExpired) {
    return { tone: 'danger', title: 'Your free trial has ended', body: 'Choose a plan to keep publishing and clipping. Nothing has been deleted.', cta: 'Choose a plan' }
  }
  switch (ent.status) {
    case 'trialing': {
      const days = ent.trialEndsAt ? Math.max(0, Math.ceil((ent.trialEndsAt.getTime() - now.getTime()) / 86_400_000)) : null
      const left = days === null ? 'Free trial' : days <= 1 ? 'Your free trial ends today' : `Free trial: ${days} days left`
      return {
        tone: days !== null && days <= 2 ? 'warning' : 'info',
        title: left,
        body: 'The trial includes Starter limits with 1 clipping hour. Choose a plan any time to keep going.',
        cta: 'Choose a plan',
      }
    }
    case 'past_due':
      return {
        tone: 'warning',
        title: 'Your last payment did not go through',
        body: 'Approved posts keep publishing, but clipping and rendering are paused until you update your payment method.',
        cta: 'Update payment',
      }
    case 'unpaid':
      return { tone: 'danger', title: 'Your subscription is on hold', body: 'An invoice is unpaid. Update your payment method to continue.', cta: 'Update payment' }
    case 'canceled':
      return { tone: 'danger', title: 'Your subscription has ended', body: 'Your account is read-only. Choose a plan to continue.', cta: 'Choose a plan' }
    case 'none':
      return { tone: 'warning', title: 'Choose a plan to get started', body: 'Your account is read-only until you pick a plan.', cta: 'Choose a plan' }
    default:
      return null
  }
}

export interface ShellData {
  user: UserRow
  entitlements: UserEntitlements
  brands: BrandRow[]
  selectedBrand: BrandRow | null
  pendingApprovals: number
  pendingMore: boolean
  banner: BillingBanner | null
}

/** Loads the layout data; creates the app user on first visit if sign-in did not (Supabase). */
export async function loadShell(services: Services, user: { id: string; email: string }, preferredBrandId: string | null, now: Date): Promise<ShellData> {
  let summary
  try {
    summary = await services.users.summary(user.id)
  } catch (error) {
    if (!isServiceError(error, ['unauthorized', 'not_found'])) throw error
    await services.users.ensureUser(user.id, { email: user.email })
    summary = await services.users.summary(user.id)
  }
  const brands = await services.brands.list(user.id, { status: ['active', 'suspended'] })
  const pending = await services.drafts.list(user.id, { status: 'draft', limit: 100 })
  return {
    user: summary.user,
    entitlements: summary.entitlements,
    brands,
    selectedBrand: pickBrand(brands, preferredBrandId),
    pendingApprovals: pending.items.length,
    pendingMore: pending.nextCursor !== null,
    banner: billingBanner(summary.entitlements, now),
  }
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export interface OverviewData {
  entitlements: UserEntitlements
  clip: UsageBalance
  brandsActive: number
  brandsLimit: number
  upcoming: Array<CalendarItem & { brandName: string }>
  awaiting: Array<DraftSummary & { brandName: string }>
  awaitingMore: boolean
  liveAccounts: number
  aiConnections: number
  timezone: string
}

export async function loadOverview(services: Services, userId: string, now: Date): Promise<OverviewData> {
  const [summary, clip, brands, accounts, connections, awaiting] = await Promise.all([
    services.users.summary(userId),
    services.usage.balance(userId, 'clip_seconds'),
    services.brands.list(userId),
    services.accounts.list(userId, {}),
    services.oauth.listConnections(userId),
    services.drafts.list(userId, { status: 'draft', limit: 5 }),
  ])
  const names = new Map(brands.map((b) => [b.id, b.name]))
  const upcoming = await services.posts.calendar(userId, {
    from: now.toISOString(),
    to: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    status: ['scheduled', 'publishing'],
  })
  return {
    entitlements: summary.entitlements,
    clip,
    brandsActive: brands.filter((b) => b.status === 'active').length,
    brandsLimit: summary.entitlements.brands,
    upcoming: upcoming
      .sort((a, b) => a.post.scheduledFor.getTime() - b.post.scheduledFor.getTime())
      .slice(0, 6)
      .map((i) => ({ ...i, brandName: names.get(i.post.brandId) ?? 'Brand' })),
    awaiting: awaiting.items.map((d) => ({ ...d, brandName: names.get(d.draft.brandId) ?? 'Brand' })),
    awaitingMore: awaiting.nextCursor !== null,
    liveAccounts: accounts.filter((a) => (LIVE_ACCOUNT_STATUSES as readonly string[]).includes(a.status)).length,
    aiConnections: connections.length,
    timezone: summary.user.timezone,
  }
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

export const APPROVAL_TABS = ['pending', 'approved', 'rejected'] as const
export type ApprovalTab = (typeof APPROVAL_TABS)[number]

const TAB_STATUS = { pending: 'draft', approved: 'approved', rejected: 'rejected' } as const

export interface ApprovalItem {
  preview: DraftPreview
  /**
   * The one-time 'card' nonce for this draft at its current revision, issued for the signed-in
   * web app at render time (null for drafts that cannot be decided: rejected/archived).
   */
  nonce: string | null
  focused: boolean
  posts: PostRow[]
  brandTimezone: string
}

export interface ApprovalsData {
  tab: ApprovalTab
  items: ApprovalItem[]
  nextCursor: string | null
  /** ?draft=<id> named a draft that does not exist (or is not this user's). */
  focusMissing: boolean
}

export async function loadApprovals(
  services: Services,
  userId: string,
  options: { tab?: ApprovalTab; focusDraftId?: string | null; brandId?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<ApprovalsData> {
  const tab = options.tab ?? 'pending'
  const brands = await services.brands.list(userId)
  const tzOf = new Map(brands.map((b) => [b.id, b.timezone]))
  const filter = {
    status: TAB_STATUS[tab],
    limit: options.limit ?? 10,
    ...(options.brandId && tzOf.has(options.brandId) ? { brandId: options.brandId } : {}),
  }
  let list
  try {
    list = await services.drafts.list(userId, { ...filter, ...(options.cursor ? { cursor: options.cursor } : {}) })
  } catch (error) {
    // a stale or hand-edited ?cursor= starts over instead of failing the page
    if (!options.cursor || !isServiceError(error, 'validation')) throw error
    list = await services.drafts.list(userId, filter)
  }
  const ids = list.items.map((d) => d.draft.id)
  let focusMissing = false
  if (options.focusDraftId && !ids.includes(options.focusDraftId)) {
    try {
      await services.drafts.get(userId, options.focusDraftId)
      ids.unshift(options.focusDraftId)
    } catch (error) {
      if (!isServiceError(error)) throw error
      focusMissing = true
    }
  } else if (options.focusDraftId) {
    // show the focused draft first
    ids.splice(ids.indexOf(options.focusDraftId), 1)
    ids.unshift(options.focusDraftId)
  }

  const items: ApprovalItem[] = []
  for (const draftId of ids) {
    const preview = await services.drafts.preview(userId, draftId)
    const decidable = preview.draft.status === 'draft' || preview.draft.status === 'approved'
    const issued = decidable ? await services.approvals.issueNonce(userId, draftId, { via: 'web' }) : null
    const posts = await services.posts.list(userId, { draftId, limit: 50 })
    items.push({
      preview,
      nonce: issued?.nonce ?? null,
      focused: draftId === options.focusDraftId,
      posts,
      brandTimezone: tzOf.get(preview.brand.id) ?? 'UTC',
    })
  }
  return { tab, items, nextCursor: list.nextCursor, focusMissing }
}

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

export type CalendarView = 'week' | 'month'

export interface CalendarEntry extends CalendarItem {
  brandName: string
  brandTimezone: string
}

export interface CalendarData {
  view: CalendarView
  range: DayRange
  timezone: string
  days: Array<{ key: string; items: CalendarEntry[] }>
  total: number
  prevKey: string
  nextKey: string
  todayKey: string
}

export async function loadCalendar(
  services: Services,
  userId: string,
  options: { view: CalendarView; anchorKey: string; brandId: string | null; timezone: string; includeCanceled: boolean; now: Date },
): Promise<CalendarData> {
  const range = options.view === 'week' ? weekRange(options.anchorKey, options.timezone) : monthRange(options.anchorKey, options.timezone)
  const brands = await services.brands.list(userId)
  const byId = new Map(brands.map((b) => [b.id, b]))
  const statuses: PostStatus[] = options.includeCanceled
    ? ['scheduled', 'publishing', 'published', 'failed', 'canceled']
    : ['scheduled', 'publishing', 'published', 'failed']
  const items = await services.posts.calendar(userId, {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    status: statuses,
    ...(options.brandId ? { brandId: options.brandId } : {}),
  })
  const days = new Map(range.days.map((k) => [k, [] as CalendarEntry[]]))
  for (const item of items.sort((a, b) => a.post.scheduledFor.getTime() - b.post.scheduledFor.getTime())) {
    const brand = byId.get(item.post.brandId)
    const key = dayKey(item.post.scheduledFor, options.timezone)
    days.get(key)?.push({ ...item, brandName: brand?.name ?? 'Brand', brandTimezone: brand?.timezone ?? options.timezone })
  }
  const prevAnchor = options.view === 'week' ? addDaysToKey(range.startKey, -7) : addDaysToKey(range.startKey, -1)
  return {
    view: options.view,
    range,
    timezone: options.timezone,
    days: [...days.entries()].map(([key, list]) => ({ key, items: list })),
    total: items.length,
    prevKey: options.view === 'week' ? prevAnchor : `${prevAnchor.slice(0, 7)}-01`,
    nextKey: range.endKey,
    todayKey: dayKey(options.now, options.timezone),
  }
}

// ---------------------------------------------------------------------------------------------
// Brands and accounts
// ---------------------------------------------------------------------------------------------

export interface BrandsData {
  brands: BrandRow[]
  activeCount: number
  limit: number
  entitlements: UserEntitlements
  accountsByBrand: Record<string, number>
}

export async function loadBrands(services: Services, userId: string): Promise<BrandsData> {
  const [brands, ent, accounts] = await Promise.all([
    services.brands.list(userId),
    services.users.getEntitlements(userId),
    services.accounts.list(userId, {}),
  ])
  const accountsByBrand: Record<string, number> = {}
  for (const a of accounts) if ((LIVE_ACCOUNT_STATUSES as readonly string[]).includes(a.status)) accountsByBrand[a.brandId] = (accountsByBrand[a.brandId] ?? 0) + 1
  const order = { active: 0, suspended: 1, archived: 2 } as const
  return {
    brands: [...brands].sort((a, b) => order[a.status] - order[b.status] || a.createdAt.getTime() - b.createdAt.getTime()),
    activeCount: brands.filter((b) => b.status === 'active').length,
    limit: ent.brands,
    entitlements: ent,
    accountsByBrand,
  }
}

export interface AccountSlot {
  platform: Platform
  /** The live account (pending / active / needs_reauth), else null. */
  account: AccountRow | null
}

export async function loadAccounts(services: Services, userId: string, brandId: string): Promise<{ slots: AccountSlot[]; connected: number }> {
  const accounts = await services.accounts.list(userId, { brandId })
  const live = accounts.filter((a) => (LIVE_ACCOUNT_STATUSES as readonly string[]).includes(a.status))
  const slots = PLATFORMS.map((p) => ({ platform: p, account: live.find((a) => a.platform === p) ?? null }))
  return { slots, connected: live.length }
}

// ---------------------------------------------------------------------------------------------
// Media and clips
// ---------------------------------------------------------------------------------------------

export interface MediaItem {
  media: MediaView
  /** Short-lived URL for image thumbnails (ready images only). */
  thumbUrl: string | null
  clipSource: boolean
}

export async function loadMedia(services: Services, userId: string, options: { cursor?: string | null } = {}): Promise<{ items: MediaItem[]; nextCursor: string | null }> {
  const page = await services.media.list(userId, { limit: 30, ...(options.cursor ? { cursor: options.cursor } : {}) })
  const items: MediaItem[] = []
  for (const media of page.items) {
    if (media.status === 'deleted') continue
    let thumbUrl: string | null = null
    if (media.kind === 'image' && media.status === 'ready') {
      try {
        thumbUrl = (await services.media.downloadUrl(userId, media.id, 900)).url
      } catch {
        thumbUrl = null
      }
    }
    items.push({ media, thumbUrl, clipSource: isClipSource(media) })
  }
  return { items, nextCursor: page.nextCursor }
}

export interface ClipsData {
  sources: MediaView[]
  selected: MediaView | null
  transcript: TranscriptView | null
  clips: ClipRow[]
  query: string | null
}

export async function loadClips(services: Services, userId: string, options: { sourceId?: string | null; query?: string | null } = {}): Promise<ClipsData> {
  const page = await services.media.list(userId, { kind: 'video', limit: 100 })
  const sources = page.items.filter((m) => m.status !== 'deleted' && isClipSource(m))
  const selected = sources.find((m) => m.id === options.sourceId) ?? sources[0] ?? null
  if (!selected) return { sources, selected: null, transcript: null, clips: [], query: null }
  const query = options.query?.trim() ? options.query.trim().slice(0, 200) : null
  let transcript: TranscriptView | null = null
  try {
    transcript = await services.transcripts.get(userId, { mediaId: selected.id, ...(query ? { query } : {}) })
  } catch (error) {
    if (!isServiceError(error)) throw error
    transcript = null
  }
  const clips = await services.clips.list(userId, { sourceMediaId: selected.id })
  return { sources, selected, transcript, clips, query }
}

// ---------------------------------------------------------------------------------------------
// Voice, analytics, billing, connect
// ---------------------------------------------------------------------------------------------

export interface VoiceData {
  profile: VoiceProfileView | null
  versions: VoiceProfileView[]
  imported: { total: number; byPlatform: Partial<Record<Platform, number>> }
}

export async function loadVoice(services: Services, userId: string, brandId: string): Promise<VoiceData> {
  const [profile, versions, imported] = await Promise.all([
    services.voice.get(userId, brandId),
    services.voice.versions(userId, brandId, 10),
    services.imports.summary(userId, brandId),
  ])
  return { profile, versions, imported }
}

export async function loadAnalytics(services: Services, userId: string, brands: readonly BrandRow[]): Promise<WeeklyReview[]> {
  const out: WeeklyReview[] = []
  for (const brand of brands) out.push(await services.analytics.weeklyReview(userId, brand.id))
  return out
}

export interface BillingData {
  billing: Awaited<ReturnType<Services['billing']['summary']>>
  clip: UsageBalance
  brandsActive: number
}

export async function loadBilling(services: Services, userId: string): Promise<BillingData> {
  const [billing, clip, brands] = await Promise.all([
    services.billing.summary(userId),
    services.usage.balance(userId, 'clip_seconds'),
    services.brands.list(userId, { status: 'active' }),
  ])
  return { billing, clip, brandsActive: brands.length }
}

export async function loadConnections(services: Services, userId: string): Promise<OAuthConnection[]> {
  return services.oauth.listConnections(userId)
}
