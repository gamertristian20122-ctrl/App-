// What every server action returns to its form (useActionState): a short message for a toast or
// inline notice. Service errors (AppError, recognised structurally: lib/ui/errors.ts) carry
// user-safe messages; anything else becomes a generic message so internals never reach the
// browser. Browser-safe.

import { asAppError } from './errors'

export interface ActionResult {
  ok: boolean
  message: string
  /** Extra detail lines (validation issues, approval problems). */
  issues?: string[]
  /** Changes on every result so the UI can show the same message twice. */
  at: number
}

export const IDLE: ActionResult = { ok: true, message: '', at: 0 }

export const GENERIC_ERROR = 'Something went wrong. Please try again.'

export function success(message: string): ActionResult {
  return { ok: true, message, at: Date.now() }
}

export function failed(message: string, issues?: string[]): ActionResult {
  return { ok: false, message, ...(issues && issues.length > 0 ? { issues } : {}), at: Date.now() }
}

function issueLines(details: Readonly<Record<string, unknown>> | undefined): string[] {
  if (!details) return []
  const out: string[] = []
  const problems = details.problems
  if (Array.isArray(problems)) for (const p of problems) if (typeof p === 'string') out.push(p)
  const issues = details.issues
  if (Array.isArray(issues)) {
    for (const i of issues) {
      if (i && typeof i === 'object' && typeof (i as { message?: unknown }).message === 'string') {
        out.push((i as { message: string }).message)
      }
    }
  }
  return [...new Set(out)].slice(0, 8)
}

/** Maps a thrown error to a result (service messages pass through; anything else is generic). */
export function failure(error: unknown, fallback = GENERIC_ERROR): ActionResult {
  const e = asAppError(error)
  if (e) return failed(e.message, issueLines(e.details))
  return failed(fallback)
}

/** Next.js control-flow errors (redirect / notFound) must be rethrown from server actions. */
export function isNavigationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const digest = (error as { digest?: unknown }).digest
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_HTTP_ERROR_FALLBACK') || digest === 'NEXT_NOT_FOUND')
}
