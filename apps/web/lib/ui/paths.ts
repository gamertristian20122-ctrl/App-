// Safe in-app paths for ?next= parameters and links. Browser-safe.

/** A same-site path ("/app/approvals?draft=…"), or `fallback` for anything else (open-redirect safe). */
export function safeNextPath(raw: unknown, fallback = '/app'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return fallback
  try {
    const base = 'http://next.invalid'
    const url = new URL(raw, base)
    if (url.origin !== base) return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}

/** The first value of a search param. */
export function param(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = sp[key]
  return Array.isArray(v) ? v[0] : v
}

/** Builds "/path?a=1&b=2", dropping empty values. */
export function withQuery(path: string, query: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

/** An http(s) URL from a provider (post permalinks), or null: never render other schemes as links. */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}
