// Opens the Stripe customer portal (plan changes, payment method, cancel) with the configuration
// /setup created, when there is one. Form posts are redirected there; JSON requests get { url }.

import { AppError } from '@app/core/errors'
import { getRuntime } from '@/lib/server/deps'
import { crossOrigin, errorResponse, isFormPost, isSameOrigin, json, seeOther, unavailable } from '@/lib/server/http'
import { notSignedIn, userFromRequest } from '@/lib/server/session'
import { SETTING_KEYS, getPlainSetting, stripeModeOf } from '@/lib/server/settings'
import { getStripe } from '@/lib/server/stripe'

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
  try {
    const params = await services.billing.portalParams(user.id)
    const stripe = getStripe(config)
    if (!stripe) throw new AppError('unavailable', 'Billing is not configured yet.')
    // the portal configuration /setup created for this Stripe mode, if any (else Stripe's default)
    const mode = stripeModeOf(config.STRIPE_SECRET_KEY)
    const configuration = mode ? await getPlainSetting(rt.db, SETTING_KEYS.stripePortalConfiguration(mode)) : null
    const session = await stripe.createPortalSession({
      customer: params.customer,
      returnUrl: params.returnUrl,
      ...(configuration ? { configuration } : {}),
    })
    return isFormPost(req) ? seeOther(session.url) : json({ url: session.url })
  } catch (error) {
    return errorResponse(error, log)
  }
}
