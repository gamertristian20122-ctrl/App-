'use client'

// A <form> bound to a server action through useActionState: shows the result as a toast and
// (optionally) inline, can ask for confirmation first, and can reset itself after success.
// The toast is raised when the action resolves, not from an effect: a successful action often
// re-renders the page without this form (an approved draft leaves the queue), and the Toaster
// lives in the layout, so the message still shows.

import { useActionState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import { IDLE, type ActionResult } from '@/lib/ui/action-result'
import { button, cx } from './styles'
import { showToast } from './toaster'

export type FormAction = (prev: ActionResult, formData: FormData) => Promise<ActionResult>

export function ActionForm({
  action,
  children,
  className,
  confirm,
  resetOnSuccess = false,
  inline = false,
  toast = true,
  'aria-label': ariaLabel,
}: {
  action: FormAction
  children: ReactNode
  className?: string
  /** Asks window.confirm(confirm) before submitting. */
  confirm?: string
  resetOnSuccess?: boolean
  /** Also show the result under the form. */
  inline?: boolean
  toast?: boolean
  'aria-label'?: string
}) {
  const run = useCallback(
    async (prev: ActionResult, formData: FormData): Promise<ActionResult> => {
      const result = await action(prev, formData)
      if (toast && result.message) {
        showToast({ tone: result.ok ? 'success' : 'error', message: result.message, ...(result.issues ? { issues: result.issues } : {}) })
      }
      return result
    },
    [action, toast],
  )
  const [state, formAction] = useActionState(run, IDLE)
  const formRef = useRef<HTMLFormElement>(null)
  const seen = useRef(0)

  useEffect(() => {
    if (state.at === 0 || state.at === seen.current) return
    seen.current = state.at
    if (state.ok && resetOnSuccess) formRef.current?.reset()
  }, [state, resetOnSuccess])

  return (
    <form
      ref={formRef}
      action={formAction}
      className={className}
      aria-label={ariaLabel}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault()
      }}
    >
      {children}
      {inline && state.at !== 0 && state.message ? (
        <div role={state.ok ? 'status' : 'alert'} className={cx('mt-2 text-sm', state.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
          <p>{state.message}</p>
          {state.issues && state.issues.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {state.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}

/** A submit button that disables itself and shows `pendingLabel` while its form is submitting. */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
  className,
  disabled,
  name,
  value,
  title,
}: {
  children: ReactNode
  pendingLabel?: string
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  className?: string
  disabled?: boolean
  name?: string
  value?: string
  title?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      name={name}
      value={value}
      title={title}
      disabled={disabled || pending}
      aria-disabled={disabled || pending}
      className={cx(button[variant], className)}
    >
      {pending ? (pendingLabel ?? 'Working…') : children}
    </button>
  )
}
