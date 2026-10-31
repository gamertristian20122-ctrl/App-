// Who may open /setup: only the signed-in user whose email equals OWNER_EMAIL (case-insensitive).
// Everyone else gets a 404, so the page's existence is not advertised. Server-only.

import { normalizeEmail } from '@/lib/auth'

/** OWNER_EMAIL, normalized; null when it is not set (then /setup only says how to set it). */
export function ownerEmailOf(config: { OWNER_EMAIL?: string | undefined }): string | null {
  const raw = config.OWNER_EMAIL?.trim()
  return raw ? normalizeEmail(raw) : null
}

/** True when `user` is the owner. Always false while OWNER_EMAIL is unset. */
export function isOwner(user: { email: string } | null | undefined, ownerEmail: string | null): boolean {
  if (!user || !ownerEmail) return false
  return normalizeEmail(user.email) === ownerEmail
}

export type SetupAccess = { kind: 'unset' } | { kind: 'owner' } | { kind: 'denied' }

/** What /setup shows: the "set OWNER_EMAIL" message, the page, or a 404. */
export function setupAccess(user: { email: string } | null | undefined, ownerEmail: string | null): SetupAccess {
  if (!ownerEmail) return { kind: 'unset' }
  return isOwner(user, ownerEmail) ? { kind: 'owner' } : { kind: 'denied' }
}
