// Deployment-wide settings created by the owner's /setup actions (table app_settings, migration
// 0005). Secret values are sealed with TOKEN_ENCRYPTION_KEYS (AES-256-GCM, @app/core/crypto; the
// setting key is the additional data, so a value cannot be moved to another key) before they reach
// the database, and are never logged or shown. Server-only.

import { decryptString, encrypt, parseKeyRing, type KeyRing } from '@app/core/crypto'
import { AppError } from '@app/core/errors'
import { appSettings, type Db } from '@app/db'

export type StripeMode = 'test' | 'live'

/** Stripe keeps test and live objects apart, so do we. */
export const SETTING_KEYS = {
  stripeWebhookSecret: (mode: StripeMode) => `stripe.webhook_secret.${mode}`,
  stripePortalConfiguration: (mode: StripeMode) => `stripe.portal_configuration.${mode}`,
} as const

/** test or live from the key prefix (sk_live_ / rk_live_); null without a key. */
export function stripeModeOf(secretKey: string | null | undefined): StripeMode | null {
  const key = secretKey?.trim()
  if (!key) return null
  return /^(sk|rk)_live_/.test(key) ? 'live' : 'test'
}

function keyRing(spec: string | undefined): KeyRing {
  if (!spec) throw new AppError('unavailable', 'Set TOKEN_ENCRYPTION_KEYS in Vercel first: it encrypts the values this page stores.')
  return parseKeyRing(spec)
}

const aad = (key: string) => `app_settings:${key}`

/** Seals and stores a secret value. */
export async function setSecretSetting(db: Db, encryptionKeys: string | undefined, key: string, plaintext: string): Promise<void> {
  const sealed = encrypt(keyRing(encryptionKeys), plaintext, aad(key))
  await appSettings.set(db, key, sealed, { encrypted: true })
}

/**
 * Reads and opens a secret value; null when it is missing, cannot be decrypted (keys changed) or
 * the table does not exist yet (migration 0005 not applied).
 */
export async function getSecretSetting(db: Db, encryptionKeys: string | undefined, key: string): Promise<string | null> {
  if (!encryptionKeys) return null
  try {
    const row = await appSettings.get(db, key)
    if (!row || !row.encrypted) return null
    return decryptString(keyRing(encryptionKeys), row.value, aad(key))
  } catch {
    return null
  }
}

/** A plain (non-secret) value such as a Stripe configuration id; null when missing. */
export async function getPlainSetting(db: Db, key: string): Promise<string | null> {
  try {
    const row = await appSettings.get(db, key)
    return row && !row.encrypted ? row.value : null
  } catch {
    return null
  }
}

export async function setPlainSetting(db: Db, key: string, value: string): Promise<void> {
  await appSettings.set(db, key, value)
}

/**
 * The Stripe webhook signing secret: STRIPE_WEBHOOK_SECRET from the environment when set,
 * otherwise the one /setup stored when it created the endpoint (for the mode of
 * STRIPE_SECRET_KEY). null when neither exists.
 */
export async function stripeWebhookSecret(
  db: Db,
  config: { STRIPE_WEBHOOK_SECRET?: string | undefined; STRIPE_SECRET_KEY?: string | undefined; TOKEN_ENCRYPTION_KEYS?: string | undefined },
): Promise<{ secret: string; source: 'env' | 'stored' } | null> {
  if (config.STRIPE_WEBHOOK_SECRET) return { secret: config.STRIPE_WEBHOOK_SECRET, source: 'env' }
  const mode = stripeModeOf(config.STRIPE_SECRET_KEY)
  if (!mode) return null
  const stored = await getSecretSetting(db, config.TOKEN_ENCRYPTION_KEYS, SETTING_KEYS.stripeWebhookSecret(mode))
  return stored ? { secret: stored, source: 'stored' } : null
}
