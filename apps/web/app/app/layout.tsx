// Dashboard layout (pages require sign-in): navigation with the approval count, brand switcher,
// trial / billing banner, sign-out, and the toast region.

import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { AppNav, BrandSwitcher, type NavItem } from '@/components/app/shell'
import { LegalFooter } from '@/components/legal/legal-links'
import { Notice } from '@/components/ui/primitives'
import { Logo } from '@/components/ui/logo'
import { button, cx } from '@/components/ui/styles'
import { Toaster } from '@/components/ui/toaster'
import { loadShell } from '@/lib/ui/data'
import { isOwner } from '@/lib/server/owner'
import { currentUser, getUiRuntime } from '@/lib/ui/runtime'
import { preferredBrandId } from '@/lib/ui/server'
import { selectBrandAction } from './actions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { default: 'Dashboard', template: '%s · Dashboard' },
  robots: { index: false, follow: false },
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser()
  // Signed out: every page redirects to /login itself, with its own path (and query, e.g. the
  // ?draft= deep link) as ?next=, which the layout cannot know.
  if (!user) return <>{children}</>
  const rt = await getUiRuntime()
  const shell = await loadShell(rt.services, user, await preferredBrandId(), rt.now())
  const pending = shell.pendingMore ? '99+' : shell.pendingApprovals > 0 ? String(shell.pendingApprovals) : null

  const nav: NavItem[] = [
    { href: '/app', label: 'Overview' },
    { href: '/app/approvals', label: 'Approvals', badge: pending },
    { href: '/app/calendar', label: 'Calendar' },
    { href: '/app/media', label: 'Media' },
    { href: '/app/clips', label: 'Clips' },
    { href: '/app/voice', label: 'Voice' },
    { href: '/app/analytics', label: 'Analytics' },
    { href: '/app/accounts', label: 'Accounts' },
    { href: '/app/brands', label: 'Brands' },
    { href: '/app/billing', label: 'Billing' },
    { href: '/app/connect', label: 'Connect your AI' },
  ]
  // the launch checklist, for the person who runs this deployment only (OWNER_EMAIL)
  if (isOwner(user, rt.ownerEmail ?? null)) nav.push({ href: '/setup', label: 'Setup' })

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo href="/app" />
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-neutral-600 sm:inline dark:text-neutral-400" title="Signed in as">
              {shell.user.email}
            </span>
            <form method="post" action="/api/auth/logout">
              <button type="submit" className={cx(button.ghost, button.small)}>
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row">
        <aside className="lg:w-56 lg:shrink-0">
          <div className="space-y-5 lg:sticky lg:top-20">
            <BrandSwitcher
              brands={shell.brands.map((b) => ({ id: b.id, name: b.name, status: b.status }))}
              selectedId={shell.selectedBrand?.id ?? null}
              action={selectBrandAction}
            />
            <AppNav items={nav} />
          </div>
        </aside>

        <main id="main" className="min-w-0 flex-1">
          {shell.banner ? (
            <Notice
              tone={shell.banner.tone}
              title={shell.banner.title}
              className="mb-6"
              action={
                <Link href="/app/billing" className={cx(shell.banner.tone === 'info' ? button.secondary : button.primary, button.small)}>
                  {shell.banner.cta}
                </Link>
              }
            >
              {shell.banner.body}
            </Notice>
          ) : null}
          {children}
        </main>
      </div>
      <LegalFooter className="border-t border-neutral-200 dark:border-neutral-800" />
      <Toaster />
    </div>
  )
}
