// The one-tap fixes on /setup. Each is idempotent (a second run changes nothing), returns a short
// message for the page, and never returns a secret. External calls go through @app/storage and the
// Stripe admin helper. Server-only.

import { corsProblems, originOf, storageErrorReason, supportsBucketAdmin, withUploadCorsRule, type CorsRule } from '@app/storage'
import type { SetupActionId } from '@/lib/ui/setup'
import type { SetupDeps } from './deps'
import { createCatalog, createWebhook, safeMessage, setupPortal, type ActionOutcome } from './stripe'

const CORS_BY_HAND =
  'Your R2 token may not change bucket settings (that needs “Admin Read & Write”). Copy the policy from this page and paste it in Cloudflare → R2 → your bucket → Settings → CORS policy → Edit → Save.'

export async function fixStorageCors(deps: SetupDeps): Promise<ActionOutcome> {
  const c = deps.config
  if (c.STORAGE_DRIVER !== 'r2') return { ok: false, message: 'Files are not stored in R2 yet (STORAGE_DRIVER is not r2).' }
  const storage = deps.storage
  if (!supportsBucketAdmin(storage)) return { ok: false, message: 'This storage driver cannot change CORS settings.' }
  let existing: CorsRule[] = []
  try {
    existing = await storage.getBucketCors()
    if (corsProblems(existing, c.APP_URL).length === 0) {
      return { ok: true, message: `Nothing to do: uploads from ${originOf(c.APP_URL)} are already allowed.`, meta: { cors: 'unchanged' } }
    }
  } catch (error) {
    // an object-only token may not read the policy; try to write ours anyway
    if (storageErrorReason(error) !== 'storage_auth') return { ok: false, message: safeMessage(error) }
  }
  try {
    await storage.putBucketCors(withUploadCorsRule(existing, c.APP_URL))
  } catch (error) {
    if (storageErrorReason(error) === 'storage_auth') return { ok: false, message: CORS_BY_HAND, meta: { cors: 'refused' } }
    return { ok: false, message: safeMessage(error) }
  }
  return { ok: true, message: `Storage CORS updated: browsers may now upload from ${originOf(c.APP_URL)}.`, meta: { cors: 'updated' } }
}

export const SETUP_ACTION_HANDLERS: Readonly<Record<SetupActionId, (deps: SetupDeps) => Promise<ActionOutcome>>> = {
  fix_storage_cors: fixStorageCors,
  create_stripe_catalog: createCatalog,
  create_stripe_webhook: createWebhook,
  setup_billing_portal: setupPortal,
}

export type { ActionOutcome }
