// Sign in: Supabase magic link (POST /api/auth/magic-link), and with DEV_AUTH=1 an email-only
// development login (POST /api/auth/dev-login). Honors ?next=, ?sent=1 and ?error=….

import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { loadConfig } from '@app/core/config'
import { LoginView, type LoginError } from '@/components/app/login-view'
import { currentUser } from '@/lib/ui/runtime'
import { param, safeNextPath } from '@/lib/ui/paths'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

const ERRORS: readonly LoginError[] = ['link_invalid', 'link_expired', 'not_configured', 'unavailable']

function authOptions(): { devAuth: boolean; magicLink: boolean } {
  try {
    const config = loadConfig(process.env)
    return { devAuth: config.DEV_AUTH, magicLink: Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY) }
  } catch {
    return { devAuth: false, magicLink: false }
  }
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const next = safeNextPath(param(sp, 'next'))
  const user = await currentUser().catch(() => null)
  if (user) redirect(next)
  const rawError = param(sp, 'error')
  const error = ERRORS.find((e) => e === rawError) ?? null
  const { devAuth, magicLink } = authOptions()
  return <LoginView next={next} sent={param(sp, 'sent') === '1'} error={error} devAuth={devAuth} magicLink={magicLink} />
}
