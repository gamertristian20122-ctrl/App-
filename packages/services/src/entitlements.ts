// Entitlements for a user row: plan + add-ons + subscription status + trial, the usage period, and
// the gates every write path uses (canCreate / canProcessMedia / canPublish).

import { AppError } from '@app/core/errors'
import { entitlements as planEntitlements, type Entitlements } from '@app/core/plans'
import { usagePeriod, type Period } from '@app/core/time'
import type { SubscriptionStatus } from '@app/core/types'
import type { UserRow } from '@app/db'

export interface UserEntitlements extends Entitlements {
  /** The usage-metering period containing `now`. */
  period: Period
  /** When the in-app trial ends (or ended); null without a trial. */
  trialEndsAt: Date | null
  /** The trial ran out without a subscription. */
  trialExpired: boolean
  addOns: { extraBrands: number; extraClipHours: number }
}

/**
 * The status entitlements are computed from. An in-app trial (no Stripe subscription) that has
 * ended counts as `none`; with a Stripe subscription, Stripe's status is trusted (its webhook
 * moves trialing → active / past_due).
 */
export function effectiveStatus(user: Pick<UserRow, 'subscriptionStatus' | 'trialEndsAt' | 'stripeSubscriptionId'>, now: Date): SubscriptionStatus {
  if (
    user.subscriptionStatus === 'trialing' &&
    !user.stripeSubscriptionId &&
    user.trialEndsAt !== null &&
    user.trialEndsAt.getTime() <= now.getTime()
  ) {
    return 'none'
  }
  return user.subscriptionStatus
}

export function userEntitlements(user: UserRow, now: Date): UserEntitlements {
  const status = effectiveStatus(user, now)
  const addOns = { extraBrands: user.extraBrands, extraClipHours: user.extraClipHours }
  const base = planEntitlements(user.plan, addOns, status)
  return {
    ...base,
    period: usagePeriod(now, { start: user.currentPeriodStart, end: user.currentPeriodEnd }),
    trialEndsAt: user.trialEndsAt,
    trialExpired: user.subscriptionStatus === 'trialing' && status === 'none',
    addOns,
  }
}

function holdMessage(ent: UserEntitlements): string {
  if (ent.trialExpired) return 'Your free trial has ended. Choose a plan to continue.'
  switch (ent.status) {
    case 'past_due':
      return 'Your last payment did not go through. Update your payment method to continue.'
    case 'canceled':
      return 'Your subscription has ended. Choose a plan to continue.'
    case 'unpaid':
      return 'Your subscription is on hold for an unpaid invoice. Update your payment method to continue.'
    default:
      return 'Choose a plan to continue.'
  }
}

/** New drafts, approvals, scheduling, brands, connections, imports. */
export function requireCanCreate(ent: UserEntitlements): void {
  if (!ent.canCreate) throw new AppError('payment_required', holdMessage(ent), { status: ent.status })
}

/** New clipping, transcription and rendering (blocked while past_due too). */
export function requireCanProcessMedia(ent: UserEntitlements): void {
  if (!ent.canProcessMedia) {
    const message =
      ent.status === 'past_due'
        ? 'Clipping and rendering are paused until your payment method is updated.'
        : holdMessage(ent)
    throw new AppError('payment_required', message, { status: ent.status })
  }
}
