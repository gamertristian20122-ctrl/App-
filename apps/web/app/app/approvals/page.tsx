// Approval queue. ?draft=<id> (from approve_draft and the MCP approval card) opens that draft at
// the top; ?tab=approved|rejected; ?brand=<id> filters; ?cursor= pages. A one-time card nonce
// per draft is issued here at render time (services.approvals.issueNonce with via 'web').

import type { Metadata } from 'next'
import { ApprovalsView } from '@/components/app/approvals'
import { APPROVAL_TABS, loadApprovals, type ApprovalTab } from '@/lib/ui/data'
import { isId } from '@/lib/ui/form'
import { param, withQuery } from '@/lib/ui/paths'
import { pageContext } from '@/lib/ui/server'
import {
  approveAction,
  archiveDraftAction,
  cancelPostAction,
  editVariantAction,
  rejectAction,
  reopenDraftAction,
  scheduleDraftAction,
} from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Approvals', referrer: 'no-referrer' }

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const rawDraft = param(sp, 'draft')
  const focusDraftId = isId(rawDraft) ? rawDraft.toLowerCase() : null
  const rawTab = param(sp, 'tab')
  const tab: ApprovalTab = APPROVAL_TABS.find((t) => t === rawTab) ?? 'pending'
  const rawBrand = param(sp, 'brand')
  const brandFilter = isId(rawBrand) ? rawBrand.toLowerCase() : null
  const cursor = param(sp, 'cursor')
  const ctx = await pageContext(withQuery('/app/approvals', { draft: focusDraftId, tab: tab === 'pending' ? null : tab }))
  const data = await loadApprovals(ctx.services, ctx.user.id, {
    tab,
    focusDraftId,
    brandId: brandFilter,
    cursor: cursor && cursor.length <= 100 ? cursor : null,
  })
  return (
    <ApprovalsView
      data={data}
      now={ctx.now}
      brandFilter={brandFilter}
      actions={{
        approve: approveAction,
        reject: rejectAction,
        edit: editVariantAction,
        schedule: scheduleDraftAction,
        reopen: reopenDraftAction,
        archive: archiveDraftAction,
        cancelPost: cancelPostAction,
      }}
    />
  )
}
