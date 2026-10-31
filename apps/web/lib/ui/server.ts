// Glue between Next.js and the UI logic: the selected-brand cookie, the per-request page context
// (user + services + brands) and the server-action runner (sign-in check, error mapping, cache
// revalidation). Server-only.

import type { BrandRow } from '@app/db'
import type { Services } from '@app/services'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import type { CurrentUser } from '@/lib/auth'
import { failed, failure, isNavigationError, type ActionResult } from './action-result'
import { isServiceError } from './errors'
import { pickBrand } from './data'
import { isId } from './form'
import { currentUser, getUiRuntime, requireSignedIn, type UiRuntime } from './runtime'

export const BRAND_COOKIE = 'ui_brand'

export async function preferredBrandId(): Promise<string | null> {
  try {
    const value = (await cookies()).get(BRAND_COOKIE)?.value
    return isId(value) ? value.toLowerCase() : null
  } catch {
    return null
  }
}

export async function rememberBrand(brandId: string, secure: boolean): Promise<void> {
  ;(await cookies()).set(BRAND_COOKIE, brandId, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 365 * 86_400 })
}

export interface PageContext {
  user: CurrentUser
  rt: UiRuntime
  services: Services
  /** Active and suspended brands. */
  brands: BrandRow[]
  brand: BrandRow | null
  now: Date
}

/** Signed-in user, services and the selected brand for a dashboard page (`path` is the ?next= target). */
export async function pageContext(path: string, brandOverride?: string | null): Promise<PageContext> {
  const user = await requireSignedIn(path)
  const rt = await getUiRuntime()
  const brands = await rt.services.brands.list(user.id, { status: ['active', 'suspended'] })
  const preferred = brandOverride && isId(brandOverride) ? brandOverride.toLowerCase() : await preferredBrandId()
  return { user, rt, services: rt.services, brands, brand: pickBrand(brands, preferred), now: rt.now() }
}

export interface ActionContext {
  services: Services
  userId: string
  rt: UiRuntime
}

/**
 * Runs a server action's logic for the signed-in user, maps unexpected errors to a generic
 * message (logged without details that could hold secrets), and refreshes the dashboard (layout
 * counts, banners and the current page).
 */
export async function runAction(fn: (ctx: ActionContext) => Promise<ActionResult>): Promise<ActionResult> {
  const user = await currentUser()
  if (!user) return failed('Your session has ended. Sign in again.')
  const rt = await getUiRuntime()
  let result: ActionResult
  try {
    result = await fn({ services: rt.services, userId: user.id, rt })
  } catch (error) {
    if (isNavigationError(error)) throw error
    if (!isServiceError(error)) rt.log.error('dashboard action failed', { error: error instanceof Error ? error.name : 'unknown' })
    result = failure(error)
  }
  revalidatePath('/app', 'layout')
  return result
}
