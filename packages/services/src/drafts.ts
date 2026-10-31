// Drafts: every post starts here. Variants are validated per platform (core platform rules: text
// limits, media rules, X links refused while the allowance is 0). Revisions and the content hash
// are maintained by database triggers: any content edit bumps the revision and drops an approval
// (scheduled posts of the old revision are canceled by the database).

import { z } from 'zod'
import { AppError } from '@app/core/errors'
import { hasLink } from '@app/core/links'
import {
  PLATFORM_RULES,
  blockingIssues,
  measureText,
  textLimitsFor,
  validateVariant,
  type MediaFacts,
  type ValidationIssue,
} from '@app/core/platforms'
import { PLATFORM_LABELS, PlatformSchema, type Actor, type Platform } from '@app/core/types'
import {
  DraftInputSchema,
  describeOptions,
  EditVariantInputSchema,
  IdSchema,
  ListDraftsInputSchema,
  RejectDraftInputSchema,
  UpsertVariantInputSchema,
  textSchema,
  type OptionLine,
  type VariantInput,
} from '@app/core/validation'
import type { AccountRow, BoundRepos, BrandRow, DraftRow, MediaRow, VariantInput as DbVariantInput, VariantRow } from '@app/db'
import { accountProblem, resolveAccountIn } from './accounts'
import { auditIn } from './audit'
import {
  conflict,
  fromZod,
  id,
  notFound,
  requireActiveBrand,
  requireBrand,
  requireDraft,
  requireUser,
  userIdOf,
  validation,
  withErrors,
  type Ctx,
} from './context'
import { requireCanCreate, userEntitlements } from './entitlements'

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export interface VariantAccount {
  id: string
  handle: string | null
  displayName: string | null
  status: AccountRow['status']
}

export interface VariantView extends VariantRow {
  /** Problems at publish strictness (errors block approval; warnings are informational). */
  issues: ValidationIssue[]
  account: VariantAccount | null
  /** Valid for publishing, media ready and an active account. */
  ready: boolean
}

export interface DraftView {
  draft: DraftRow
  variants: VariantView[]
  /** Every variant ready, the brand active and at least one variant. */
  ready: boolean
  /** Draft-level problems (no variants, brand not active, ...). */
  problems: string[]
}

export interface DraftSummary {
  draft: DraftRow
  variants: VariantRow[]
}

export interface PreviewMedia {
  id: string
  kind: MediaRow['kind']
  mimeType: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  status: MediaRow['status']
  /** Short-lived URL (null until the file is ready). */
  url: string | null
}

export interface PreviewVariant {
  platform: Platform
  label: string
  text: string
  title: string | null
  options: Record<string, unknown>
  /**
   * Every option the variant publishes with (first comment, collaborators, visibility, ids...),
   * labelled for people. Every approval surface shows these, so nothing is published unseen.
   */
  optionLines: OptionLine[]
  media: PreviewMedia[]
  account: VariantAccount | null
  issues: ValidationIssue[]
  ready: boolean
  /** Text length in the platform's unit vs its limit. */
  length: { used: number; max: number; unit: string }
}

export interface DraftPreview {
  draft: DraftRow
  brand: { id: string; name: string; status: BrandRow['status'] }
  variants: PreviewVariant[]
  ready: boolean
  problems: string[]
}

// ---------------------------------------------------------------------------------------------
// Helpers shared with approvals and posts
// ---------------------------------------------------------------------------------------------

export function mediaFacts(media: MediaRow): MediaFacts {
  return {
    kind: media.kind,
    bytes: media.bytes,
    durationMs: media.durationMs,
    width: media.width,
    height: media.height,
    mimeType: media.mimeType,
  }
}

/** Loads the user's media for ids (all must exist, not deleted/failed), keyed by id. */
export async function loadMediaIn(r: BoundRepos, userId: string, ids: readonly string[]): Promise<Map<string, MediaRow>> {
  const unique = [...new Set(ids)]
  const rows = await r.media.getMany(userId, unique)
  const map = new Map(rows.map((m) => [m.id, m]))
  for (const mediaId of unique) {
    const m = map.get(mediaId)
    if (!m || m.status === 'deleted') throw notFound('Media', { mediaId })
    if (m.status === 'failed') throw validation('An attached file failed to process. Remove it or upload it again.', { mediaId })
    if (m.kind !== 'video' && m.kind !== 'image') throw validation('Only videos and images can be attached to a post.', { mediaId })
  }
  return map
}

