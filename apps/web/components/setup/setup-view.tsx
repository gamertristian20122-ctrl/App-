// The owner's launch checklist (/setup): one card per check with its status, what we found, how to
// fix it (where to tap), copyable values and the one-tap fixes. Built for a phone: one column, big
// buttons. Server component; the buttons and copy buttons are client components.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { LegalFooter } from '@/components/legal/legal-links'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { CopyButton } from '@/components/ui/copy-button'
import { Logo } from '@/components/ui/logo'
import { Badge, Notice } from '@/components/ui/primitives'
import { button, card, cx, link } from '@/components/ui/styles'
import { Toaster } from '@/components/ui/toaster'
import { PRODUCT_NAME } from '@/lib/ui/brand'
import { STATUS_LABELS, type CheckStatus, type SetupActionId, type SetupCheck, type SetupReport } from '@/lib/ui/setup'

const TONE: Record<CheckStatus, 'success' | 'warning' | 'neutral'> = { ok: 'success', attention: 'warning', unset: 'neutral' }
const ICON: Record<CheckStatus, string> = { ok: '✓', attention: '!', unset: '–' }

function StatusBadge({ status }: { status: CheckStatus }) {
  return (
    <Badge tone={TONE[status]} className="shrink-0">
      <span aria-hidden="true">{ICON[status]}</span>
      {STATUS_LABELS[status]}
    </Badge>
  )
}

function SetupShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <Logo href="/app" />
          <Link href="/app" className={cx(button.ghost, button.small)}>
            Dashboard
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        {children}
      </main>
      <LegalFooter />
    </div>
  )
}

function CheckCard({ check, actions }: { check: SetupCheck; actions: Record<SetupActionId, FormAction> }) {
  return (
    <li className={cx(card, 'p-4')} data-check={check.id} data-status={check.status}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium">{check.title}</h3>
        <StatusBadge status={check.status} />
      </div>
      <p className="mt-1.5 break-words text-sm text-neutral-700 dark:text-neutral-300">{check.summary}</p>
      {check.fix ? (
        <p className="mt-2 text-sm">
          <span className="font-semibold">How to fix: </span>
          {check.fix}
        </p>
      ) : null}
      {check.details && check.details.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-neutral-600 dark:text-neutral-400">
          {check.details.map((d) => (
            <li key={d} className="break-words">
              {d}
            </li>
          ))}
        </ul>
      ) : null}
      {check.copies?.map((c) => (
        <div key={c.label} className="mt-3">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-neutral-100 p-2.5 font-mono text-xs dark:bg-neutral-950">{c.value}</pre>
          <CopyButton value={c.value} label={c.label} className="mt-2 w-full py-2.5 text-sm sm:w-auto" />
        </div>
      ))}
      {check.links && check.links.length > 0 ? (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {check.links.map((l) => (
            <Link key={l.href} href={l.href} className={link}>
              {l.label}
            </Link>
          ))}
        </p>
      ) : null}
      {check.action ? (
        <ActionForm action={actions[check.action.id]} inline className="mt-3" aria-label={check.action.label}>
          <SubmitButton pendingLabel="Working…" className="w-full py-3 text-base sm:w-auto sm:py-2 sm:text-sm">
            {check.action.label}
          </SubmitButton>
          {check.action.note ? <p className="mt-1.5 text-xs text-neutral-500">{check.action.note}</p> : null}
        </ActionForm>
      ) : null}
    </li>
  )
}

export function SetupView({ report, actions, ownerEmail }: { report: SetupReport; actions: Record<SetupActionId, FormAction>; ownerEmail: string }) {
  const { counts } = report
  return (
    <SetupShell>
      <h1 className="text-2xl font-semibold tracking-tight">Launch setup</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Everything {PRODUCT_NAME} needs to go live, checked just now. Only you ({ownerEmail}) can see this page. Secret values are never shown.
      </p>
      {report.testMode ? (
        <Notice tone="danger" title="TEST MODE: posts are not really published." className="mt-4">
          POSTING_PROVIDER is fake. Connect Upload-Post (see Posting below) before real customers use it.
        </Notice>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm" data-testid="setup-counts">
        <Badge tone="success">{counts.ok} OK</Badge>
        <Badge tone="warning">{counts.attention} need attention</Badge>
        <Badge tone="neutral">{counts.unset} not set</Badge>
        <Link href="/setup" className={cx(button.secondary, button.small, 'ml-auto')}>
          Check again
        </Link>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        Environment: {report.appEnv}. After you change a variable in Vercel, redeploy, then tap “Check again”. Step-by-step guide: docs/LAUNCH-ON-PHONE.md.
      </p>
      <div className="mt-6 space-y-8">
        {report.groups.map((g) => (
          <section key={g.id} aria-labelledby={`group-${g.id}`}>
            <h2 id={`group-${g.id}`} className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              {g.title}
            </h2>
            <ul className="mt-2 space-y-3">
              {g.checks.map((c) => (
                <CheckCard key={c.id} check={c} actions={actions} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Toaster />
    </SetupShell>
  )
}

/** OWNER_EMAIL is not set: the only thing /setup shows. */
export function SetupLocked() {
  return (
    <SetupShell>
      <h1 className="text-2xl font-semibold tracking-tight">Setup is locked</h1>
      <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
        Only the owner can use this page, and no owner is set yet. In Vercel, open your project → Settings → Environment Variables, add{' '}
        <code className="font-mono">OWNER_EMAIL</code> with the email you sign in with, then Deployments → ⋯ → Redeploy. Sign in with that email and open
        this page again.
      </p>
    </SetupShell>
  )
}
