// Drafts, approval and scheduling: create_draft, list_drafts, approve_draft (opens the approval
// card), schedule_post, post_status, and the card's app-only tools approval_decide and
// approval_edit_variant. Nothing publishes without a person approving in the card or web app.

import { z } from 'zod'
import { PLATFORM_LABELS, PlatformSchema, type Platform } from '@app/core/types'
import { validateVariant } from '@app/core/platforms'
import {
  DraftInputSchema,
  DraftRefSchema,
  IdSchema,
  ListDraftsInputSchema,
  MAX_POST_TEXT,
  MAX_TITLE,
  PostStatusInputSchema,
  ScheduleInputSchema,
  VariantInputSchema,
  createScheduleInputSchema,
  lineSchema,
  textSchema,
} from '@app/core/validation'
import type { DraftPreview, DraftView, IssuedNonce } from '@app/services'
import { APP_ONLY_META, APPROVAL_META_KEY, CARD_TOOL_META } from '../constants'
import { appUrl, type McpContext } from '../context'
import type { Problem } from '../errors'
import { excerpt, listText, ok, plural } from '../results'
import {
  clipView,
  draftRowOnlyView,
  draftSummaryView,
  draftView,
  jobViewForModel,
  postView,
  previewView,
  type PostRow,
} from '../views'
import { READ_ONLY, type ToolDef } from './types'

const DRAFT_ID = 'The draft id (from create_draft or list_drafts).'

/** Web approval page for one draft (for clients that cannot show the approval card). */
export function webApprovalUrl(ctx: McpContext, draftId: string): string {
  return `${appUrl(ctx)}/app/approvals?draft=${encodeURIComponent(draftId)}`
}

function platformsText(platforms: readonly Platform[]): string {
  return listText(platforms.map((p) => PLATFORM_LABELS[p]))
}

/** Blocking problems and informational notes of a draft, one line each. */
function readinessLines(view: DraftView): { errors: string[]; notes: string[] } {
  const errors = view.problems.map((p) => `- ${p}`)
  const notes: string[] = []
  for (const v of view.variants) {
    for (const i of v.issues) {
      const over = i.limit !== undefined && i.actual !== undefined && i.actual > i.limit ? ` (${i.actual - i.limit} over the limit)` : ''
      const line = `- ${PLATFORM_LABELS[v.platform]}: ${i.message}${over}`
      if (i.severity === 'error') errors.push(line)
      else notes.push(line)
    }
  }
  return { errors, notes }
}

/** Text-limit problems get "N over the limit" from core's validateVariant (same rules as services). */
function explainVariantProblems(args: Record<string, unknown>, problems: Problem[]): Problem[] {
  const variants = Array.isArray(args.variants) ? args.variants : []
  return problems.map((problem) => {
    const m = /^variants\.(\d+)\.(\w+)/.exec(problem.path ?? '')
    if (!m) return problem
    const parsed = VariantInputSchema.safeParse(variants[Number(m[1])])
    if (!parsed.success) return problem
    const v = parsed.data
    const issues = validateVariant(v.platform, { text: v.text, title: v.title ?? null, mediaIds: v.mediaIds, options: v.options })
    const match = issues.find((i) => i.field === m[2] && problem.message.endsWith(i.message) && i.limit !== undefined && i.actual !== undefined)
    return match ? { ...problem, limit: match.limit as number, actual: match.actual as number } : problem
  })
}

// ---------------------------------------------------------------------------------------------

