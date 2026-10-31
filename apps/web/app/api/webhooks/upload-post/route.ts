// Upload-Post webhooks: signature verification (HMAC over "<timestamp>.<raw body>", several
// secrets during rotation) via @app/posting, then services. Answers quickly with 200 once the
// delivery is verified, even when applying it fails (the provider never retries and pauses a
// webhook after repeated failures; the worker's status polling is the safety net).

import { isAppError } from '@app/core/errors'
import { MAX_WEBHOOK_BYTES, parseUploadPostWebhook, webhookSecrets, type UploadPostWebhookEvent } from '@app/posting'
import { getRuntime } from '@/lib/server/deps'
import { errorJson, json, readBodyText, tooLarge, unavailable } from '@/lib/server/http'
import { applyUploadPostEvent } from '@/lib/server/upload-post-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  const { config, log } = rt
  const raw = await readBodyText(req, MAX_WEBHOOK_BYTES)
  if (raw === null) return tooLarge()

  let event: UploadPostWebhookEvent
  try {
    event = parseUploadPostWebhook({
      rawBody: raw,
      headers: req.headers,
      secrets: webhookSecrets(config.UPLOAD_POST_WEBHOOK_SECRET),
      now: rt.clock.now(),
    })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'internal'
    if (code === 'unavailable') return errorJson(503, 'unavailable', 'Webhooks are not configured.')
    if (code === 'unauthorized') {
      log.warn('upload-post webhook rejected')
      return errorJson(401, 'unauthorized', 'Invalid webhook signature.')
    }
    return errorJson(400, 'bad_request', isAppError(error) ? error.message : 'Invalid webhook.')
  }

  try {
    const outcome = await applyUploadPostEvent(rt, event)
    return json({ received: true, ...outcome })
  } catch (error) {
    log.error('upload-post webhook failed', error instanceof Error ? error : { error: String(error) })
    return json({ received: true, applied: 0 })
  }
}
