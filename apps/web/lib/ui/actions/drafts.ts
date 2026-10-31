// Server-action logic for the approval queue and the calendar: approve / reject / edit through
// services.approvals with the card nonce issued at render time and { via: 'web' } (nothing here
// can approve without that nonce), reopen / archive, and scheduling, rescheduling and canceling
// posts. Each function takes the services and the signed-in user's id, reads the form, calls one
// service function and returns a short result. Server-only.

import type { Services } from '@app/services'
import { failed, failure, success, type ActionResult } from '../action-result'
import { checkbox, id, platform, text, timeZone, type Fields } from '../form'
import { zonedLocalToUtc } from '../time'

const NONCE_MAX = 300

function nonceOf(fd: Fields): string | null {
  const nonce = text(fd, 'nonce', { max: NONCE_MAX })
  return nonce ? nonce : null
}

const MISSING = 'This page is out of date. Reload it and try again.'

/** Approve with the card nonce rendered into the form (approval goes through services only). */
export async function approveDraft(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const draftId = id(fd, 'draftId')
  const nonce = nonceOf(fd)
  if (!draftId || !nonce) return failed(MISSING)
  try {
    await services.approvals.decide(userId, { draftId, nonce, decision: 'approve' }, { via: 'web' })
    return success('Approved. Schedule it now, or ask your AI to schedule it.')
  } catch (error) {
    return failure(error)
  }
}

export async function rejectDraft(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const draftId = id(fd, 'draftId')
  const nonce = nonceOf(fd)
  if (!draftId || !nonce) return failed(MISSING)
  const reason = text(fd, 'reason', { max: 2_000 })?.slice(0, 500)
  try {
    await services.approvals.decide(userId, { draftId, nonce, decision: 'reject', ...(reason ? { reason } : {}) }, { via: 'web' })
    return success('Rejected. Nothing from this draft will be published.')
  } catch (error) {
    return failure(error)
  }
}

/** Edits one variant's text/title (the card nonce must still be valid; the edit needs a new approval). */
export async function editVariant(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const draftId = id(fd, 'draftId')
  const nonce = nonceOf(fd)
  const p = platform(fd, 'platform')
  if (!draftId || !nonce || !p) return failed(MISSING)
  const body = text(fd, 'text', { max: 70_000, trim: false })
  const title = fd.get('title') === null ? undefined : text(fd, 'title', { max: 1_000 })
  if (body === undefined && title === undefined) return failed('Change the text or the title.')
  try {
    await services.approvals.editVariant(
      userId,
      {
        draftId,
        nonce,
        platform: p,
        ...(body !== undefined ? { text: body.replace(/\s+$/, '') } : {}),
        ...(title !== undefined ? { title } : {}),
      },
      { via: 'web' },
    )
    return success('Saved. Review the change, then approve.')
  } catch (error) {
    return failure(error)
  }
}

export async function reopenDraft(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const draftId = id(fd, 'draftId')
  if (!draftId) return failed(MISSING)
  try {
    await services.drafts.reopen(userId, draftId, { via: 'web' })
    return success('Moved back to the approval queue.')
  } catch (error) {
    return failure(error)
  }
}

export async function archiveDraft(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const draftId = id(fd, 'draftId')
  if (!draftId) return failed(MISSING)
  try {
    await services.drafts.archive(userId, draftId, { via: 'web' })
    return success('Archived.')
  } catch (error) {
    return failure(error)
  }
}

/**
 * The instant for a schedule form: "now" (checkbox), or a datetime-local value read in the
 * browser's time zone (hidden `tz` field set by the client), else `fallbackTz` (the brand's).
 */
export function scheduleAt(fd: Fields, fallbackTz: string): string | null {
  if (checkbox(fd, 'now')) return 'now'
  const local = text(fd, 'when', { max: 40 })
  if (!local) return null
  const tz = timeZone(fd, 'tz') ?? fallbackTz
  const at = zonedLocalToUtc(local, tz)
  return at ? at.toISOString() : null
}

/** Schedules an approved draft (every approved variant, or the platforms ticked in the form). */
export async function scheduleDraft(services: Services, userId: string, fd: Fields, fallbackTz = 'UTC'): Promise<ActionResult> {
  const draftId = id(fd, 'draftId')
  if (!draftId) return failed(MISSING)
  const at = scheduleAt(fd, fallbackTz)
  if (!at) return failed('Pick a date and time.')
  const platforms = fd.getAll('platforms').filter((p): p is string => typeof p === 'string')
  try {
    const posts = await services.posts.schedule(userId, { draftId, at, ...(platforms.length > 0 ? { platforms } : {}) }, { via: 'web' })
    return success(posts.length === 1 ? 'Scheduled 1 post.' : `Scheduled ${posts.length} posts.`)
  } catch (error) {
    return failure(error)
  }
}

export async function reschedulePost(services: Services, userId: string, fd: Fields, fallbackTz = 'UTC'): Promise<ActionResult> {
  const postId = id(fd, 'postId')
  if (!postId) return failed(MISSING)
  const at = scheduleAt(fd, fallbackTz)
  if (!at) return failed('Pick a date and time.')
  try {
    await services.posts.reschedule(userId, postId, at, { via: 'web' })
    return success('Rescheduled.')
  } catch (error) {
    return failure(error)
  }
}

export async function cancelPost(services: Services, userId: string, fd: Fields): Promise<ActionResult> {
  const postId = id(fd, 'postId')
  if (!postId) return failed(MISSING)
  try {
    await services.posts.cancel(userId, postId, { via: 'web', reason: 'Canceled from the calendar.' })
    return success('Canceled. It will not be published.')
  } catch (error) {
    return failure(error)
  }
}
