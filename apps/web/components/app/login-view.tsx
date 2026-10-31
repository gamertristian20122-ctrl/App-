// The sign-in screen (plain HTML forms posting to the auth routes; works without JavaScript).

import { Notice } from '@/components/ui/primitives'
import { Logo } from '@/components/ui/logo'
import { button, cx, hint, input, label } from '@/components/ui/styles'
import { PRODUCT_NAME } from '@/lib/ui/brand'

export type LoginError = 'link_invalid' | 'link_expired' | 'not_configured' | 'unavailable'

export const LOGIN_ERROR_MESSAGES: Record<LoginError, string> = {
  link_invalid: 'That sign-in link is not valid. Request a new one below.',
  link_expired: 'That sign-in link has expired. Request a new one below.',
  not_configured: 'Email sign-in is not set up on this server yet.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again in a minute.',
}

export function LoginView({ next, sent, error, devAuth, magicLink }: {
  next: string
  sent: boolean
  error: LoginError | null
  devAuth: boolean
  magicLink: boolean
}) {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <h1 className="text-xl font-semibold">Sign in to {PRODUCT_NAME}</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">New here? Signing in creates your account and starts your free trial.</p>

          <div className="mt-5 space-y-3">
            {sent ? (
              <Notice tone="success" title="Check your email">
                We sent you a sign-in link. Open it on this device to continue. It works once.
              </Notice>
            ) : null}
            {error ? <Notice tone="danger">{LOGIN_ERROR_MESSAGES[error]}</Notice> : null}
          </div>

          {magicLink ? (
            <form method="post" action="/api/auth/magic-link" className="mt-5 space-y-4">
              <input type="hidden" name="next" value={next} />
              <div>
                <label htmlFor="email" className={label}>
                  Email address
                </label>
                <input id="email" name="email" type="email" required autoComplete="email" maxLength={254} className={cx(input, 'mt-1')} />
              </div>
              <button type="submit" className={cx(button.primary, 'w-full')}>
                Email me a sign-in link
              </button>
            </form>
          ) : !devAuth ? (
            <div className="mt-5">
              <Notice tone="warning">Email sign-in is not configured on this server.</Notice>
            </div>
          ) : null}

          {devAuth ? (
            <form method="post" action="/api/auth/dev-login" className="mt-6 space-y-3 border-t border-dashed border-neutral-300 pt-5 dark:border-neutral-700">
              <input type="hidden" name="next" value={next} />
              <div>
                <label htmlFor="dev-email" className={label}>
                  Development sign-in
                </label>
                <p className={hint}>DEV_AUTH is on: any email signs in without a link. Never enabled in production.</p>
                <input id="dev-email" name="email" type="email" required autoComplete="email" maxLength={254} className={cx(input, 'mt-2')} placeholder="you@example.com" />
              </div>
              <button type="submit" className={cx(button.secondary, 'w-full')}>
                Sign in (development)
              </button>
            </form>
          ) : null}
        </div>
        <p className="mt-6 text-center text-xs text-neutral-500">
          By signing in you agree to use {PRODUCT_NAME} only with content you own or have the rights to.
        </p>
      </div>
    </main>
  )
}
