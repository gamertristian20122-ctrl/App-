// The approval queue: one card per draft with a preview per platform (text, length vs limit,
// media, issues), and Approve / Edit / Reject forms. Each form carries the draft's one-time card
// nonce issued server-side at render time; the server actions pass it to services.approvals with
// { via: 'web' }. Approved drafts can be scheduled from here.

import { PLATFORM_RULES, type TextUnit } from '@app/core/platforms'
import { PLATFORM_LABELS } from '@app/core/types'
import type { PostRow } from '@app/db'
import { PreviewCard } from '@/components/platform/preview-card'
import { PlatformBadge } from '@/components/platform/platform-badge'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Badge, EmptyState, LinkButton, Notice, PageHeader, StatusPill, TabLinks } from '@/components/ui/primitives'
import { cx, input } from '@/components/ui/styles'
import type { ApprovalItem, ApprovalsData, ApprovalTab } from '@/lib/ui/data'
import { formatDateTime } from '@/lib/ui/format'
import { safeExternalUrl, withQuery } from '@/lib/ui/paths'
import { CountedTextarea, DateTimeField, ScrollToFocused } from './fields'

export interface ApprovalActions {
  approve: FormAction
  reject: FormAction
  edit: FormAction
  schedule: FormAction
  reopen: FormAction
  archive: FormAction
  cancelPost: FormAction
}

const VIA_LABEL: Record<string, string> = { mcp: 'your AI', web: 'the web app', worker: 'a clip', system: 'the system' }

/** Default schedule time: about an hour from now, on a quarter hour. */
export function defaultScheduleIso(now: Date): string {
  const quarter = 15 * 60_000
  return new Date(Math.ceil((now.getTime() + 60 * 60_000) / quarter) * quarter).toISOString()
}

function Hidden({ draftId, nonce }: { draftId: string; nonce: string | null }) {
  return (
    <>
      <input type="hidden" name="draftId" value={draftId} />
      {nonce ? <input type="hidden" name="nonce" value={nonce} /> : null}
    </>
  )
}

function EditVariantForm({ item, platform, actions }: { item: ApprovalItem; platform: PreviewVariantLike; actions: ApprovalActions }) {
  const draftId = item.preview.draft.id
  const hasTitle = PLATFORM_RULES[platform.platform].title !== null || platform.title !== null
  const base = `edit-${draftId}-${platform.platform}`
  return (
    <details className="group rounded-lg border border-neutral-200 dark:border-neutral-800">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-indigo-700 dark:text-indigo-300">
        Edit {PLATFORM_LABELS[platform.platform]} text
      </summary>
      <ActionForm action={actions.edit} className="space-y-3 border-t border-neutral-200 p-3 dark:border-neutral-800" inline>
        <Hidden draftId={draftId} nonce={item.nonce} />
        <input type="hidden" name="platform" value={platform.platform} />
        {hasTitle ? (
          <div>
            <label htmlFor={`${base}-title`} className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Title
            </label>
            <input id={`${base}-title`} name="title" defaultValue={platform.title ?? ''} maxLength={300} className={cx(input, 'mt-1')} />
          </div>
        ) : null}
        <CountedTextarea
          id={`${base}-text`}
          name="text"
          label="Text"
          defaultValue={platform.text}
          unit={platform.length.unit as TextUnit}
          max={platform.length.max}
        />
        {item.preview.draft.status === 'approved' ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">Saving sends this draft back for approval and cancels its scheduled posts.</p>
        ) : null}
        <SubmitButton variant="secondary" pendingLabel="Saving…">
          Save changes
        </SubmitButton>
      </ActionForm>
    </details>
  )
}

type PreviewVariantLike = ApprovalItem['preview']['variants'][number]

