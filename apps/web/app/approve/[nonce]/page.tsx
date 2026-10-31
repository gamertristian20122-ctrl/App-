// One-click web approval (the approveUrl that approve_draft shows to clients without MCP Apps,
// and links from the approvals queue). Requires sign-in; shows every platform's preview and
// approves or rejects through services with { via: 'web' }.

import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import type { PreviewVariant } from '@app/services'
import { getCurrentUser } from '@/lib/auth'
import { loadApproval } from '@/lib/server/approve'
import { authDeps, getRuntime } from '@/lib/server/deps'
import { decideFromWeb } from './actions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Review a draft',
  robots: { index: false, follow: false },
  // The URL carries a one-time token: never leak it to media hosts.
  referrer: 'no-referrer',
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-2xl px-6 py-10">{children}</main>
}

function Notice({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: ReactNode }) {
  const styles = {
    ok: 'bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100',
    warn: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
    error: 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100',
  }[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg p-4 text-sm ${styles}`}>
      {children}
    </div>
  )
}

function VariantCard({ v }: { v: PreviewVariant }) {
  const over = v.length.used > v.length.max
  const problems = v.issues.filter((i) => i.severity === 'error')
  return (
    <section className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">{v.label}</h3>
        <span className="text-xs text-neutral-500">
          {v.account ? `@${v.account.handle ?? v.account.displayName ?? 'account'}` : 'No connected account'}
        </span>
      </header>
      {v.title ? <p className="mt-2 font-medium">{v.title}</p> : null}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{v.text}</p>
      {v.media.length > 0 ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {v.media.map((m) =>
            m.url === null ? (
              <div key={m.id} className="flex aspect-square items-center justify-center rounded bg-neutral-100 text-xs text-neutral-500 dark:bg-neutral-900">
                Processing
              </div>
            ) : m.kind === 'video' ? (
              <video key={m.id} src={m.url} controls preload="metadata" className="aspect-square w-full rounded bg-black object-contain" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={m.id} src={m.url} alt="" referrerPolicy="no-referrer" className="aspect-square w-full rounded object-cover" />
            ),
          )}
        </div>
      ) : null}
      <p className={`mt-3 text-xs ${over ? 'text-red-600' : 'text-neutral-500'}`}>
        {v.length.used} / {v.length.max} {v.length.unit}
      </p>
      {problems.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-xs text-red-700 dark:text-red-300">
          {problems.map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export default async function ApprovePage({
  params,
  searchParams,
}: {
  params: Promise<{ nonce: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { nonce } = await params
  const sp = await searchParams
  const page = `/approve/${encodeURIComponent(nonce)}`
  const user = await getCurrentUser(authDeps())
  if (!user) redirect(`/login?next=${encodeURIComponent(page)}`)
  const { services } = await getRuntime()
  const state = await loadApproval(services, user.id, nonce)
  const result = typeof sp.result === 'string' ? sp.result : null

  if (state.kind === 'invalid') {
    const done = state.reason === 'used' && (result === 'approved' || result === 'rejected')
    return (
      <Shell>
        <h1 className="mb-4 text-xl font-semibold">{done ? (result === 'approved' ? 'Approved' : 'Rejected') : 'Review a draft'}</h1>
        {done ? (
          <Notice tone="ok">
            {result === 'approved'
              ? 'The draft is approved. Ask your AI to schedule it, or schedule it from the calendar.'
              : 'The draft was rejected. Nothing will be published.'}
          </Notice>
        ) : (
          <Notice tone="warn">{state.message}</Notice>
        )}
        <p className="mt-6 text-sm">
          <Link href="/app/approvals" className="underline">
            Go to your approvals queue
          </Link>
        </p>
      </Shell>
    )
  }

  const { preview } = state
  return (
    <Shell>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{preview.brand.name}</p>
      <h1 className="mt-1 text-xl font-semibold">Review this draft</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Nothing is published until you approve. Approving does not schedule it yet.
      </p>

      <div className="mt-4 space-y-3">
        {result === 'failed' ? (
          <Notice tone="error">This draft cannot be approved yet. Fix the problems below in the web app, then approve.</Notice>
        ) : null}
        {preview.problems.length > 0 ? (
          <Notice tone="warn">
            <ul className="list-disc pl-5">
              {preview.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
      </div>

      <div className="mt-6 space-y-4">
        {preview.variants.map((v) => (
          <VariantCard key={v.platform} v={v} />
        ))}
      </div>

      <form action={decideFromWeb} className="mt-8 space-y-3">
        <input type="hidden" name="nonce" value={nonce} />
        <label className="block text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">Reason (optional, for Reject)</span>
          <textarea
            name="reason"
            maxLength={500}
            rows={2}
            className="mt-1 w-full rounded-lg border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700"
          />
        </label>
        <div className="flex gap-3">
          <button
            type="submit"
            name="decision"
            value="approve"
            disabled={!preview.ready}
            className="flex-1 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            Approve
          </button>
          <button
            type="submit"
            name="decision"
            value="reject"
            className="flex-1 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Reject
          </button>
        </div>
      </form>
    </Shell>
  )
}
