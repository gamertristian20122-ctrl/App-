// Services configuration: the few knobs business rules need. Built from the app Config (env) by
// wiring.ts, or passed partially by tests (everything has a default).

import type { Config, EnvSource } from '@app/core/config'
import { ADD_ON_KEYS, type AddOnKey } from '@app/core/plans'
import { PLAN_TIERS, type PlanTier } from '@app/core/types'
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@app/core/time'

/** Every Stripe price we sell, by lookup key (plans + add-ons). */
export type PriceKey = PlanTier | AddOnKey
export const PRICE_KEYS: readonly PriceKey[] = [...PLAN_TIERS, ...ADD_ON_KEYS]

export interface ServicesConfig {
  /** Public base URL of the web app (no trailing slash): approval links, checkout return URLs. */
  appUrl: string
  /** Lifetime of a one-time approval nonce. Default 24 h. */
  approvalNonceTtlSec: number
  /** Stripe price ids by lookup key (optional: Stripe events also carry price.lookup_key). */
  stripePrices: Partial<Record<PriceKey, string>>
  /** Presigned GET lifetime for previews in the approval card / web app. */
  previewUrlTtlSec: number
  /** Presigned GET lifetime for media handed to the posting provider (it downloads asynchronously). */
  publishUrlTtlSec: number
  /** Presigned PUT lifetime for browser uploads. */
  uploadUrlTtlSec: number
  /** Clip ranges per make_clips request (core allows 30; the product limit is lower). */
  maxClipsPerRequest: number
  /** Clips per source video that are queued, rendering or ready. */
  maxActiveClipsPerSource: number
  /** How early a publish job may run before scheduled_for (clock skew between hosts). */
  publishEarlyToleranceMs: number
  /** Cap full at dispatch: move the post this far (ARCHITECTURE: +1 h). */
  capRetryDelayMs: number
  /** Account on hold (canceled / unpaid): try the publish again after this long. */
  heldRetryDelayMs: number
  /** First status poll after a publish request; later polls back off. */
  statusPollDelayMs: number
  /** Longest gap between status polls. */
  statusPollMaxDelayMs: number
  /** Give up polling (mark failed) after this many polls. */
  statusPollMaxPolls: number
  /** Re-import of past posts for the same account is deduplicated within this window. */
  importDedupeWindowMs: number
  /** Canonical MCP resource URL (OAuth audience); default appUrl + "/api/mcp". */
  mcpResourceUrl: string
  /** OAuth access-token lifetime (OAUTH_ACCESS_TOKEN_TTL_SEC). */
  oauthAccessTokenTtlSec: number
  /** OAuth refresh-token lifetime (OAUTH_REFRESH_TOKEN_TTL_SEC); rotated on every use. */
  oauthRefreshTokenTtlSec: number
  /** OAuth authorization-code lifetime (OAUTH_CODE_TTL_SEC). */
  oauthCodeTtlSec: number
}

export const DEFAULT_SERVICES_CONFIG: Readonly<ServicesConfig> = Object.freeze({
  appUrl: 'http://localhost:3000',
  approvalNonceTtlSec: 24 * 3_600,
  stripePrices: {},
  previewUrlTtlSec: 3_600,
  publishUrlTtlSec: 6 * 3_600,
  uploadUrlTtlSec: 3_600,
  maxClipsPerRequest: 20,
  maxActiveClipsPerSource: 60,
  publishEarlyToleranceMs: 30 * SECOND_MS,
  capRetryDelayMs: HOUR_MS,
  heldRetryDelayMs: 6 * HOUR_MS,
  statusPollDelayMs: 15 * SECOND_MS,
  statusPollMaxDelayMs: 10 * MINUTE_MS,
  statusPollMaxPolls: 60,
  importDedupeWindowMs: HOUR_MS,
  mcpResourceUrl: '',
  oauthAccessTokenTtlSec: 3_600,
  oauthRefreshTokenTtlSec: 30 * 86_400,
  oauthCodeTtlSec: 300,
})

export function resolveServicesConfig(partial: Partial<ServicesConfig> = {}): ServicesConfig {
  const merged: ServicesConfig = { ...DEFAULT_SERVICES_CONFIG, ...stripUndefined(partial) }
  merged.appUrl = merged.appUrl.replace(/\/+$/, '')
  merged.stripePrices = { ...(partial.stripePrices ?? {}) }
  merged.approvalNonceTtlSec = clamp(merged.approvalNonceTtlSec, 60, 30 * 86_400)
  merged.maxClipsPerRequest = clamp(merged.maxClipsPerRequest, 1, 30)
  merged.maxActiveClipsPerSource = clamp(merged.maxActiveClipsPerSource, 1, 1_000)
  merged.importDedupeWindowMs = clamp(merged.importDedupeWindowMs, MINUTE_MS, DAY_MS)
  merged.mcpResourceUrl = (merged.mcpResourceUrl || `${merged.appUrl}/api/mcp`).replace(/\/+$/, '')
  merged.oauthAccessTokenTtlSec = clamp(merged.oauthAccessTokenTtlSec, 60, 86_400)
  merged.oauthRefreshTokenTtlSec = clamp(merged.oauthRefreshTokenTtlSec, 3_600, 365 * 86_400)
  merged.oauthCodeTtlSec = clamp(merged.oauthCodeTtlSec, 30, 600)
  return merged
}

/** Optional env vars for Stripe price ids (not in core config): STRIPE_PRICE_STARTER, ..._EXTRA_CLIP_HOUR. */
export const STRIPE_PRICE_ENV: Readonly<Record<PriceKey, string>> = {
  starter: 'STRIPE_PRICE_STARTER',
  plus: 'STRIPE_PRICE_PLUS',
  pro: 'STRIPE_PRICE_PRO',
  extra_brand: 'STRIPE_PRICE_EXTRA_BRAND',
  extra_clip_hour: 'STRIPE_PRICE_EXTRA_CLIP_HOUR',
}

const PRICE_ID_RE = /^price_[A-Za-z0-9]{6,}$/

/** Builds the services config from the validated app config (and the optional Stripe price env vars). */
export function servicesConfigFromAppConfig(config: Config, env: EnvSource = {}): ServicesConfig {
  const stripePrices: Partial<Record<PriceKey, string>> = {}
  for (const key of PRICE_KEYS) {
    const name = STRIPE_PRICE_ENV[key] as keyof Config
    const fromConfig = config[name]
    const value = (typeof fromConfig === 'string' ? fromConfig : env[STRIPE_PRICE_ENV[key]])?.trim()
    if (value && PRICE_ID_RE.test(value)) stripePrices[key] = value
  }
  return resolveServicesConfig({
    appUrl: config.APP_URL,
    // The task contract: approval nonces live at most 24 h, whatever the env allows.
    approvalNonceTtlSec: Math.min(config.APPROVAL_NONCE_TTL_SEC, 24 * 3_600),
    stripePrices,
    ...(config.MCP_RESOURCE_URL ? { mcpResourceUrl: config.MCP_RESOURCE_URL } : {}),
    ...(config.OAUTH_ACCESS_TOKEN_TTL_SEC ? { oauthAccessTokenTtlSec: config.OAUTH_ACCESS_TOKEN_TTL_SEC } : {}),
    ...(config.OAUTH_REFRESH_TOKEN_TTL_SEC ? { oauthRefreshTokenTtlSec: config.OAUTH_REFRESH_TOKEN_TTL_SEC } : {}),
    ...(config.OAUTH_CODE_TTL_SEC ? { oauthCodeTtlSec: config.OAUTH_CODE_TTL_SEC } : {}),
  })
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}