export const createDraft: ToolDef = {
  name: 'create_draft',
  title: 'Create a draft post',
  description:
    'Saves a post as a draft for one brand, with one variant per platform (text, optional title, media ids, platform options). ' +
    'Text is checked against each platform\'s limits (X counts links as 23 and emoji as 2; X posts may not contain links). ' +
    'Nothing is published: next call approve_draft so the user can review and approve it. Load the write_post prompt first to write in the brand\'s voice.',
  input: DraftInputSchema,
  describe: {
    brandId: 'The brand id (from list_accounts).',
    variants:
      'One entry per platform: { platform, text, title?, mediaIds?: media ids (videos/images already uploaded or rendered), options?: platform options, connectedAccountId? }.',
    notes: 'Internal notes for the user (not published).',
    sourceClipId: 'The clip this post is made from (optional).',
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  explain: explainVariantProblems,
  async run(ctx, args) {
    const view = await ctx.services.drafts.create(ctx.userId, args, { via: 'mcp' })
    const platforms = view.variants.map((v) => v.platform)
    const lines = [`Draft ${view.draft.id} saved for ${platformsText(platforms)} (status: draft, not published).`]
    const { errors, notes } = readinessLines(view)
    if (view.ready) lines.push('It is ready for approval.')
    else lines.push('Before it can be approved (the user can still review it now):', ...errors)
    if (notes.length > 0) lines.push('Notes:', ...notes)
    lines.push(`Next: call approve_draft with draftId=${view.draft.id} so the user can review and approve it.`)
    return ok(lines.join('\n'), { draft: draftView(view) })
  },
}

export const listDrafts: ToolDef = {
  name: 'list_drafts',
  title: 'List drafts',
  description:
    'Lists drafts, newest first, with their per-platform text. Filter by brand or status (draft = waiting for approval, approved, rejected, archived). ' +
    'Clips from make_clips appear here as drafts once rendered.',
  input: ListDraftsInputSchema,
  describe: {
    brandId: 'Only this brand (optional).',
    status: 'Only drafts with this status (optional).',
    limit: 'Page size (1-100, default 20).',
    cursor: 'nextCursor from the previous page.',
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const page = await ctx.services.drafts.list(ctx.userId, args)
    if (page.items.length === 0) return ok('No drafts found.', { drafts: [], nextCursor: null })
    const lines = page.items.map(({ draft, variants }) => {
      const first = variants[0]
      const text = first ? ` "${excerpt(first.text || first.title || '', 70)}"` : ''
      return `- ${draft.id} [${draft.status}, rev ${draft.revision}] ${platformsText(variants.map((v) => v.platform)) || 'no platforms'}${text}`
    })
    if (page.nextCursor) lines.push(`More drafts: call list_drafts again with cursor="${page.nextCursor}".`)
    return ok(`${plural(page.items.length, 'draft')}:\n${lines.join('\n')}`, {
      drafts: page.items.map(draftSummaryView),
      nextCursor: page.nextCursor,
    })
  },
}

/** UI-only payload for the approval card: the nonce and the preview with media URLs. */
function cardMeta(preview: DraftPreview, nonce: IssuedNonce, webUrl: string): Record<string, unknown> {
  return {
    [APPROVAL_META_KEY]: {
      nonce: nonce.nonce,
      expiresAt: nonce.expiresAt,
      revision: nonce.revision,
      webUrl,
      preview: previewView(preview),
    },
  }
}

/** What the model sees of a preview: no media URLs (they are short-lived capability links). */
function modelPreview(preview: DraftPreview) {
  const view = previewView(preview)
  return {
    ...view,
    variants: view.variants.map((v) => ({ ...v, media: v.media.map(({ url: _url, ...m }) => m) })),
  }
}

function previewLines(preview: DraftPreview): string[] {
  return preview.variants.map((v) => {
    const media = v.media.length > 0 ? `, ${plural(v.media.length, 'media item')}` : ''
    const blocking = v.issues.filter((i) => i.severity === 'error').map((i) => i.message)
    const state = v.ready ? 'ready' : `not ready: ${blocking.join(' ') || 'needs attention'}`
    return `- ${v.label}: ${v.length.used}/${v.length.max}${media}; ${state}`
  })
}

export const approveDraft: ToolDef = {
  name: 'approve_draft',
  title: 'Show a draft for approval',
  description:
    'Shows the user an approval card with a per-platform preview of the draft, where they can approve, edit or reject it. ' +
    'You cannot approve on the user\'s behalf: only the user can, in the card or in the web app (the result includes a link for clients that cannot show the card). ' +
    'After the user approves, call schedule_post.',
  input: DraftRefSchema,
  describe: { draftId: DRAFT_ID },
  annotations: READ_ONLY,
  meta: { ...CARD_TOOL_META },
  async run(ctx, args) {
    const draftId = String(args.draftId)
    const preview = await ctx.services.drafts.preview(ctx.userId, draftId)
    const nonce = await ctx.services.approvals.issueNonce(ctx.userId, preview.draft.id, { via: 'mcp' })
    const webUrl = webApprovalUrl(ctx, preview.draft.id)
    const d = preview.draft
    const lines = [
      d.status === 'approved' && d.approvedRevision === d.revision
        ? `Draft ${d.id} (${preview.brand.name}) is already approved. It can be scheduled with schedule_post.`
        : `Showing the approval card for draft ${d.id} (${preview.brand.name}, revision ${d.revision}). The user approves, edits or rejects it there; wait for their decision.`,
      ...previewLines(preview),
      ...preview.problems.map((p) => `- ${p}`),
      `If the card does not appear, ask the user to review it in the web app: ${webUrl}`,
      'After the user approves, call schedule_post with this draftId.',
    ]
    return ok(
      lines.join('\n'),
      { draftId: d.id, status: d.status, revision: d.revision, ready: preview.ready, approvalUrl: webUrl, preview: modelPreview(preview) },
      cardMeta(preview, nonce, webUrl),
    )
  },
}

// ---------------------------------------------------------------------------------------------

function postLine(p: PostRow): string {
  const label = PLATFORM_LABELS[p.platform]
  const when = p.status === 'published' && p.publishedAt ? `published ${p.publishedAt.toISOString()}` : `${p.status}, scheduled for ${p.scheduledFor.toISOString()}`
  const url = p.postUrl ? ` ${p.postUrl}` : ''
  const error = p.error ? ` Error: ${p.error}` : ''
  return `- ${label}: ${when} (postId ${p.id})${url}${error}`
}

export const schedulePost: ToolDef = {
  name: 'schedule_post',
  title: 'Schedule an approved draft',
  description:
    'Schedules an approved draft to publish at a time (ISO 8601 with offset, e.g. "2026-11-02T15:00:00-05:00", or "now"), one post per platform variant. ' +
    'Only drafts the user approved (and not edited since) can be scheduled. Platform daily caps are enforced; when a cap is full the error suggests the next free time. ' +
    'Scheduling an already scheduled draft moves it to the new time.',
  input: ScheduleInputSchema,
  parser: (ctx) => createScheduleInputSchema(ctx.services.deps.clock),
  describe: {
    draftId: DRAFT_ID,
    at: 'When to publish: ISO 8601 with a UTC offset, or "now". At most 120 days ahead.',
    platforms: 'Only these platforms of the draft (default: all of them).',
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async run(ctx, args) {
    const posts = await ctx.services.posts.schedule(ctx.userId, args, { via: 'mcp' })
    return ok(
      [`Scheduled ${plural(posts.length, 'post')}. They publish automatically at that time:`, ...posts.map(postLine), 'Check progress with post_status.'].join('\n'),
      { posts: posts.map(postView) },
    )
  },
}

const StatusToolSchema = z
  .strictObject({
    postId: IdSchema.optional(),
    draftId: IdSchema.optional(),
    clipId: IdSchema.optional(),
    jobId: IdSchema.optional(),
  })
  .refine((v) => [v.postId, v.draftId, v.clipId, v.jobId].filter((x) => x !== undefined).length === 1, 'Give exactly one of postId, draftId, clipId or jobId.')

export const postStatus: ToolDef = {
  name: 'post_status',
  title: 'Check post and job status',
  description:
    'Status of scheduled and published posts (by postId, or every post of a draftId: scheduled, publishing, published with its URL, failed with the reason), ' +
    'and of background work: a clip from make_clips (clipId) or a render / import job (jobId).',
  input: StatusToolSchema,
  describe: {
    postId: 'A post id (from schedule_post).',
    draftId: 'All posts of this draft.',
    clipId: 'A clip id (from make_clips).',
    jobId: 'A job id (from render_carousel, render_video or import_past_posts).',
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const { services, userId } = ctx
    if (typeof args.jobId === 'string') {
      const job = await services.jobs.get(userId, args.jobId)
      const result = job.status === 'succeeded' && job.result ? ` Result: ${JSON.stringify(job.result)}` : ''
      const error = job.error ? ` Error: ${job.error}` : ''
      const produced = job.status === 'succeeded' && job.result && typeof job.result === 'object' ? (job.result as { draftId?: unknown }) : null
      const next =
        produced && 'draftId' in produced
          ? typeof produced.draftId === 'string'
            ? ` Its draft is ${produced.draftId}: show it with approve_draft (do not create another draft for these media).`
            : ' No draft was made (no connected account takes this media): attach the media ids to a draft with create_draft once an account is connected.'
          : ''
      return ok(`Job ${job.id} (${job.type}): ${job.status}.${result}${next}${error}`, { job: jobViewForModel(job) })
    }
    if (typeof args.clipId === 'string') {
      const clip = await services.clips.get(userId, args.clipId)
      const next = clip.draftId ? ` Its draft is ${clip.draftId}: show it with approve_draft.` : ''
      const error = clip.error ? ` Error: ${clip.error}` : ''
      return ok(`Clip ${clip.id}: ${clip.status}.${next}${error}`, { clip: clipView(clip) })
    }
    const input = PostStatusInputSchema.parse(args)
    const posts = await services.posts.status(userId, input.postId ? { postId: args.postId } : { draftId: args.draftId })
    if (posts.length === 0) return ok('This draft has no scheduled or published posts yet. Schedule it with schedule_post once it is approved.', { posts: [] })
    return ok(posts.map(postLine).join('\n'), { posts: posts.map(postView) })
  },
}

// ---------------------------------------------------------------------------------------------
// App-only tools (called by the approval card's buttons with the card's one-time nonce)
// ---------------------------------------------------------------------------------------------

const NonceSchema = z.string().trim().min(1).max(300)

const DecideSchema = z.strictObject({
  draftId: IdSchema,
  nonce: NonceSchema,
  decision: z.enum(['approve', 'reject']),
  reason: textSchema(500).optional(),
})

const EditSchema = z
  .strictObject({
    draftId: IdSchema,
    nonce: NonceSchema,
    platform: PlatformSchema,
    text: textSchema(MAX_POST_TEXT).optional(),
    title: lineSchema(0, MAX_TITLE).optional(),
  })
  .refine((v) => v.text !== undefined || v.title !== undefined, 'Change the text or the title.')

export const approvalDecide: ToolDef = {
  name: 'approval_decide',
  title: 'Approve or reject a draft (approval card)',
  description:
    'Used by the approval card when the user clicks Approve or Reject. Requires the one-time token that only the card has. Not for the assistant.',
  input: DecideSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  meta: { ...APP_ONLY_META },
  async run(ctx, args) {
    const { decision, draft } = await ctx.services.approvals.decide(ctx.userId, args, { via: 'mcp' })
    const text =
      decision === 'approve'
        ? `The user approved draft ${draft.id} (revision ${draft.revision}). It is not published yet: call schedule_post with draftId=${draft.id} and a time.`
        : `The user rejected draft ${draft.id}${draft.rejectedReason ? `: "${draft.rejectedReason}"` : ''}. Revise it with a new draft if they want.`
    return ok(text, { decision, draftId: draft.id, status: draft.status, revision: draft.revision, draft: draftRowOnlyView(draft) })
  },
}

export const approvalEditVariant: ToolDef = {
  name: 'approval_edit_variant',
  title: 'Edit a draft in the approval card',
  description:
    'Used by the approval card when the user edits the text or title of one platform before approving. Requires the card\'s one-time token. Not for the assistant.',
  input: EditSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  meta: { ...APP_ONLY_META },
  async run(ctx, args) {
    const { draft, nonce } = await ctx.services.approvals.editVariant(ctx.userId, args, { via: 'mcp' })
    const preview = await ctx.services.drafts.preview(ctx.userId, draft.draft.id)
    const platform = String(args.platform) as Platform
    const webUrl = webApprovalUrl(ctx, draft.draft.id)
    return ok(
      `The user edited the ${PLATFORM_LABELS[platform] ?? platform} text of draft ${draft.draft.id} (now revision ${draft.draft.revision}). It still needs their approval.`,
      { draftId: draft.draft.id, platform, revision: draft.draft.revision, ready: draft.ready, preview: modelPreview(preview) },
      cardMeta(preview, nonce, webUrl),
    )
  },
}

