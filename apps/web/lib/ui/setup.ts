// The owner's /setup checklist: what each check reports and which one-tap fixes exist. Data only
// (built server-side by lib/server/setup, rendered by components/setup). Never holds secret values.
// Browser-safe.

export type CheckStatus = 'ok' | 'attention' | 'unset'

export const STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  ok: 'OK',
  attention: 'Needs attention',
  unset: 'Not set',
}

export const SETUP_ACTIONS = ['fix_storage_cors', 'create_stripe_catalog', 'create_stripe_webhook', 'setup_billing_portal'] as const
export type SetupActionId = (typeof SETUP_ACTIONS)[number]

export function isSetupAction(value: unknown): value is SetupActionId {
  return typeof value === 'string' && (SETUP_ACTIONS as readonly string[]).includes(value)
}

export interface SetupCheck {
  id: string
  title: string
  status: CheckStatus
  /** One line: what we found. */
  summary: string
  /** One line: how to fix it, with where to tap. */
  fix?: string
  /** Extra lines (findings, reminders, steps). */
  details?: string[]
  /** A one-tap fix on this page. */
  action?: { id: SetupActionId; label: string; note?: string }
  /** Values to copy (never secrets): the MCP URL, a CORS policy, a command. */
  copies?: Array<{ label: string; value: string }>
  links?: Array<{ href: string; label: string }>
}

export interface SetupGroup {
  id: string
  title: string
  checks: SetupCheck[]
}

export interface SetupReport {
  generatedAt: string
  /** POSTING_PROVIDER=fake: nothing is really published. */
  testMode: boolean
  appEnv: string
  groups: SetupGroup[]
  counts: Record<CheckStatus, number>
}

export function countStatuses(groups: readonly SetupGroup[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, attention: 0, unset: 0 }
  for (const g of groups) for (const c of g.checks) counts[c.status] += 1
  return counts
}

/** "12 seconds ago", "3 minutes ago", "2 hours ago", "4 days ago". */
export function agoText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
  if (s < 90) return unit(s, 'second')
  if (s < 90 * 60) return unit(Math.round(s / 60), 'minute')
  if (s < 36 * 3600) return unit(Math.round(s / 3600), 'hour')
  return unit(Math.round(s / 86_400), 'day')
}
