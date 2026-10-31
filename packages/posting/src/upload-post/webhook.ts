// Upload-Post webhooks: signature verification and zod-validated parsing into provider-neutral events.
//
// Signature (docs: api/webhooks "Verifying signatures", verified 2026-10-31):
//   X-Upload-Post-Signature: sha256=<hex HMAC-SHA256(webhook_secret, "<timestamp>.<raw body>")>
//   X-Upload-Post-Timestamp: unix seconds; reject anything older than ~5 minutes
//   X-Upload-Post-Delivery:  unique delivery id (dedupe / tracing)
// Verify against the raw bytes, before JSON parsing. Several secrets may be given during rotation.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '@app/core/errors'
import type { PublishStatus } from '@app/core/ports'
import { isPlatform, type AccountStatus, type Platform } from '@app/core/types'
import { safeProviderMessage } from '../errors'
import { WEBHOOK_HEADERS, WEBHOOK_TOLERANCE_SEC, rewriteProviderText } from './constants'
import { PlatformResultSchema, resultToStatus } from './status'

export type WebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>

export interface VerifyWebhookInput {
  /** The raw request body exactly as received (string or bytes). */
  rawBody: string | Uint8Array
  headers: WebhookHeaders
  /** The account webhook secret; pass [current, previous] while rotating. */
  secrets: string | readonly string[]
  now?: Date
  toleranceSec?: number
}

/** Bodies above this are refused before hashing (Upload-Post events are a few KB). */
export const MAX_WEBHOOK_BYTES = 1_000_000

export function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() !== lower || v === undefined) continue
    return typeof v === 'string' ? v : v[0]
  }
  return undefined
}

const unauthorized = (message: string) => new AppError('unauthorized', message)

function toBytes(raw: string | Uint8Array): Buffer {
  return typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
}

/** Throws AppError('unauthorized') unless the delivery is signed by one of `secrets` and fresh. */
export function verifyUploadPostSignature(input: VerifyWebhookInput): void {
  const secrets = (typeof input.secrets === 'string' ? [input.secrets] : [...input.secrets]).filter(
    (s) => typeof s === 'string' && s.length > 0,
  )
  if (secrets.length === 0) throw new AppError('unavailable', 'Webhook verification is not configured.')

  const body = toBytes(input.rawBody)
  if (body.byteLength > MAX_WEBHOOK_BYTES) throw new AppError('bad_request', 'Webhook body is too large.')

  const signature = headerValue(input.headers, WEBHOOK_HEADERS.signature)?.trim()
  const timestamp = headerValue(input.headers, WEBHOOK_HEADERS.timestamp)?.trim()
  if (!signature || !timestamp) throw unauthorized('Missing webhook signature.')
  if (!/^\d{1,12}$/.test(timestamp)) throw unauthorized('Invalid webhook timestamp.')

  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000)
  const tolerance = input.toleranceSec ?? WEBHOOK_TOLERANCE_SEC
  if (Math.abs(nowSec - Number(timestamp)) > tolerance) throw unauthorized('Webhook timestamp is outside the allowed window.')

  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(signature)
  if (!match?.[1]) throw unauthorized('Invalid webhook signature.')
  const given = Buffer.from(match[1].toLowerCase(), 'hex')

  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest()
    if (expected.length === given.length && timingSafeEqual(expected, given)) return
  }
  throw unauthorized('Invalid webhook signature.')
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const optionalString = z.string().max(2_000).nullish()

const UploadCompletedSchema = z.looseObject({
  event: z.literal('upload_completed'),
  request_id: optionalString,
  job_id: optionalString,
  external_id: optionalString,
  profile_username: optionalString,
  platform: z.string().max(64),
  media_type: optionalString,
  result: PlatformResultSchema,
  created_at: optionalString,
})

const AccountEventSchema = z.looseObject({
  event: z.string(),
  platform: z.string().max(64),
  account_name: optionalString,
  status: optionalString,
  profile_username: optionalString,
  reason: optionalString,
  created_at: optionalString,
})

const EnvelopeSchema = z.looseObject({ event: z.string().min(1).max(100) })

export interface WebhookEventBase {
  /** X-Upload-Post-Delivery, when present and well-formed (dedupe key). */
  deliveryId: string | null
  /** Provider's platform key as sent (e.g. "instagram", "google_business"). */
  providerPlatform: string
  /** Our platform, or null for platforms we do not support. */
  platform: Platform | null
  /** The provider profile (our brand's profileRef); can be missing on some events. */
  profileRef: string | null
  createdAt: string | null
}

export interface UploadCompletedEvent extends WebhookEventBase {
  type: 'upload_completed'
  requestId: string | null
  jobId: string | null
  /** Our idempotency key (we send it as external_id). */
  externalId: string | null
  status: PublishStatus
}

