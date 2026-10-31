// Shared layout and small helpers for the legal pages (/privacy, /terms, /contact): a readable
// single column that works on a phone, the configured values (or an obvious "[set NAME]"
// placeholder), and the footer links. Server components, static content.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Logo } from '@/components/ui/logo'
import { button, cx } from '@/components/ui/styles'
import { PRODUCT_NAME } from '@/lib/ui/brand'
import type { LegalInfo, LegalKey } from '@/lib/ui/legal'
import { LegalLinks } from './legal-links'

/** A configured value, or its placeholder highlighted so nobody misses it. */
export function Value({ info, field, text }: { info: LegalInfo; field: LegalKey; text: string }) {
  if (info.missing.includes(field)) {
    return <mark className="rounded bg-amber-200 px-1 font-mono text-[0.9em] text-amber-950">{text}</mark>
  }
  return <>{text}</>
}

export function Entity({ info }: { info: LegalInfo }) {
  return <Value info={info} field="LEGAL_ENTITY_NAME" text={info.entityName} />
}

export function SupportEmail({ info, subject }: { info: LegalInfo; subject?: string }) {
  if (!info.hasSupportEmail) return <Value info={info} field="SUPPORT_EMAIL" text={info.supportEmail} />
  const href = `mailto:${info.supportEmail}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`
  return (
    <a href={href} className="font-medium text-indigo-700 underline dark:text-indigo-300">
      {info.supportEmail}
    </a>
  )
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mt-10 scroll-mt-20 text-xl font-semibold tracking-tight">
      {children}
    </h2>
  )
}

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 leading-relaxed text-neutral-700 dark:text-neutral-300">{children}</p>
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed text-neutral-700 dark:text-neutral-300">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

export function LegalPage({ title, info, intro, children }: { title: string; info: LegalInfo; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Logo />
          <Link href="/login" className={cx(button.secondary, button.small)}>
            Sign in
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-neutral-500" data-testid="effective-date">
          Effective <Value info={info} field="LEGAL_EFFECTIVE_DATE" text={info.effectiveDate} />
        </p>
        {intro ? <div className="mt-6">{intro}</div> : null}
        <div className="pb-6">{children}</div>
      </main>
      <footer className="border-t border-neutral-200 py-8 text-sm text-neutral-500 dark:border-neutral-800">
        <div className="mx-auto flex max-w-3xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
          <p>
            {PRODUCT_NAME} · <Entity info={info} />
          </p>
          <LegalLinks />
        </div>
      </footer>
    </div>
  )
}
