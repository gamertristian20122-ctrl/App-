// /setup: the owner's launch checklist (docs/LAUNCH-ON-PHONE.md). Only the signed-in user whose
// email equals OWNER_EMAIL sees it; everyone else (signed out included) gets a 404. Without
// OWNER_EMAIL it only says how to set it. Every check runs on each visit; nothing is cached.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SetupLocked, SetupView } from '@/components/setup/setup-view'
import { getRuntime } from '@/lib/server/deps'
import { ownerEmailOf, setupAccess } from '@/lib/server/owner'
import { runSetupChecks } from '@/lib/server/setup/checks'
import { setupDepsFromRuntime } from '@/lib/server/setup/deps'
import { currentUser } from '@/lib/ui/runtime'
import { createStripeCatalogAction, createStripeWebhookAction, fixStorageCorsAction, setupBillingPortalAction } from './actions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Launch setup',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function SetupPage() {
  const rt = await getRuntime()
  const ownerEmail = ownerEmailOf(rt.config)
  const user = await currentUser().catch(() => null)
  const access = setupAccess(user, ownerEmail)
  if (access.kind === 'unset') return <SetupLocked />
  if (access.kind === 'denied' || !ownerEmail) notFound()
  const report = await runSetupChecks(setupDepsFromRuntime(rt))
  return (
    <SetupView
      report={report}
      ownerEmail={ownerEmail}
      actions={{
        fix_storage_cors: fixStorageCorsAction,
        create_stripe_catalog: createStripeCatalogAction,
        create_stripe_webhook: createStripeWebhookAction,
        setup_billing_portal: setupBillingPortalAction,
      }}
    />
  )
}