function variantLink(text: string, options: Record<string, unknown> | undefined): boolean {
  const firstComment = typeof options?.firstComment === 'string' ? options.firstComment : ''
  return hasLink(text) || (firstComment !== '' && hasLink(firstComment))
}

function issueMessage(issues: readonly ValidationIssue[]): string {
  const parts = issues.slice(0, 5).map((i) => `${PLATFORM_LABELS[i.platform]}: ${i.message}`)
  const more = issues.length > 5 ? ` (and ${issues.length - 5} more)` : ''
  return `${parts.join(' ')}${more}`
}

/** Throws AppError('validation') listing blocking issues. */
export function assertNoErrors(issues: readonly ValidationIssue[]): void {
  const errors = blockingIssues(issues)
  if (errors.length > 0) throw new AppError('validation', issueMessage(errors), { issues: errors })
}

/** Checks a new/updated variant against platform rules (with media facts) and its pinned account. */
async function prepareVariantIn(
  r: BoundRepos,
  userId: string,
  brandId: string,
  variant: VariantInput,
): Promise<DbVariantInput> {
  const media = await loadMediaIn(r, userId, variant.mediaIds)
  const facts = variant.mediaIds.map((m) => mediaFacts(media.get(m) as MediaRow))
  assertNoErrors(
    validateVariant(
      variant.platform,
      { text: variant.text, title: variant.title ?? null, mediaIds: variant.mediaIds, options: variant.options },
      { media: facts },
    ),
  )
  if (variant.connectedAccountId) {
    const account = await r.accounts.get(userId, variant.connectedAccountId)
    if (!account || account.brandId !== brandId || account.platform !== variant.platform) {
      throw validation(`That ${PLATFORM_LABELS[variant.platform]} account is not connected to this brand.`, {
        connectedAccountId: variant.connectedAccountId,
      })
    }
  }
  const options = variant.options as Record<string, unknown>
  return {
    platform: variant.platform,
    connectedAccountId: variant.connectedAccountId ?? null,
    text: variant.text,
    title: variant.title ? variant.title : null,
    mediaIds: variant.mediaIds,
    options,
    hasLink: variantLink(variant.text, options),
  }
}

/** Publish-strict readiness of a draft (approval and scheduling use this). */
export async function draftReadinessIn(r: BoundRepos, userId: string, draft: DraftRow, variants: readonly VariantRow[]): Promise<DraftView> {
  const problems: string[] = []
  const brand = await r.brands.get(userId, draft.brandId)
  if (!brand || brand.status !== 'active') problems.push('The brand is not active.')
  if (variants.length === 0) problems.push('Add at least one platform.')
  const allMedia = await r.media.getMany(userId, variants.flatMap((v) => v.mediaIds))
  const mediaById = new Map(allMedia.map((m) => [m.id, m]))
  const views: VariantView[] = []
  for (const v of variants) {
    const issues: ValidationIssue[] = []
    const media: MediaFacts[] = []
    let mediaReady = true
    for (const mid of v.mediaIds) {
      const m = mediaById.get(mid)
      if (!m || m.status === 'deleted' || m.status === 'failed') {
        mediaReady = false
        issues.push({ platform: v.platform, field: 'media', code: 'media_required', severity: 'error', message: 'An attached file is missing. Remove it or attach another.' })
        continue
      }
      if (m.status !== 'ready') mediaReady = false
      media.push(mediaFacts(m))
    }
    if (!mediaReady && !issues.some((i) => i.field === 'media')) {
      issues.push({ platform: v.platform, field: 'media', code: 'media_required', severity: 'error', message: 'An attached file is still processing.' })
    }
    issues.push(
      ...validateVariant(v.platform, { text: v.text, title: v.title, mediaIds: v.mediaIds, options: v.options }, { media, forPublish: true }),
    )
    const account = brand ? await resolveAccountIn(r, userId, brand.id, v) : null
    const problem = accountProblem(v.platform, account)
    if (problem) issues.push({ platform: v.platform, field: 'platform', code: 'option_required', severity: 'error', message: problem })
    views.push({
      ...v,
      issues,
      account: account ? { id: account.id, handle: account.handle, displayName: account.displayName, status: account.status } : null,
      ready: blockingIssues(issues).length === 0,
    })
  }
  return { draft, variants: views, ready: problems.length === 0 && views.every((v) => v.ready), problems }
}

