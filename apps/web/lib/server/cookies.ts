// Set-Cookie serialisation for route handlers that build plain Responses. Server-only.

export interface CookieAttributes {
  path?: string
  maxAge?: number
  expires?: Date
  domain?: string
  sameSite?: boolean | 'lax' | 'strict' | 'none'
  httpOnly?: boolean
  secure?: boolean
}

/** A Set-Cookie value (defaults: Path=/; SameSite=Lax). */
export function serializeCookie(name: string, value: string, options: CookieAttributes = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  const sameSite = options.sameSite === true ? 'strict' : options.sameSite === false || options.sameSite === undefined ? 'lax' : options.sameSite
  parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/** A Set-Cookie value that deletes `name`. */
export function expireCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`
}

/** Cookie names present on a request. */
export function requestCookieNames(req: Request): string[] {
  const header = req.headers.get('cookie') ?? ''
  return header
    .split(';')
    .map((p) => p.split('=')[0]?.trim() ?? '')
    .filter((n) => n.length > 0)
}
