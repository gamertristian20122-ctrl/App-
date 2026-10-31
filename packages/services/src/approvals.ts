// Approvals: nothing publishes without a human. A one-time nonce (random 256-bit token; only its
// SHA-256 is stored) is bound to one draft at one revision and expires after 24 h. approve()
// consumes it, re-checks the revision, validates every variant at publish strictness and requires
// an active connected account per variant. There is no approval path without a valid nonce.
//
// Nonces are also bound to a channel (migration 0002):
// - `nonce` (channel 'card') goes only where the AI never sees it: the approval card's UI-only
//   _meta and the signed-in web queue's buttons. Accepted via 'mcp' (the card's app-only tools)
//   and via 'web'.
// - `approveUrl` carries a separate 'link' nonce. approve_draft may show that URL as plain text
//   to clients without MCP Apps, so the AI can read it: a 'link' nonce is accepted only via 'web'
//   (the signed-in web app), never through MCP tools. The AI therefore can never approve by itself.
// - approve / reject / decide default to via 'mcp' (card nonces only: fail closed). Web routes
//   must pass { via: 'web' } explicitly.

import { z } from 'zod'
import { AppError } from '@app/core/errors'
import { randomToken, sha256Hex } from '@app/core/crypto'
import { PlatformSchema, type Actor } from '@app/core/types'
import { EMPTY_EDIT_MESSAGE, IdSchema, lineSchema, textSchema, MAX_POST_TEXT, MAX_TITLE, TIKTOK_PRIVACY_LEVELS } from '@app/core/validation'
import type { ApprovalNonceChannel, ApprovalNonceRow, BoundRepos, DraftRow } from '@app/db'
import { auditIn } from './audit'
import { conflict, fromZod, id, notFound, requireDraft, requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { draftReadinessIn, type DraftsService, type DraftView } from './drafts'
import { requireCanCreate, userEntitlements } from './entitlements'

export interface IssuedNonce {
  /**
   * The one-time 'card' token: put it only in the approval card's UI-only _meta or the signed-in
   * web queue's buttons (never in content / structuredContent the AI sees).
   */
  nonce: string
  draftId: string
  revision: number
  expiresAt: string
  /**
   * One-click web approval page (`/approve/<link nonce>`) for clients without MCP Apps. It carries
   * a separate 'link' nonce that only the signed-in web app accepts, so it may be shown as text.
   */
  approveUrl: string
}

export type NonceProblem = 'invalid' | 'used' | 'expired' | 'wrong_draft' | 'stale' | 'wrong_channel'

/** Who is presenting a nonce. Only humans approve: the web app, or the MCP card's app-only tools. */
export type ApprovalVia = Extract<Actor, 'web' | 'mcp'>

/** Channels a nonce may come from, per caller ('link' nonces were readable by the AI). */
export function channelsFor(via: Actor): readonly ApprovalNonceChannel[] {
  if (via === 'web') return ['card', 'link']
  if (via === 'mcp') return ['card']
  return []
}

export interface NonceCheck {
  valid: boolean
  reason?: NonceProblem
  draftId?: string
  revision?: number
  expiresAt?: string
}

const NonceSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{22,200}$/)

const DecisionSchema = z.strictObject({
  draftId: IdSchema,
  nonce: z.string().max(300),
  decision: z.enum(['approve', 'reject']),
  reason: textSchema(500).optional(),
})

const ApproveSchema = z.strictObject({ draftId: IdSchema, nonce: z.string().max(300) })
const RejectSchema = z.strictObject({ draftId: IdSchema, nonce: z.string().max(300), reason: textSchema(500).optional() })

const NonceEditSchema = z
  .strictObject({
    draftId: IdSchema,
    nonce: z.string().max(300),
    platform: PlatformSchema,
    text: textSchema(MAX_POST_TEXT).optional(),
    title: lineSchema(0, MAX_TITLE).optional(),
    privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS).optional(),
  })
  .refine((v) => v.text !== undefined || v.title !== undefined || v.privacyLevel !== undefined, EMPTY_EDIT_MESSAGE)

const MESSAGES: Record<NonceProblem, string> = {
  invalid: 'This approval link is not valid. Open the draft again to review it.',
  used: 'This approval link was already used. Open the draft again to review it.',
  expired: 'This approval link has expired. Open the draft again to review it.',
  wrong_draft: 'This approval link belongs to another draft.',
  stale: 'The draft changed after it was shown to you. Review the new version.',
  wrong_channel: 'This approval link only works in the web app. Open it in your browser to approve or reject.',
}

export function nonceError(reason: NonceProblem, details: Record<string, unknown> = {}): AppError {
  return new AppError(reason === 'stale' ? 'conflict' : 'forbidden', MESSAGES[reason], { reason, ...details })
}

