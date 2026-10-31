// The signed-in web approval page (/approve/[nonce]): load the draft behind a nonce and decide.
// Nonce channel rules (docs/handoff/foundation-verify.md): the page accepts card nonces and the
// one-click `link` nonces from approveUrl, and always calls services with { via: 'web' }; the
// signed-in user is the only principal (another user's nonce is simply "not valid"). Server-only.

import { isAppError } from '@app/core/errors'
import type { DraftPreview, NonceProblem, Services } from '@app/services'

const NONCE_RE = /^[A-Za-z0-9_-]{22,200}$/

const PROBLEM_MESSAGES: Record<NonceProblem, string> = {
  invalid: 'This approval link is not valid for your account. Open the draft from your approvals queue.',
  used: 'This approval link was already used.',
  expired: 'This approval link has expired. Open the draft from your approvals queue to get a new one.',
  wrong_draft: 'This approval link belongs to another draft.',
  stale: 'The draft changed after this link was created. Review the new version in your approvals queue.',
  wrong_channel: 'This approval link cannot be used here.',
}

export type ApprovalPageState =
  | { kind: 'invalid'; reason: NonceProblem; message: string }
  | { kind: 'review'; preview: DraftPreview; expiresAt: string | null }

/** Loads the draft for the page. Never uses the nonce up. */
export async function loadApproval(services: Services, userId: string, nonce: string): Promise<ApprovalPageState> {
  if (!NONCE_RE.test(nonce)) return { kind: 'invalid', reason: 'invalid', message: PROBLEM_MESSAGES.invalid }
  const check = await services.approvals.verifyNonce(userId, nonce, undefined, { via: 'web' })
  if (!check.valid || !check.draftId) {
    const reason = check.reason ?? 'invalid'
    return { kind: 'invalid', reason, message: PROBLEM_MESSAGES[reason] }
  }
  const preview = await services.drafts.preview(userId, check.draftId)
  return { kind: 'review', preview, expiresAt: check.expiresAt ?? null }
}

export type DecisionResult =
  | { ok: true; decision: 'approve' | 'reject'; draftId: string }
  | { ok: false; message: string; issues?: string[] }

/**
 * Approve or reject (server action). The draft id comes from the nonce itself, not the form, so
 * a tampered form cannot point the nonce at another draft. A refused approval (validation) keeps
 * the nonce, so the person can fix the draft and come back.
 */
export async function decideApproval(
  services: Services,
  userId: string,
  nonce: string,
  decision: 'approve' | 'reject',
  reason?: string,
): Promise<DecisionResult> {
  if (!NONCE_RE.test(nonce)) return { ok: false, message: PROBLEM_MESSAGES.invalid }
  const check = await services.approvals.verifyNonce(userId, nonce, undefined, { via: 'web' })
  if (!check.valid || !check.draftId) return { ok: false, message: PROBLEM_MESSAGES[check.reason ?? 'invalid'] }
  const trimmed = reason?.trim()
  try {
    const result = await services.approvals.decide(
      userId,
      { draftId: check.draftId, nonce, decision, ...(decision === 'reject' && trimmed ? { reason: trimmed.slice(0, 500) } : {}) },
      { via: 'web' },
    )
    return { ok: true, decision: result.decision, draftId: result.draft.id }
  } catch (error) {
    if (isAppError(error)) {
      const issues = Array.isArray(error.details?.problems) ? (error.details.problems as unknown[]).filter((p): p is string => typeof p === 'string') : undefined
      return { ok: false, message: error.message, ...(issues && issues.length > 0 ? { issues } : {}) }
    }
    throw error
  }
}
