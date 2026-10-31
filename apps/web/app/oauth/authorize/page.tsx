// OAuth consent screen for MCP clients (Claude, ChatGPT, Cursor, ...). Requires a signed-in
// user; shows the client's name, what it may do and where the browser goes next.

import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { LegalLinks } from '@/components/legal/legal-links'
import { getCurrentUser } from '@/lib/auth'
import { authDeps, getRuntime } from '@/lib/server/deps'
import { AUTHORIZE_PARAMS, describeScopes, loadConsent } from '@/lib/server/oauth'
import { decideAuthorization } from './actions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Connect an AI app',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

type SearchParams = Record<string, string | string[] | undefined>

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-2xl border border-neutral-200 p-6 shadow-sm dark:border-neutral-800">{children}</div>
      <LegalLinks className="mt-6 justify-center text-xs text-neutral-500" />
    </main>
  )
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const { services } = await getRuntime()
  const user = await getCurrentUser(authDeps())
  const state = await loadConsent(services, user, sp)

  if (state.kind === 'login') redirect(state.url)
  if (state.kind === 'error') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">This connection request cannot be completed</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{state.message}</p>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">Go back to your AI app and try connecting again.</p>
        {state.returnTo ? (
          <p className="mt-4 text-sm">
            <a href={state.returnTo.url} rel="noreferrer" className="text-indigo-700 underline dark:text-indigo-300">
              Return to <span className="break-all font-mono">{state.returnTo.host}</span>
            </a>
          </p>
        ) : null}
      </Shell>
    )
  }

  const { request, params, user: signedIn, loopback } = state
  const appName = request.client.name?.trim() || 'An unnamed app'
  const failed = sp.notice === 'failed'

  return (
    <Shell>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Connect an AI app</p>
      <h1 className="mt-1 text-xl font-semibold">
        <span className="break-words">{appName}</span> wants to use your account
      </h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Signed in as {signedIn.email}</p>

      {failed ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          That did not work. Please try again.
        </p>
      ) : null}

      <h2 className="mt-6 text-sm font-semibold">It will be able to</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
        {describeScopes(request.scope).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <h2 className="mt-6 text-sm font-semibold">After you decide, you go back to</h2>
      <p className="mt-1 break-all font-mono text-sm">{request.redirectHost}</p>
      {loopback ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          This app runs on your own computer. Only allow it if you just started connecting it yourself.
        </p>
      ) : null}

      <form action={decideAuthorization} className="mt-6 flex gap-3">
        {AUTHORIZE_PARAMS.map((key) =>
          params[key] !== undefined ? <input key={key} type="hidden" name={key} value={params[key]} /> : null,
        )}
        <button
          type="submit"
          name="decision"
          value="approve"
          className="flex-1 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Allow
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="flex-1 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Deny
        </button>
      </form>
      <p className="mt-4 text-xs text-neutral-500">
        Nothing is published without your approval. You can disconnect this app at any time in your account settings.
      </p>
    </Shell>
  )
}
