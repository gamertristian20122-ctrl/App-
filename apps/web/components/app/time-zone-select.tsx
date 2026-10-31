'use client'

import { useEffect, useState } from 'react'
import { cx, input } from '@/components/ui/styles'

/** A time-zone <select> that starts on the browser's zone (server render: UTC). */
export function TimeZoneSelect({ id, options, disabled }: { id: string; options: string[]; disabled?: boolean }) {
  const [value, setValue] = useState('UTC')
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz && options.includes(tz)) setValue(tz)
    } catch {
      // keep UTC
    }
  }, [options])
  return (
    <select id={id} name="timezone" value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled} className={cx(input, 'mt-1')}>
      {options.map((z) => (
        <option key={z} value={z}>
          {z.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  )
}
