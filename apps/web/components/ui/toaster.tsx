'use client'

// Toast notifications. Anything can show one with showToast(); the <Toaster /> in the dashboard
// layout renders them in a polite live region (errors in an assertive one) and dismisses them
// after a few seconds. No dependency, no portal.

import { useEffect, useState } from 'react'

export interface ToastInput {
  tone: 'success' | 'error' | 'info'
  message: string
  issues?: string[]
}

interface Toast extends ToastInput {
  id: number
}

const EVENT = 'app:toast'
let counter = 0

export function showToast(toast: ToastInput): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ToastInput>(EVENT, { detail: toast }))
}

const TONES: Record<Toast['tone'], string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-50',
  error: 'border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-50',
  info: 'border-neutral-300 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50',
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastInput>).detail
      if (!detail || typeof detail.message !== 'string' || detail.message === '') return
      counter += 1
      const toast: Toast = { ...detail, id: counter }
      setToasts((list) => [...list.slice(-3), toast])
      window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== toast.id)), detail.tone === 'error' ? 9000 : 5000)
    }
    window.addEventListener(EVENT, onToast)
    return () => window.removeEventListener(EVENT, onToast)
  }, [])

  const dismiss = (id: number) => setToasts((list) => list.filter((t) => t.id !== id))
  const polite = toasts.filter((t) => t.tone !== 'error')
  const assertive = toasts.filter((t) => t.tone === 'error')

  const render = (t: Toast) => (
    <div key={t.id} className={`pointer-events-auto w-full max-w-sm rounded-lg border p-3 text-sm shadow-lg ${TONES[t.tone]}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <p className="font-medium">{t.message}</p>
          {t.issues && t.issues.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {t.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <button type="button" onClick={() => dismiss(t.id)} className="rounded px-1 text-lg leading-none opacity-70 hover:opacity-100" aria-label="Dismiss notification">
          ×
        </button>
      </div>
    </div>
  )

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end">
      <div role="status" aria-live="polite" className="flex w-full flex-col items-center gap-2 sm:items-end">
        {polite.map(render)}
      </div>
      <div role="alert" aria-live="assertive" className="flex w-full flex-col items-center gap-2 sm:items-end">
        {assertive.map(render)}
      </div>
    </div>
  )
}
