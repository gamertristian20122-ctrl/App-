'use client'

// Small interactive form fields: a date-time picker that submits the browser's time zone, a live
// character counter using the platform's own counting rules, and a scroll-to helper for deep links.

import { useEffect, useState } from 'react'
import { measureText, type TextUnit } from '@app/core/platforms'
import { cx, input } from '@/components/ui/styles'
import { toLocalInputValue } from '@/lib/ui/time'

/**
 * <input type="datetime-local" name="when"> plus a hidden `tz`. Server-rendered with the brand's
 * time zone; once hydrated it switches to the browser's zone (what the person sees on their clock).
 */
export function DateTimeField({
  id,
  label,
  defaultIso,
  serverTimeZone,
  required = true,
}: {
  id: string
  label: string
  defaultIso: string
  serverTimeZone: string
  required?: boolean
}) {
  const [tz, setTz] = useState(serverTimeZone)
  const [value, setValue] = useState(() => toLocalInputValue(new Date(defaultIso), serverTimeZone))
  useEffect(() => {
    try {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (browserTz && browserTz !== serverTimeZone) {
        setTz(browserTz)
        setValue(toLocalInputValue(new Date(defaultIso), browserTz))
      }
    } catch {
      // keep the server zone
    }
  }, [defaultIso, serverTimeZone])
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </label>
      <input
        id={id}
        name="when"
        type="datetime-local"
        required={required}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={cx(input, 'mt-1')}
        aria-describedby={`${id}-tz`}
      />
      <input type="hidden" name="tz" value={tz} />
      <p id={`${id}-tz`} className="mt-1 text-xs text-neutral-500">
        Time zone: {tz.replace(/_/g, ' ')}
      </p>
    </div>
  )
}

/** A textarea with a live length counter in the platform's unit. */
export function CountedTextarea({
  id,
  name,
  defaultValue,
  unit,
  max,
  rows = 6,
  label,
}: {
  id: string
  name: string
  defaultValue: string
  unit: TextUnit
  max: number
  rows?: number
  label: string
}) {
  const [value, setValue] = useState(defaultValue)
  const used = measureText(value, unit)
  const over = max > 0 && used > max
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={cx(input, 'mt-1 font-normal', over && 'border-red-500 dark:border-red-500')}
        aria-describedby={`${id}-count`}
        aria-invalid={over || undefined}
      />
      <p id={`${id}-count`} aria-live="polite" className={cx('mt-1 text-right text-xs tabular-nums', over ? 'font-semibold text-red-600' : 'text-neutral-500')}>
        {used.toLocaleString('en-US')}
        {max > 0 ? ` / ${max.toLocaleString('en-US')}` : ''}
      </p>
    </div>
  )
}

/** Scrolls the element marked data-focused="true" (the ?draft= deep link) into view once. */
export function ScrollToFocused() {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-focused="true"]')
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    const heading = el.querySelector<HTMLElement>('[data-focus-target]')
    heading?.focus({ preventScroll: true })
  }, [])
  return null
}
