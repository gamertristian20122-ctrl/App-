// Calendar of scheduled / published posts. ?view=week|month, ?date=YYYY-MM-DD, ?brand=<id>|all,
// ?canceled=1.

import type { Metadata } from 'next'
import { CalendarView } from '@/components/app/calendar'
import { safeTimeZone } from '@/lib/ui/format'
import { loadCalendar } from '@/lib/ui/data'
import { isId } from '@/lib/ui/form'
import { param } from '@/lib/ui/paths'
import { pageContext } from '@/lib/ui/server'
import { dayKey, isDayKey } from '@/lib/ui/time'
import { cancelPostAction, reschedulePostAction } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Calendar' }

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const ctx = await pageContext('/app/calendar')
  const rawBrand = param(sp, 'brand')
  const brand =
    rawBrand === 'all' ? null : isId(rawBrand) ? (ctx.brands.find((b) => b.id === rawBrand.toLowerCase()) ?? ctx.brand) : ctx.brand
  const user = await ctx.services.users.get(ctx.user.id)
  const timezone = safeTimeZone(brand?.timezone ?? user.timezone)
  const view = param(sp, 'view') === 'month' ? 'month' : 'week'
  const rawDate = param(sp, 'date')
  const anchorKey = isDayKey(rawDate) ? rawDate : dayKey(ctx.now, timezone)
  const includeCanceled = param(sp, 'canceled') === '1'
  const data = await loadCalendar(ctx.services, ctx.user.id, { view, anchorKey, brandId: brand?.id ?? null, timezone, includeCanceled, now: ctx.now })
  return (
    <CalendarView
      data={data}
      brands={ctx.brands.map((b) => ({ id: b.id, name: b.name }))}
      brandFilter={brand?.id ?? 'all'}
      includeCanceled={includeCanceled}
      actions={{ reschedule: reschedulePostAction, cancel: cancelPostAction }}
    />
  )
}
