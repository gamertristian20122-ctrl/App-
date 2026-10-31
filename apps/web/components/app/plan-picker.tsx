'use client'

// Plan + add-on chooser that posts to /api/stripe/checkout (a plain form post; the route redirects
// to Stripe Checkout). Shows the monthly total from @app/core/plans as you change it.

import { useState } from 'react'
import { ADD_ONS, PLANS, formatCents, monthlyPriceCents } from '@app/core/plans'
import { PLAN_TIERS, type PlanTier } from '@app/core/types'
import { button, cx, hint, input, label } from '@/components/ui/styles'

function clamp(raw: string, max: number): number {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0
}

export function PlanPicker({ defaultPlan = 'plus' }: { defaultPlan?: PlanTier }) {
  const [plan, setPlan] = useState<PlanTier>(defaultPlan)
  const [extraBrands, setExtraBrands] = useState(0)
  const [extraClipHours, setExtraClipHours] = useState(0)
  const total = monthlyPriceCents(plan, { extraBrands, extraClipHours })
  return (
    <form method="post" action="/api/stripe/checkout" className="space-y-5" aria-label="Choose a plan">
      <fieldset>
        <legend className={label}>Plan</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {PLAN_TIERS.map((t) => {
            const p = PLANS[t]
            return (
              <label
                key={t}
                className={cx(
                  'flex cursor-pointer flex-col rounded-xl border p-4 text-sm',
                  plan === t ? 'border-indigo-500 ring-2 ring-indigo-500' : 'border-neutral-300 dark:border-neutral-700',
                )}
              >
                <span className="flex items-center justify-between">
                  <span className="font-semibold">{p.name}</span>
                  <input type="radio" name="plan" value={t} checked={plan === t} onChange={() => setPlan(t)} />
                </span>
                <span className="mt-1 text-2xl font-bold">
                  {formatCents(p.priceCents)}
                  <span className="text-sm font-normal text-neutral-500">/mo</span>
                </span>
                <span className="mt-1 text-neutral-600 dark:text-neutral-400">
                  {p.brands} {p.brands === 1 ? 'brand' : 'brands'} · {p.clipHours} clipping hours
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="extraBrands" className={label}>
            Extra brands
          </label>
          <input
            id="extraBrands"
            name="extraBrands"
            type="number"
            min={0}
            max={ADD_ONS.extra_brand.maxQuantity}
            value={extraBrands}
            onChange={(e) => setExtraBrands(clamp(e.target.value, ADD_ONS.extra_brand.maxQuantity))}
            className={cx(input, 'mt-1')}
          />
          <p className={hint}>{formatCents(ADD_ONS.extra_brand.priceCents)}/month each</p>
        </div>
        <div>
          <label htmlFor="extraClipHours" className={label}>
            Extra clipping hours per month
          </label>
          <input
            id="extraClipHours"
            name="extraClipHours"
            type="number"
            min={0}
            max={ADD_ONS.extra_clip_hour.maxQuantity}
            value={extraClipHours}
            onChange={(e) => setExtraClipHours(clamp(e.target.value, ADD_ONS.extra_clip_hour.maxQuantity))}
            className={cx(input, 'mt-1')}
          />
          <p className={hint}>{formatCents(ADD_ONS.extra_clip_hour.priceCents)}/month each</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-neutral-50 px-4 py-3 dark:bg-neutral-950">
        <p className="text-sm">
          Total: <span className="text-lg font-semibold" aria-live="polite">{formatCents(total)}</span>/month
        </p>
        <button type="submit" className={button.primary}>
          Continue to checkout
        </button>
      </div>
    </form>
  )
}