export interface AccountStatusEvent extends WebhookEventBase {
  type: 'account_status'
  event: 'connected' | 'disconnected' | 'reauth_required'
  accountStatus: AccountStatus
  /** Platform account identifier or handle as the provider reports it. */
  accountName: string | null
  reason: string | null
}

export interface IgnoredEvent {
  type: 'ignored'
  deliveryId: string | null
  event: string
}

export type UploadPostWebhookEvent = UploadCompletedEvent | AccountStatusEvent | IgnoredEvent

const ACCOUNT_EVENTS: Readonly<Record<string, AccountStatusEvent['event']>> = {
  social_account_connected: 'connected',
  social_account_disconnected: 'disconnected',
  social_account_reauth_required: 'reauth_required',
}
const ACCOUNT_STATUS: Readonly<Record<AccountStatusEvent['event'], AccountStatus>> = {
  connected: 'active',
  disconnected: 'disconnected',
  reauth_required: 'needs_reauth',
}

const safe = (raw: unknown) => safeProviderMessage(raw, { rewrite: rewriteProviderText })
const clean = (v: string | null | undefined, max = 200) => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s.slice(0, max)
}
const cleanRef = (v: string | null | undefined) => {
  const s = clean(v, 100)
  return s && /^[A-Za-z0-9_@-]+$/.test(s) ? s : null
}
const cleanId = (v: string | null | undefined) => {
  const s = clean(v, 200)
  return s && /^[\x21-\x7E]+$/.test(s) ? s : null
}
const toPlatform = (p: string): Platform | null => {
  const key = p.toLowerCase() === 'twitter' ? 'x' : p.toLowerCase()
  return isPlatform(key) ? key : null
}

/** Validates an already-verified, already-parsed payload. Unknown events become { type: 'ignored' }. */
export function parseUploadPostWebhookPayload(payload: unknown, deliveryId: string | null = null): UploadPostWebhookEvent {
  const envelope = EnvelopeSchema.safeParse(payload)
  if (!envelope.success) throw new AppError('bad_request', 'Webhook payload has no event.')
  const name = envelope.data.event.replace(/\./g, '_')

  if (name === 'upload_completed') {
    const parsed = UploadCompletedSchema.safeParse({ ...envelope.data, event: name })
    if (!parsed.success) throw new AppError('bad_request', 'Webhook payload is not a valid upload_completed event.')
    const p = parsed.data
    const platform = toPlatform(p.platform)
    return {
      type: 'upload_completed',
      deliveryId,
      providerPlatform: p.platform,
      platform,
      profileRef: cleanRef(p.profile_username),
      createdAt: clean(p.created_at, 64),
      requestId: cleanId(p.request_id),
      jobId: cleanId(p.job_id),
      externalId: cleanId(p.external_id),
      // A webhook result is final for its platform: an undecided result counts as published only with ids.
      status: resultToStatus(p.result, platform ?? undefined, 'completed', safe) ?? { state: 'pending' },
    }
  }

  const accountEvent = ACCOUNT_EVENTS[name]
  if (accountEvent) {
    const parsed = AccountEventSchema.safeParse(envelope.data)
    if (!parsed.success) throw new AppError('bad_request', 'Webhook payload is not a valid account event.')
    const p = parsed.data
    return {
      type: 'account_status',
      event: accountEvent,
      accountStatus: ACCOUNT_STATUS[accountEvent],
      deliveryId,
      providerPlatform: p.platform,
      platform: toPlatform(p.platform),
      profileRef: cleanRef(p.profile_username),
      createdAt: clean(p.created_at, 64),
      accountName: clean(p.account_name),
      reason: clean(p.reason, 100),
    }
  }

  return { type: 'ignored', deliveryId, event: name.slice(0, 100) }
}

/** Verifies the signature, then parses the body. Throws AppError (unauthorized / bad_request / unavailable). */
export function parseUploadPostWebhook(input: VerifyWebhookInput): UploadPostWebhookEvent {
  verifyUploadPostSignature(input)
  const text = typeof input.rawBody === 'string' ? input.rawBody : toBytes(input.rawBody).toString('utf8')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new AppError('bad_request', 'Webhook body is not JSON.')
  }
  const delivery = headerValue(input.headers, WEBHOOK_HEADERS.delivery)?.trim()
  const deliveryId = delivery && /^[A-Za-z0-9_.:-]{1,200}$/.test(delivery) ? delivery : null
  return parseUploadPostWebhookPayload(json, deliveryId)
}

/** Test/dev helper: the headers Upload-Post would send for `rawBody` signed with `secret` at `now`. */
export function signUploadPostWebhook(rawBody: string, secret: string, now: Date = new Date()): Record<string, string> {
  const ts = String(Math.floor(now.getTime() / 1000))
  const sig = createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex')
  return { [WEBHOOK_HEADERS.signature]: `sha256=${sig}`, [WEBHOOK_HEADERS.timestamp]: ts }
}
