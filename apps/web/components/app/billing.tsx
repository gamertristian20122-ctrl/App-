// Billing: current plan, status and period, usage, add-ons, and the Stripe Checkout / Customer
// Portal forms (POST /api/stripe/checkout and /api/stripe/portal).

import type { ReactNode } from 'react'
import { PLANS, formatCents } from '@app/core/plans'
import { Card, Meter, Notice, PageHeader, StatusPill } from '@/components/ui/primitives'
import { button } from '@/components/ui/styles'
import type { BillingData } from '@/lib/ui/data'
import { formatClipHours, formatDate, plural } from '@/lib/ui/format'
import { PlanPicker } from './plan-picker'

export type CheckoutNotice = 'success' | 'canceled' | 'has_subscription'

const CHECKOUT_NOTICES: Record<CheckoutNotice, { tone: 'success' | 'info' | 'warning'; text: string }> = {
  success: { tone: 'success', text: 'Thanks! Your plan is being activated. This page updates within a minute.' },
  canceled: { tone: 'info', text: 'Checkout was canceled. Nothing was charged.' },
  has_subscription: { tone: 'warning', text: 'You already have a subscription. Change your plan or add-ons in the billing portal.' },
}

/** Whether the user should manage billing in the portal rather than start a new checkout. */
export function hasSubscription(user: BillingData['billing']['user']): boolean {
  return Boolean(user.stripeSubscriptionId) && ['active', 'trialing', 'past_due', 'unpaid'].includes(user.subscriptionStatus)
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  )
}

export function BillingView({ data, notice }: { data: BillingData; notice: CheckoutNotice | null }) {
  const { user, entitlements: ent, monthlyPriceCents } = data.billing
  const subscribed = hasSubscription(user)
  const planName = user.plan ? PLANS[user.plan].name : 'No plan'
  return (
    <>
      <PageHeader title="Billing" description="Your plan, what you have used this period, and add-ons." />
      {notice ? (
        <Notice tone={CHECKOUT_NOTICES[notice].tone} className="mb-6">
          {CHECKOUT_NOTICES[notice].text}
        </Notice>
      ) : null}
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Current plan" actions={<StatusPill status={ent.trialExpired ? 'none' : ent.status} label={ent.trialExpired ? 'Trial ended' : undefined} />}>
            <dl className="divide-y divide-neutral-200 dark:divide-neutral-800">
              <Row label="Plan">{ent.trial ? `${planName} (free trial)` : planName}</Row>
              <Row label="Price">{monthlyPriceCents !== null ? `${formatCents(monthlyPriceCents)}/month` : ent.trial ? 'Free during the trial' : '—'}</Row>
              {ent.trial && ent.trialEndsAt ? <Row label="Trial ends">{formatDate(ent.trialEndsAt, user.timezone)}</Row> : null}
              <Row label="Current period">
                {formatDate(ent.period.start, user.timezone)} – {formatDate(ent.period.end, user.timezone)}
              </Row>
              <Row label="Extra brands">{user.extraBrands}</Row>
              <Row label="Extra clipping hours">{user.extraClipHours}</Row>
            </dl>
            {user.stripeCustomerId ? (
              <form method="post" action="/api/stripe/portal" className="mt-4">
                <button type="submit" className={button.secondary}>
                  Manage billing, add-ons and invoices
                </button>
              </form>
            ) : null}
          </Card>

          <Card title="Usage this period">
            <div className="space-y-6">
              <Meter
                label="Clipping hours"
                used={data.clip.used}
                limit={data.clip.limit}
                display={`${formatClipHours(data.clip.used)} of ${formatClipHours(data.clip.limit)}`}
                hint="Counted once per source video. Failed uploads and transcriptions are refunded."
              />
              <Meter label="Active brands" kind="slots" used={data.brandsActive} limit={ent.brands} display={`${data.brandsActive} of ${ent.brands}`} />
              <p className="text-xs text-neutral-500">
                Limits: {plural(ent.brands, 'brand')}, {formatClipHours(ent.clipSeconds)} of clipping a month.
                {ent.status === 'past_due' ? ' Clipping and rendering are paused until payment succeeds.' : ''}
              </p>
            </div>
          </Card>
        </div>

        {subscribed ? (
          <Card title="Change plan">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Upgrades apply right away; downgrades at the end of the period. Use the billing portal to change your plan or add-on quantities, or to cancel.
            </p>
            <form method="post" action="/api/stripe/portal" className="mt-4">
              <button type="submit" className={button.primary}>
                Open the billing portal
              </button>
            </form>
          </Card>
        ) : (
          <Card title="Choose a plan" description="Billed monthly through Stripe. Cancel any time; nothing is deleted.">
            <PlanPicker defaultPlan={user.plan ?? 'plus'} />
          </Card>
        )}
      </div>
    </>
  )
}
