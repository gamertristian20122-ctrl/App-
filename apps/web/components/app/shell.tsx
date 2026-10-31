'use client'

// Dashboard chrome that needs the browser: the navigation (active link from the URL, mobile
// toggle) and the brand switcher (submits on change; a button keeps it usable without JS).

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useRef, useState } from 'react'
import { button, cx } from '@/components/ui/styles'

export interface NavItem {
  href: string
  label: string
  badge?: string | null
}

export function AppNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? ''
  const [open, setOpen] = useState(false)
  const isActive = (href: string) => (href === '/app' ? pathname === '/app' : pathname === href || pathname.startsWith(`${href}/`))
  return (
    <nav aria-label="Dashboard">
      <button
        type="button"
        className={cx(button.secondary, 'w-full justify-between lg:hidden')}
        aria-expanded={open}
        aria-controls="app-nav-list"
        onClick={() => setOpen((v) => !v)}
      >
        Menu
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <ul id="app-nav-list" className={cx('mt-2 space-y-0.5 lg:mt-0 lg:block', open ? 'block' : 'hidden')}>
        {items.map((item) => {
          const active = isActive(item.href)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className={cx(
                  'flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium',
                  active
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
                    : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                )}
              >
                {item.label}
                {item.badge ? (
                  <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-semibold text-white" aria-label={`${item.badge} waiting`}>
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function BrandSwitcher({
  brands,
  selectedId,
  action,
}: {
  brands: Array<{ id: string; name: string; status: string }>
  selectedId: string | null
  action: (formData: FormData) => Promise<void>
}) {
  const formRef = useRef<HTMLFormElement>(null)
  if (brands.length === 0) {
    return (
      <Link href="/app/brands" className={cx(button.secondary, 'w-full')}>
        Create your first brand
      </Link>
    )
  }
  return (
    <form ref={formRef} action={action} className="flex items-end gap-2">
      <div className="flex-1">
        <label htmlFor="brand-switcher" className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
          Brand
        </label>
        <select
          id="brand-switcher"
          name="brandId"
          defaultValue={selectedId ?? undefined}
          onChange={() => formRef.current?.requestSubmit()}
          className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.status === 'suspended' ? ' (paused)' : ''}
            </option>
          ))}
        </select>
      </div>
      <noscript>
        <button type="submit" className={cx(button.secondary, button.small)}>
          Switch
        </button>
      </noscript>
    </form>
  )
}