const ListCursorSchema = z.string().max(100)

function encodeCursor(draft: DraftRow): string {
  return Buffer.from(draft.createdAt.toISOString(), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): Date | undefined {
  if (!cursor) return undefined
  const parsed = ListCursorSchema.safeParse(cursor)
  const date = parsed.success ? new Date(Buffer.from(parsed.data, 'base64url').toString('utf8')) : new Date(Number.NaN)
  if (Number.isNaN(date.getTime())) throw validation('Invalid cursor.')
  return date
}

const NotesSchema = z.strictObject({ draftId: IdSchema, notes: textSchema(2_000).nullable() })
const RemoveVariantSchema = z.strictObject({ draftId: IdSchema, platform: PlatformSchema })

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export function createDraftsService(ctx: Ctx) {
  async function requireWritable(r: BoundRepos, userId: string, draftId: unknown): Promise<DraftRow> {
    const user = await requireUser(r, userId)
    requireCanCreate(userEntitlements(user, ctx.now()))
    const draft = await r.drafts.lockForUpdate(userId, id(draftId, 'Draft'))
    if (!draft) throw notFound('Draft')
    if (draft.status === 'archived') throw conflict('This draft is archived.')
    return draft
  }

  /** After a content edit: a rejected draft goes back to the queue. */
  async function afterEdit(r: BoundRepos, userId: string, draft: DraftRow, actor: Actor, meta: Record<string, unknown>): Promise<DraftRow> {
    let current = (await r.drafts.get(userId, draft.id)) ?? draft
    if (current.status === 'rejected') current = (await r.drafts.reopen(userId, draft.id)) ?? current
    await auditIn(r, userId, {
      actor,
      action: 'draft.edited',
      subjectType: 'draft',
      subjectId: draft.id,
      meta: { ...meta, revision: current.revision, wasApproved: draft.status === 'approved' },
    })
    return current
  }

  async function view(userId: string, draftId: unknown): Promise<DraftView> {
    const r = ctx.repos
    const draft = await requireDraft(r, userId, draftId)
    const variants = await r.drafts.listVariants(userId, draft.id)
    return draftReadinessIn(r, userId, draft, variants)
  }

  return withErrors({
    /** create_draft: one draft with a variant per platform (validated against platform rules). */
    async create(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<DraftView> {
      const uid = userIdOf(userId)
      const data = fromZod(DraftInputSchema, input, 'Draft')
      const via = options.via ?? 'mcp'
      const created = await ctx.tx(async (r) => {
        const user = await requireUser(r, uid)
        requireCanCreate(userEntitlements(user, ctx.now()))
        const brand = await requireActiveBrand(r, uid, data.brandId)
        if (data.sourceClipId) {
          const clip = await r.clips.get(uid, data.sourceClipId)
          if (!clip) throw notFound('Clip')
        }
        const variants: DbVariantInput[] = []
        for (const v of data.variants) variants.push(await prepareVariantIn(r, uid, brand.id, v))
        const result = await r.drafts.create(uid, {
          brandId: brand.id,
          createdVia: via,
          sourceClipId: data.sourceClipId ?? null,
          notes: data.notes ?? null,
          variants,
        })
        await auditIn(r, uid, {
          actor: via,
          action: 'draft.created',
          subjectType: 'draft',
          subjectId: result.draft.id,
          meta: { platforms: variants.map((v) => v.platform) },
        })
        return result
      })
      return view(uid, created.draft.id)
    },

    /** One draft with publish readiness per variant. */
    async get(userId: string, draftId: string): Promise<DraftView> {
      return view(userIdOf(userId), draftId)
    },

    /** list_drafts: newest first, with variants. */
    async list(userId: string, input: unknown = {}): Promise<{ items: DraftSummary[]; nextCursor: string | null }> {
      const uid = userIdOf(userId)
      const data = fromZod(ListDraftsInputSchema, input ?? {}, 'Filter')
      if (data.brandId) await requireBrand(ctx.repos, uid, data.brandId)
      const before = decodeCursor(data.cursor)
      const rows = await ctx.repos.drafts.list(uid, {
        ...(data.brandId ? { brandId: data.brandId } : {}),
        ...(data.status ? { status: data.status } : {}),
        ...(before ? { before } : {}),
        limit: data.limit + 1,
      })
      const page = rows.slice(0, data.limit)
      const variants = await ctx.repos.drafts.listVariantsForDrafts(
        uid,
        page.map((d) => d.id),
      )
      const byDraft = new Map<string, VariantRow[]>()
      for (const v of variants) byDraft.set(v.draftId, [...(byDraft.get(v.draftId) ?? []), v])
      const last = page[page.length - 1]
      return {
        items: page.map((draft) => ({ draft, variants: byDraft.get(draft.id) ?? [] })),
        nextCursor: rows.length > data.limit && last ? encodeCursor(last) : null,
      }
    },

    /** Per-platform preview for the approval card / web queue (media as short-lived URLs). */
    async preview(userId: string, draftId: string): Promise<DraftPreview> {
      const uid = userIdOf(userId)
      const v = await view(uid, draftId)
      const brand = await requireBrand(ctx.repos, uid, v.draft.brandId)
      const media = await ctx.repos.media.getMany(
        uid,
        v.variants.flatMap((x) => x.mediaIds),
      )
      const byId = new Map(media.map((m) => [m.id, m]))
      const urls = new Map<string, string>()
      for (const m of media) {
        if (m.status === 'ready') urls.set(m.id, await ctx.storage.presignGet(m.storageKey, ctx.config.previewUrlTtlSec))
      }
      const variants: PreviewVariant[] = v.variants.map((variant) => {
        const limit = textLimitsFor(variant.platform, variant.options)[0] ?? PLATFORM_RULES[variant.platform].text[0]
        return {
          platform: variant.platform,
          label: PLATFORM_LABELS[variant.platform],
          text: variant.text,
          title: variant.title,
          options: variant.options,
          optionLines: describeOptions(variant.platform, variant.options),
          media: variant.mediaIds.flatMap((mid) => {
            const m = byId.get(mid)
            if (!m) return []
            return [
              {
                id: m.id,
                kind: m.kind,
                mimeType: m.mimeType,
                width: m.width,
                height: m.height,
                durationMs: m.durationMs,
                status: m.status,
                url: urls.get(m.id) ?? null,
              },
            ]
          }),
          account: variant.account,
          issues: variant.issues,
          ready: variant.ready,
          length: limit
            ? { used: measureText(variant.text, limit.unit), max: limit.max, unit: limit.unit }
            : { used: variant.text.length, max: 0, unit: 'utf16' },
        }
      })
      return {
        draft: v.draft,
        brand: { id: brand.id, name: brand.name, status: brand.status },
        variants,
        ready: v.ready,
        problems: v.problems,
      }
    },

    /**
     * Adds or replaces one platform variant (full content). Bumps the revision; an approved draft
     * goes back to `draft` and needs a new approval.
     */
    async updateVariant(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<DraftView> {
      const uid = userIdOf(userId)
      const data = fromZod(UpsertVariantInputSchema, input, 'Variant')
      const via = options.via ?? 'mcp'
      await ctx.tx(async (r) => {
        const draft = await requireWritable(r, uid, data.draftId)
        const prepared = await prepareVariantIn(r, uid, draft.brandId, data.variant)
        await r.drafts.upsertVariant(uid, draft.id, prepared)
        await afterEdit(r, uid, draft, via, { platform: data.variant.platform })
      })
      return view(uid, data.draftId)
    },

    /** Quick edit of one variant's text and/or title (approval card / web queue). */
    async editVariant(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<DraftView> {
      const uid = userIdOf(userId)
      const data = fromZod(EditVariantInputSchema, input, 'Edit')
      const via = options.via ?? 'web'
      await ctx.tx(async (r) => {
        const draft = await requireWritable(r, uid, data.draftId)
        const variants = await r.drafts.listVariants(uid, draft.id)
        const variant = variants.find((v) => v.platform === data.platform)
        if (!variant) throw notFound(`The ${PLATFORM_LABELS[data.platform]} variant`)
        const text = data.text ?? variant.text
        const title = data.title !== undefined ? data.title || null : variant.title
        // TikTok: the person chooses who can see the post (no default; see EditVariantInputSchema)
        const options = data.privacyLevel !== undefined ? { ...variant.options, privacyLevel: data.privacyLevel } : variant.options
        const media = await r.media.getMany(uid, variant.mediaIds)
        assertNoErrors(validateVariant(variant.platform, { text, title, mediaIds: variant.mediaIds, options }, { media: media.map(mediaFacts) }))
        await r.drafts.updateVariant(uid, variant.id, {
          text,
          title,
          ...(data.privacyLevel !== undefined ? { options } : {}),
          hasLink: variantLink(text, options),
        })
        await afterEdit(r, uid, draft, via, { platform: data.platform, ...(data.privacyLevel !== undefined ? { privacyLevel: data.privacyLevel } : {}) })
      })
      return view(uid, data.draftId)
    },

    /** Removes one platform from a draft. */
    async removeVariant(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<DraftView> {
      const uid = userIdOf(userId)
      const data = fromZod(RemoveVariantSchema, input, 'Request')
      await ctx.tx(async (r) => {
        const draft = await requireWritable(r, uid, data.draftId)
        const variants = await r.drafts.listVariants(uid, draft.id)
        const variant = variants.find((v) => v.platform === data.platform)
        if (!variant) throw notFound(`The ${PLATFORM_LABELS[data.platform]} variant`)
        // posts keep a reference to their variant (history), so a published/scheduled one stays
        const posts = await r.posts.list(uid, { draftId: draft.id, limit: 1000 })
        if (posts.some((p) => p.variantId === variant.id)) {
          throw conflict('This platform has post history, so it cannot be removed. Archive the draft instead.')
        }
        await r.drafts.deleteVariant(uid, draft.id, data.platform)
        await afterEdit(r, uid, draft, options.via ?? 'web', { removed: data.platform })
      })
      return view(uid, data.draftId)
    },

    /** Notes are not content: no revision bump, the approval stays. */
    async updateNotes(userId: string, input: unknown): Promise<DraftRow> {
      const uid = userIdOf(userId)
      const data = fromZod(NotesSchema, input, 'Notes')
      const draft = await requireDraft(ctx.repos, uid, data.draftId)
      return (await ctx.repos.drafts.updateNotes(uid, draft.id, data.notes)) ?? draft
    },

    /** Rejects a draft (also an approved one; its scheduled posts are canceled by the database). */
    async reject(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<DraftRow> {
      const uid = userIdOf(userId)
      const data = fromZod(RejectDraftInputSchema, input, 'Rejection')
      return ctx.tx(async (r) => {
        const draft = await requireDraft(r, uid, data.draftId)
        if (draft.status === 'rejected') return draft
        if (draft.status === 'archived') throw conflict('This draft is archived.')
        const row = await r.drafts.reject(uid, draft.id, data.reason ?? null)
        if (!row) throw conflict('The draft could not be rejected.')
        await auditIn(r, uid, {
          actor: options.via ?? 'web',
          action: 'draft.rejected',
          subjectType: 'draft',
          subjectId: draft.id,
          meta: { revision: draft.revision },
        })
        return row
      })
    },

    /** Archives a draft (kept for history; scheduled posts are canceled by the database). */
    async archive(userId: string, draftId: string, options: { via?: Actor } = {}): Promise<DraftRow> {
      const uid = userIdOf(userId)
      return ctx.tx(async (r) => {
        const draft = await requireDraft(r, uid, draftId)
        if (draft.status === 'archived') return draft
        const row = await r.drafts.archive(uid, draft.id)
        await auditIn(r, uid, { actor: options.via ?? 'web', action: 'draft.archived', subjectType: 'draft', subjectId: draft.id })
        return row ?? draft
      })
    },

    /** Puts a rejected or archived draft back in the approval queue. */
    async reopen(userId: string, draftId: string, options: { via?: Actor } = {}): Promise<DraftRow> {
      const uid = userIdOf(userId)
      return ctx.tx(async (r) => {
        const draft = await requireDraft(r, uid, draftId)
        if (draft.status === 'draft' || draft.status === 'approved') return draft
        const row = await r.drafts.reopen(uid, draft.id)
        await auditIn(r, uid, { actor: options.via ?? 'web', action: 'draft.reopened', subjectType: 'draft', subjectId: draft.id })
        return row ?? draft
      })
    },
  })
}

export type DraftsService = ReturnType<typeof createDraftsService>
