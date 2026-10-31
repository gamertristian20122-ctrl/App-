// Stripe webhooks: verify the signature on the raw body (STRIPE_WEBHOOK_SECRET), then
// services.billing.applyStripeEvent (idempotent via stripe_events; re-reads the subscription
// from Stripe when an API key is configured, so event order does not matter).
// 2xx for processed / ignored / duplicate; non-2xx for unmatched and failures so Stripe retries.

import { getRuntime } from '@/lib/server/deps'
import { errorJson, json, readBodyText, tooLarge, unavailable } from '@/lib/server/http'
import { getStripe, verifyStripeWebhook } from '@/lib/server/stripe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 512 * 1024

export async function POST(req: Request): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  const { services, config, log } = rt
  const secret = config.STRIPE_WEBHOOK_SECRET
  if (!secret) return errorJson(503, 'unavailable', 'Stripe webhooks are not configured.')

  const signature = req.headers.get('stripe-signature')
  if (!signature || signature.length > 4096) return errorJson(400, 'bad_request', 'Missing Stripe signature.')
  const raw = await readBodyText(req, MAX_BODY)
  if (raw === null) return tooLarge()

  let event: unknown
  try {
    event = verifyStripeWebhook(raw, signature, secret)
  } catch {
    log.warn('stripe webhook signature rejected')
    return errorJson(400, 'bad_request', 'Invalid Stripe signature.')
  }

  const stripe = getStripe(config)
  try {
    const result = await services.billing.applyStripeEvent(event, stripe ? { fetchSubscription: (id) => stripe.retrieveSubscription(id) } : {})
    log.info('stripe event', { eventId: result.eventId, type: result.type, status: result.status })
    if (result.status === 'unmatched') {
      return json({ received: false, status: result.status }, { status: 409 })
    }
    return json({ received: true, status: result.status })
  } catch (error) {
    const status = error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status < 500 ? 400 : 500
    log.error('stripe event failed', error instanceof Error ? error : { error: String(error) })
    return errorJson(status, status === 400 ? 'bad_request' : 'internal', status === 400 ? 'The event could not be applied.' : 'Processing failed; Stripe will retry.')
  }
}