function hashOf(nonce: unknown): string | null {
  const parsed = NonceSchema.safeParse(nonce)
  return parsed.success ? sha256Hex(parsed.data) : null
}

function problemOf(row: ApprovalNonceRow | null, now: Date, channels?: readonly ApprovalNonceChannel[]): NonceProblem | null {
  if (!row) return 'invalid'
  if (row.usedAt) return 'used'
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired'
  if (channels && !channels.includes(row.channel)) return 'wrong_channel'
  return null
}

function requireHumanVia(via: Actor): ApprovalVia {
  if (via !== 'web' && via !== 'mcp') {
    throw new AppError('forbidden', 'Only a person can approve or reject a draft.', { reason: 'not_human' })
  }
  return via
}

export function createApprovalsService(ctx: Ctx, deps: { drafts: DraftsService }) {
  async function issueIn(r: BoundRepos, userId: string, draft: DraftRow, actor: Actor): Promise<IssuedNonce> {
    const nonce = randomToken(32)
    const linkNonce = randomToken(32)
    const expiresAt = new Date(ctx.now().getTime() + ctx.config.approvalNonceTtlSec * 1000)
    const base = { draftId: draft.id, revision: draft.revision, expiresAt }
    await r.approvalNonces.create(userId, { ...base, nonceHash: sha256Hex(nonce), channel: 'card' })
    await r.approvalNonces.create(userId, { ...base, nonceHash: sha256Hex(linkNonce), channel: 'link' })
    await auditIn(r, userId, {
      actor,
      action: 'approval.nonce_issued',
      subjectType: 'draft',
      subjectId: draft.id,
      meta: { revision: draft.revision, expiresAt: expiresAt.toISOString() },
    })
    return {
      nonce,
      draftId: draft.id,
      revision: draft.revision,
      expiresAt: expiresAt.toISOString(),
      approveUrl: `${ctx.config.appUrl}/approve/${linkNonce}`,
    }
  }

  /** Consumes the nonce in the caller's transaction; throws the precise refusal. */
  async function consumeIn(r: BoundRepos, userId: string, nonce: unknown, draftId: string, via: ApprovalVia): Promise<ApprovalNonceRow> {
    const hash = hashOf(nonce)
    if (!hash) throw nonceError('invalid')
    const now = ctx.now()
    const channels = channelsFor(via)
    const row = await r.approvalNonces.consume(userId, hash, now, channels)
    if (!row) throw nonceError(problemOf(await r.approvalNonces.get(userId, hash), now, channels) ?? 'invalid')
    if (row.draftId !== draftId) throw nonceError('wrong_draft')
    return row
  }

  /** Checks a nonce without using it (as presented by `via`). */
  async function check(userId: string, nonce: unknown, draftId: string | undefined, via: ApprovalVia): Promise<NonceCheck> {
    const hash = hashOf(nonce)
    if (!hash) return { valid: false, reason: 'invalid' }
    const row = await ctx.repos.approvalNonces.get(userId, hash)
    const problem = problemOf(row, ctx.now(), channelsFor(via))
    if (!row || problem) return { valid: false, reason: problem ?? 'invalid' }
    const base = { draftId: row.draftId, revision: row.revision, expiresAt: row.expiresAt.toISOString() }
    if (draftId && row.draftId !== draftId) return { valid: false, reason: 'wrong_draft', ...base }
    const draft = await ctx.repos.drafts.get(userId, row.draftId)
    if (!draft || draft.revision !== row.revision || draft.status === 'archived') return { valid: false, reason: 'stale', ...base }
    return { valid: true, ...base }
  }

  async function approve(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<DraftView> {
    const uid = userIdOf(userId)
    const data = fromZod(ApproveSchema, input, 'Approval')
    const via = requireHumanVia(options.via ?? 'mcp')
    const draftId = await ctx.tx(async (r) => {
      const nonce = await consumeIn(r, uid, data.nonce, data.draftId, via)
      const draft = await r.drafts.lockForUpdate(uid, nonce.draftId)
      if (!draft) throw notFound('Draft')
      if (draft.status === 'archived') throw conflict('This draft is archived.')
      if (draft.revision !== nonce.revision) throw nonceError('stale', { currentRevision: draft.revision })
      if (draft.status === 'approved') return draft.id // already approved at this revision
      const user = await requireUser(r, uid)
      requireCanCreate(userEntitlements(user, ctx.now()))
      const variants = await r.drafts.listVariants(uid, draft.id)
      const readiness = await draftReadinessIn(r, uid, draft, variants)
      if (!readiness.ready) {
        const issues = readiness.variants.flatMap((v) => v.issues.filter((i) => i.severity === 'error'))
        const first = readiness.problems[0] ?? issues[0]?.message ?? 'The draft is not ready to publish.'
        throw validation(`This draft cannot be approved yet. ${first}`, { problems: readiness.problems, issues })
      }
      const approved = await r.drafts.approve(uid, draft.id, { revision: nonce.revision, via })
      if (!approved) throw nonceError('stale')
      await auditIn(r, uid, {
        actor: via,
        action: 'draft.approved',
        subjectType: 'draft',
        subjectId: draft.id,
        meta: { revision: approved.revision, platforms: variants.map((v) => v.platform) },
      })
      return draft.id
    })
    return deps.drafts.get(uid, draftId)
  }

  async function reject(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<DraftRow> {
    const uid = userIdOf(userId)
    const data = fromZod(RejectSchema, input, 'Rejection')
    const via = requireHumanVia(options.via ?? 'mcp')
    return ctx.tx(async (r) => {
      const nonce = await consumeIn(r, uid, data.nonce, data.draftId, via)
      const draft = await requireDraft(r, uid, nonce.draftId)
      if (draft.status === 'archived') throw conflict('This draft is archived.')
      if (draft.status === 'rejected') return draft
      const row = await r.drafts.reject(uid, draft.id, data.reason ?? null)
      if (!row) throw conflict('The draft could not be rejected.')
      await auditIn(r, uid, {
        actor: via,
        action: 'draft.rejected',
        subjectType: 'draft',
        subjectId: draft.id,
        meta: { revision: draft.revision },
      })
      return row
    })
  }

  return withErrors({
    /**
     * A one-time approval token for the draft at its current revision (approve_draft renders it in
     * the approval card's UI-only _meta; the web queue embeds it in its buttons).
     */
    async issueNonce(userId: string, draftId: string, options: { via?: Actor } = {}): Promise<IssuedNonce> {
      const uid = userIdOf(userId)
      return ctx.tx(async (r) => {
        const draft = await requireDraft(r, uid, draftId)
        if (draft.status === 'archived') throw conflict('This draft is archived.')
        return issueIn(r, uid, draft, options.via ?? 'mcp')
      })
    },

    /**
     * Whether a nonce can still approve (without using it), as presented by `via` (default 'web':
     * the /approve/[nonce] page, which accepts card and link nonces).
     */
    async verifyNonce(userId: string, nonce: string, draftId?: string, options: { via?: ApprovalVia } = {}): Promise<NonceCheck> {
      const via = requireHumanVia(options.via ?? 'web')
      return check(userIdOf(userId), nonce, draftId === undefined ? undefined : id(draftId, 'Draft'), via)
    },

    approve,
    reject,

    /** approval_decide (MCP App button) / web buttons: approve or reject with the card's nonce. */
    async decide(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<{ decision: 'approve' | 'reject'; draft: DraftRow }> {
      const data = fromZod(DecisionSchema, input, 'Decision')
      if (data.decision === 'approve') {
        const view = await approve(userId, { draftId: data.draftId, nonce: data.nonce }, options)
        return { decision: 'approve', draft: view.draft }
      }
      const draft = await reject(
        userId,
        { draftId: data.draftId, nonce: data.nonce, ...(data.reason !== undefined ? { reason: data.reason } : {}) },
        options,
      )
      return { decision: 'reject', draft }
    },

    /**
     * approval_edit_variant: the human edits text/title in the card. The card's nonce must be
     * valid for the draft's current revision; the edit bumps the revision, so the old nonce is
     * used up and a new one (for the new revision) is returned for the card.
     */
    async editVariant(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<{ draft: DraftView; nonce: IssuedNonce }> {
      const uid = userIdOf(userId)
      const data = fromZod(NonceEditSchema, input, 'Edit')
      const via = requireHumanVia(options.via ?? 'mcp')
      const status = await check(uid, data.nonce, data.draftId, via)
      if (!status.valid) throw nonceError(status.reason ?? 'invalid')
      const draft = await deps.drafts.editVariant(
        uid,
        {
          draftId: data.draftId,
          platform: data.platform,
          ...(data.text !== undefined ? { text: data.text } : {}),
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.privacyLevel !== undefined ? { privacyLevel: data.privacyLevel } : {}),
        },
        { via },
      )
      const nonce = await ctx.tx(async (r) => {
        const hash = hashOf(data.nonce)
        if (hash) await r.approvalNonces.consume(uid, hash, ctx.now(), channelsFor(via))
        const current = await requireDraft(r, uid, data.draftId)
        return issueIn(r, uid, current, via)
      })
      return { draft, nonce }
    },
  })
}

export type ApprovalsService = ReturnType<typeof createApprovalsService>
