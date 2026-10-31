'use server'

// Consent form submit (Allow / Deny) for /oauth/authorize. Next.js checks that server actions
// come from our own origin (CSRF); services.oauth re-validates every parameter.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { authDeps, getRuntime } from '@/lib/server/deps'
import { authorizeQuery, decideConsent, pickAuthorizeParams } from '@/lib/server/oauth'

export async function decideAuthorization(formData: FormData): Promise<void> {
  const decision = formData.get('decision') === 'approve' ? 'approve' : 'deny'
  const { params } = pickAuthorizeParams(formData)
  const back = `/oauth/authorize?${authorizeQuery(params)}`
  const user = await getCurrentUser(authDeps())
  if (!user) redirect(`/login?next=${encodeURIComponent(back)}`)
  const { services } = await getRuntime()
  const result = await decideConsent(services, user, formData, decision)
  if (result.kind === 'redirect') redirect(result.url)
  redirect(`${back}&notice=failed`)
}
