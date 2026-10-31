'use server'

// Approve / Reject from the one-click web approval page. The signed-in user and { via: 'web' }
// are the only authority (lib/server/approve.ts); Next.js checks the action's origin (CSRF).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { decideApproval, setTikTokPrivacy } from '@/lib/server/approve'
import { authDeps, getRuntime } from '@/lib/server/deps'

export async function decideFromWeb(formData: FormData): Promise<void> {
  const nonce = String(formData.get('nonce') ?? '').slice(0, 300)
  const decision = formData.get('decision') === 'approve' ? 'approve' : 'reject'
  const reason = formData.get('reason')
  const page = `/approve/${encodeURIComponent(nonce)}`
  const user = await getCurrentUser(authDeps())
  if (!user) redirect(`/login?next=${encodeURIComponent(page)}`)
  const { services } = await getRuntime()
  const result = await decideApproval(services, user.id, nonce, decision, typeof reason === 'string' ? reason : undefined)
  const outcome = result.ok ? (result.decision === 'approve' ? 'approved' : 'rejected') : 'failed'
  redirect(`${page}?result=${outcome}`)
}

/** "Who can see this TikTok post" on the same page; continues on the page of the next nonce. */
export async function setPrivacyFromWeb(formData: FormData): Promise<void> {
  const nonce = String(formData.get('nonce') ?? '').slice(0, 300)
  const page = `/approve/${encodeURIComponent(nonce)}`
  const user = await getCurrentUser(authDeps())
  if (!user) redirect(`/login?next=${encodeURIComponent(page)}`)
  const { services } = await getRuntime()
  const result = await setTikTokPrivacy(services, user.id, nonce, formData.get('privacyLevel'))
  if (result.ok) redirect(`/approve/${encodeURIComponent(result.nonce)}?result=saved`)
  redirect(`${page}?result=failed`)
}
