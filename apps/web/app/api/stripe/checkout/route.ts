// Starts Stripe Checkout for a plan plus add-on quantities (subscription mode). The line items,
// client_reference_id (= user id), customer reuse and URLs come from services.billing; this
// route only resolves price lookup keys and creates the session. Form posts are redirected to
// Checkout; JSON requests get { id, url }.

import { AppError } from '@app/core/errors'
import { getRuntime } from '@/lib/server/deps'
import { crossOrigin, errorResponse, isSameOrigin, json, readBody, seeOther, unavailable } from '@/lib/server/http'
import { notSignedIn, userFromRequest } from '@/lib/server/session'
import { getStripe } from '@/lib/server/stripe'
import { quantityField, stringField } from '@/lib/server/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  const { services, config, log } = rt
  if (!isSameOrigin(req, config.APP_URL)) return crossOrigin()
  const user = await userFromRequest(req)
  if (!user) return notSignedIn()

  const body = await readBody(req, 4096)
  if (!body.ok) return body.response
  // HTML forms send strings, JSON numbers; services.billing validates the plan and the ranges.
  const plan = stringField(body.data.plan, { max: 20, trim: true })
  const extraBrands = quantityField(body.data.extraBrands)
  const extraClipHours = quantityField(body.data.extraClipHours)
  if (!plan.ok) return errorResponse(new AppError('validation', 'Choose a plan.'))
  if (!extraBrands.ok || !extraClipHours.ok) return errorResponse(new AppError('validation', 'Add-on quantities must be whole numbers.'))

  try {
    const params = await services.billing.checkoutParams(user.id, {
      plan: plan.value,
      ...(extraBrands.value !== undefined ? { extraBrands: extraBrands.value } : {}),
      ...(extraClipHours.value !== undefined ? { extraClipHours: extraClipHours.value } : {}),
    })
    const stripe = getStripe(config)
    if (!stripe) throw new AppError('unavailable', 'Billing is not configured yet.')

    const missing = params.lineItems.filter((i) => !i.price).map((i) => i.lookupKey)
    const byKey = missing.length > 0 ? await stripe.pricesByLookupKey(missing) : new Map<string, string>()
    const lineItems = params.lineItems.map((i) => {
      const price = i.price ?? byKey.get(i.lookupKey)
      if (!price) {
        log.error('stripe price missing for lookup key', { lookupKey: i.lookupKey })
        throw new AppError('unavailable', 'This plan is not available right now. Please try again later.')
      }
      return { price, quantity: i.quantity }
    })

    const session = await stripe.createCheckoutSession({
      mode: params.mode,
      lineItems,
      clientReferenceId: params.clientReferenceId,
      customer: params.customer,
      customerEmail: params.customerEmail,
      metadata: params.metadata,
      subscriptionMetadata: params.subscriptionData.metadata,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      allowPromotionCodes: params.allowPromotionCodes,
    })
    if (!session.url) throw new AppError('unavailable', 'Checkout could not be started. Please try again.')
    if (body.kind === 'form') return seeOther(session.url)
    return json({ id: session.id, url: session.url, monthlyPriceCents: params.monthlyPriceCents })
  } catch (error) {
    if (body.kind === 'form' && error instanceof AppError && error.details?.portal === true) {
      return seeOther('/app/billing?checkout=has_subscription')
    }
    return errorResponse(error, log)
  }
}
