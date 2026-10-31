// What the legal pages (/privacy, /terms, /contact) fill in from the configuration: who provides
// the service, the support address, the governing law and the effective date. A missing value
// shows an obvious "[set NAME]" placeholder (and /setup flags it). Browser-safe.

export const LEGAL_KEYS = ['LEGAL_ENTITY_NAME', 'SUPPORT_EMAIL', 'LEGAL_JURISDICTION', 'LEGAL_EFFECTIVE_DATE'] as const
export type LegalKey = (typeof LEGAL_KEYS)[number]

export interface LegalInfo {
  /** The person or company providing the service, or its placeholder. */
  entityName: string
  supportEmail: string
  /** True when supportEmail is a real address (rendered as a mailto link). */
  hasSupportEmail: boolean
  jurisdiction: string
  /** "October 31, 2026", the raw value when it is not a date, or the placeholder. */
  effectiveDate: string
  /** Public base URL of the app (no trailing slash). */
  appUrl: string
  /** Keys still showing a placeholder. */
  missing: LegalKey[]
}

export const placeholder = (key: LegalKey): string => `[set ${key}]`

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** "2026-10-31" → "October 31, 2026"; anything else unchanged. */
export function formatEffectiveDate(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const date = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return raw
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date)
}

export function legalInfo(values: Partial<Record<LegalKey | 'APP_URL', string | undefined>>): LegalInfo {
  const missing: LegalKey[] = []
  const get = (key: LegalKey): string => {
    const v = values[key]?.trim()
    if (v) return v
    missing.push(key)
    return placeholder(key)
  }
  const entityName = get('LEGAL_ENTITY_NAME')
  const supportEmail = get('SUPPORT_EMAIL')
  const jurisdiction = get('LEGAL_JURISDICTION')
  const date = get('LEGAL_EFFECTIVE_DATE')
  return {
    entityName,
    supportEmail,
    hasSupportEmail: !missing.includes('SUPPORT_EMAIL') && EMAIL_RE.test(supportEmail),
    jurisdiction,
    effectiveDate: missing.includes('LEGAL_EFFECTIVE_DATE') ? date : formatEffectiveDate(date),
    appUrl: (values.APP_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),
    missing,
  }
}