function PostsList({ posts, timezone, actions }: { posts: PostRow[]; timezone: string; actions: ApprovalActions }) {
  const visible = posts.filter((p) => p.status !== 'canceled')
  if (visible.length === 0) return null
  return (
    <ul className="space-y-2" aria-label="Posts">
      {visible.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-900">
          <span className="flex items-center gap-2">
            <PlatformBadge platform={p.platform} />
            <StatusPill status={p.status} />
            <time className="text-neutral-600 dark:text-neutral-400" dateTime={(p.publishedAt ?? p.scheduledFor).toISOString()}>
              {formatDateTime(p.publishedAt ?? p.scheduledFor, timezone, { zone: true })}
            </time>
            {safeExternalUrl(p.postUrl) ? (
              <a href={safeExternalUrl(p.postUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className="text-indigo-700 underline dark:text-indigo-300">
                View post
              </a>
            ) : null}
          </span>
          {p.status === 'scheduled' || p.status === 'failed' ? (
            <ActionForm action={actions.cancelPost} confirm="Cancel this post? It will not be published.">
              <input type="hidden" name="postId" value={p.id} />
              <SubmitButton variant="ghost" className="px-2 py-1 text-xs" pendingLabel="Canceling…">
                Cancel
              </SubmitButton>
            </ActionForm>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function DraftCard({ item, actions, now }: { item: ApprovalItem; actions: ApprovalActions; now: Date }) {
  const { preview } = item
  const { draft } = preview
  const draftId = draft.id
  const headingId = `draft-${draftId}-title`
  const blocking = !preview.ready
  return (
    <article
      id={`draft-${draftId}`}
      aria-labelledby={headingId}
      data-focused={item.focused ? 'true' : undefined}
      className={cx(
        'rounded-2xl border bg-white p-5 shadow-sm dark:bg-neutral-900',
        item.focused ? 'border-indigo-500 ring-2 ring-indigo-500' : 'border-neutral-200 dark:border-neutral-800',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} tabIndex={-1} data-focus-target className="text-base font-semibold outline-none">
            {preview.brand.name}
            <span className="sr-only">: draft with {preview.variants.length} platforms</span>
          </h2>
          <p className="text-xs text-neutral-500">
            From {VIA_LABEL[draft.createdVia] ?? 'your AI'} · {formatDateTime(draft.createdAt, item.brandTimezone)} · revision {draft.revision}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {item.focused ? <Badge tone="info">Opened from link</Badge> : null}
          <StatusPill status={draft.status} />
        </div>
      </header>

      {draft.notes ? <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-950">{draft.notes}</p> : null}
      {preview.problems.length > 0 ? (
        <Notice tone="warning" className="mt-4">
          <ul className="list-disc pl-5">
            {preview.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {draft.status === 'rejected' && draft.rejectedReason ? (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">Rejected: {draft.rejectedReason}</p>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {preview.variants.map((v) => (
          <PreviewCard key={v.platform} variant={v}>
            {item.nonce && (draft.status === 'draft' || draft.status === 'approved') ? <EditVariantForm item={item} platform={v} actions={actions} /> : null}
          </PreviewCard>
        ))}
      </div>

      {draft.status === 'draft' && item.nonce ? (
        <div className="mt-5 flex flex-col gap-3 border-t border-neutral-200 pt-4 sm:flex-row sm:items-start sm:justify-between dark:border-neutral-800">
          <ActionForm action={actions.approve} className="flex flex-col gap-1" aria-label="Approve draft">
            <Hidden draftId={draftId} nonce={item.nonce} />
            <SubmitButton disabled={blocking} pendingLabel="Approving…" title={blocking ? 'Fix the problems above first' : undefined}>
              Approve
            </SubmitButton>
            {blocking ? <p className="text-xs text-neutral-500">Fix the problems above to approve.</p> : <p className="text-xs text-neutral-500">Approving does not publish yet; you schedule it next.</p>}
          </ActionForm>
          <details className="sm:max-w-sm sm:flex-1">
            <summary className="cursor-pointer select-none text-sm font-medium text-red-700 dark:text-red-300">Reject…</summary>
            <ActionForm action={actions.reject} className="mt-2 space-y-2" aria-label="Reject draft">
              <Hidden draftId={draftId} nonce={item.nonce} />
              <label htmlFor={`reason-${draftId}`} className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Reason (optional; your AI sees it)
              </label>
              <textarea id={`reason-${draftId}`} name="reason" rows={2} maxLength={500} className={input} />
              <SubmitButton variant="danger" pendingLabel="Rejecting…">
                Reject draft
              </SubmitButton>
            </ActionForm>
          </details>
        </div>
      ) : null}

      {draft.status === 'approved' ? (
        <div className="mt-5 space-y-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <PostsList posts={item.posts} timezone={item.brandTimezone} actions={actions} />
          <ActionForm action={actions.schedule} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" aria-label="Schedule draft">
            <input type="hidden" name="draftId" value={draftId} />
            <div className="space-y-3">
              <DateTimeField id={`when-${draftId}`} label="Publish at" defaultIso={defaultScheduleIso(now)} serverTimeZone={item.brandTimezone} />
              {preview.variants.length > 1 ? (
                <fieldset>
                  <legend className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Platforms (none ticked = all)</legend>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {preview.variants.map((v) => (
                      <label key={v.platform} className="inline-flex items-center gap-1.5 text-sm">
                        <input type="checkbox" name="platforms" value={v.platform} className="h-4 w-4 rounded border-neutral-300" />
                        {PLATFORM_LABELS[v.platform]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
            </div>
            <SubmitButton pendingLabel="Scheduling…">Schedule</SubmitButton>
          </ActionForm>
          {item.nonce ? (
            <ActionForm action={actions.reject} confirm="Reject this approved draft? Its scheduled posts will be canceled.">
              <Hidden draftId={draftId} nonce={item.nonce} />
              <SubmitButton variant="ghost" className="px-2 py-1 text-xs text-red-700 dark:text-red-300" pendingLabel="Rejecting…">
                Withdraw approval (reject)
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      ) : null}

      {draft.status === 'rejected' || draft.status === 'archived' ? (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <ActionForm action={actions.reopen}>
            <input type="hidden" name="draftId" value={draftId} />
            <SubmitButton variant="secondary" pendingLabel="Moving…">
              Back to the queue
            </SubmitButton>
          </ActionForm>
          {draft.status === 'rejected' ? (
            <ActionForm action={actions.archive}>
              <input type="hidden" name="draftId" value={draftId} />
              <SubmitButton variant="ghost" pendingLabel="Archiving…">
                Archive
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

const TAB_LABELS: Record<ApprovalTab, string> = { pending: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected' }

const EMPTY: Record<ApprovalTab, { title: string; body: string }> = {
  pending: { title: 'You are all caught up', body: 'Ask your AI to draft a post or make clips. New drafts appear here for your approval.' },
  approved: { title: 'No approved drafts', body: 'Approved drafts wait here until you schedule them.' },
  rejected: { title: 'No rejected drafts', body: 'Drafts you reject are kept here for reference.' },
}

export function ApprovalsView({ data, actions, now, brandFilter }: { data: ApprovalsData; actions: ApprovalActions; now: Date; brandFilter: string | null }) {
  const tabHref = (tab: ApprovalTab) => withQuery('/app/approvals', { tab: tab === 'pending' ? null : tab, brand: brandFilter })
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Nothing is published until you approve it. Check each platform's preview, edit if needed, then approve or reject."
      />
      <TabLinks label="Draft status" active={data.tab} tabs={(['pending', 'approved', 'rejected'] as const).map((t) => ({ key: t, label: TAB_LABELS[t], href: tabHref(t) }))} />
      {data.focusMissing ? (
        <Notice tone="warning" className="mb-4">
          That draft was not found. It may have been deleted, or it belongs to another account.
        </Notice>
      ) : null}
      {data.items.length === 0 ? (
        <EmptyState title={EMPTY[data.tab].title} action={data.tab === 'pending' ? <LinkButton href="/app/connect">Connect your AI</LinkButton> : null}>
          {EMPTY[data.tab].body}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {data.items.map((item) => (
            <DraftCard key={item.preview.draft.id} item={item} actions={actions} now={now} />
          ))}
        </div>
      )}
      {data.nextCursor ? (
        <div className="mt-6 text-center">
          <LinkButton href={withQuery('/app/approvals', { tab: data.tab === 'pending' ? null : data.tab, brand: brandFilter, cursor: data.nextCursor })}>
            Show older drafts
          </LinkButton>
        </div>
      ) : null}
      <ScrollToFocused />
    </>
  )
}
