// The pricing table, generated from @app/core/plans (the single source of truth for prices and
// limits), so the page can never drift from what billing enforces.

import Link from 'next/link'
import { ADD_ONS, ADD_ON_KEYS, GB, PLANS, TRIAL, formatCents } from '@app/core/plans'
import { PLAN_TIERS, PLATFORMS, type PlanTier } from '@app/core/types'
import { button, cx } from '@/components/ui/styles'
import { plural } from '@/lib/ui/format'

const HIGHLIGHT: PlanTier = 'plus'

const BLURB: Record<PlanTier, string> = {
  starter: 'For one creator or one brand.',
  plus: 'For a creator with a second brand or show.',
  pro: 'For small teams and agencies.',
}

const SHARED = [
  `All ${PLATFORMS.length} platforms`,
  'Approval queue with per-platform previews',
  'Voice profile from your past posts',
  'Weekly review from your analytics',
  'Works with Claude, ChatGPT and Cursor',
]

export function planFeatures(tier: PlanTier): string[] {
  const plan = PLANS[tier]
  return [
    plural(plan.brands, 'brand'),
    `${plural(plan.clipHours, 'clipping hour')} a month`,
    `${Math.round(plan.storageBytes / GB)} GB media storage`,
    ...SHARED,
  ]
}

export function PricingTable({ ctaHref = '/login', ctaLabel = 'Start free trial' }: { ctaHref?: string; ctaLabel?: string }) {
  return (
    <div>
      <ul className="grid gap-6 md:grid-cols-3" aria-label="Plans">
        {PLAN_TIERS.map((tier) => {
          const plan = PLANS[tier]
          const highlight = tier === HIGHLIGHT
          return (
            <li
              key={tier}
              data-plan={tier}
              className={cx(
                'relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm dark:bg-neutral-900',
                highlight ? 'border-indigo-500 ring-2 ring-indigo-500' : 'border-neutral-200 dark:border-neutral-800',
              )}
            >
              {highlight ? (
                <span className="absolute -top-3 left-6 rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-semibold text-white">Most popular</span>
              ) : null}
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{BLURB[tier]}</p>
              <p className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-bold tracking-tight" data-testid="price">
                  {formatCents(plan.priceCents)}
                </span>
                <span className="text-sm text-neutral-500">/month</span>
              </p>
              <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                {planFeatures(tier).map((f) => (
                  <li key={f} className="flex gap-2">
                    <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600">
                      <path fill="currentColor" d="M7.6 13.2 4.4 10l-1.1 1.1 4.3 4.3 9.2-9.2-1.1-1.1z" />
                    </svg>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href={ctaHref} className={cx(highlight ? button.primary : button.secondary, 'mt-8 w-full')}>
                {ctaLabel}
                <span className="sr-only"> with {plan.name}</span>
              </Link>
            </li>
          )
        })}
      </ul>

      <div className="mt-8 grid gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-6 sm:grid-cols-2 dark:border-neutral-800 dark:bg-neutral-900/50">
        <div>
          <h3 className="font-semibold">Add-ons</h3>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Add to any plan, change any time.</p>
        </div>
        <ul className="space-y-2 text-sm" aria-label="Add-ons">
          {ADD_ON_KEYS.map((key) => (
            <li key={key} data-addon={key} className="flex items-baseline justify-between gap-4">
              <span>{ADD_ONS[key].name}</span>
              <span className="font-semibold tabular-nums">{formatCents(ADD_ONS[key].priceCents)}/month each</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-6 text-center text-sm text-neutral-600 dark:text-neutral-400">
        Every account starts with a free {TRIAL.days}-day trial of {PLANS[TRIAL.plan].name} with {plural(TRIAL.clipHours, 'clipping hour')}. No card
        needed to start. Clipping hours count the length of each source video once, however many clips you make; unused hours do not roll over.
      </p>
    </div>
  )
}
