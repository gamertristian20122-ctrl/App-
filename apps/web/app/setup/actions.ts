'use server'

// The one-tap fixes on /setup. Owner only (anyone else gets a 404), rate-limited, audited without
// secrets; each is idempotent. Next.js checks every server action's origin (CSRF).

import type { ActionResult } from '@/lib/ui/action-result'
import { runSetupAction } from '@/lib/server/setup/run'

export async function fixStorageCorsAction(_prev: ActionResult, _fd: FormData): Promise<ActionResult> {
  return runSetupAction('fix_storage_cors')
}

export async function createStripeCatalogAction(_prev: ActionResult, _fd: FormData): Promise<ActionResult> {
  return runSetupAction('create_stripe_catalog')
}

export async function createStripeWebhookAction(_prev: ActionResult, _fd: FormData): Promise<ActionResult> {
  return runSetupAction('create_stripe_webhook')
}

export async function setupBillingPortalAction(_prev: ActionResult, _fd: FormData): Promise<ActionResult> {
  return runSetupAction('setup_billing_portal')
}
