// Links: URL detection in post text (X counting and metering) and the source-link policy
// (users may only clip their own content: cloud-drive links are allowed, YouTube and other
// video sites are always refused).

import { CC_TLDS, GENERIC_TLDS } from './tlds'

// ---------------------------------------------------------------------------
// URL detection in post text
// ---------------------------------------------------------------------------

export interface UrlMatch {
  url: string
  /** UTF-16 index of the first character. */
  start: number
  /** UTF-16 index just past the last character. */
  end: number
}

// Characters that may not precede a URL (twitter-text: no ASCII letter/digit, @, $, # or bidi marks).
const INVALID_PRECEDING = /[A-Za-z0-9@＠$#＃\u202A-\u202E]/
// Extra characters that may not precede a URL written without a scheme.
const INVALID_PRECEDING_NO_SCHEME = /[-_./]/
const TRAILING_PUNCTUATION = new Set(Array.from('.,;:!?\'"’”)]}>…'))
// A run of characters that can contain URLs, stopping at whitespace and quotes.
const CANDIDATE_RE = /[^\s<>"'`\u200B-\u200D\u2028\u2029\uFEFF]+/gu
const SCHEME_RE = /^https?:\/\//i
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST_RE = new RegExp(
  `^(https?:\\/\\/)?(?:((?:${HOST_LABEL}\\.)+([a-z]{2,63}))|(localhost|\\d{1,3}(?:\\.\\d{1,3}){3}))(:\\d{1,5})?`,
  'i',
)

function isKnownTld(tld: string): boolean {
  const t = tld.toLowerCase()
  return CC_TLDS.has(t) || GENERIC_TLDS.has(t)
}

function count(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n += 1
  return n
}

/** Trims trailing punctuation, keeping closing parens that balance one inside the URL. Linear time. */
function trimTrailing(candidate: string): string {
  let end = candidate.length
  let opens = -1
  let closes = -1
  while (end > 0) {
    const ch = candidate[end - 1] as string
    if (!TRAILING_PUNCTUATION.has(ch)) break
    if (ch === ')') {
      if (opens < 0) {
        const head = candidate.slice(0, end)
        opens = count(head, '(')
        closes = count(head, ')')
      }
      // keep this ")" when it closes a "(" inside the URL, e.g. https://en.wikipedia.org/wiki/Foo_(bar)
      if (opens > closes - 1) break
      closes -= 1
    }
    end -= 1
  }
  return candidate.slice(0, end)
}

/**
 * Finds URLs the way X (twitter-text) does, closely enough for counting and link metering:
 * - anything starting with http:// or https:// followed by a host
 * - bare domains with a known TLD ("example.com", "shop.example.co.uk/path"), not preceded by
 *   an ASCII letter or digit, "@" (emails), "$", "#", "-", "_", "." or "/"
 * - a bare two-label domain under a country-code TLD whose first label has 1–2 characters
 *   (e.g. "t.co") only counts when followed by a path, like twitter-text.
 */
export function extractUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = []
  CANDIDATE_RE.lastIndex = 0
  for (let m = CANDIDATE_RE.exec(text); m !== null; m = CANDIDATE_RE.exec(text)) {
    const token = m[0]
    let offset = 0
    while (offset < token.length) {
      const found = matchUrlAt(text, m.index + offset, token.slice(offset))
      if (found) {
        out.push(found)
        offset = found.end - m.index
      } else {
        offset += 1
      }
    }
  }
  return out
}

function previousChar(text: string, index: number): string {
  if (index <= 0) return ''
  return Array.from(text.slice(Math.max(0, index - 2), index)).pop() ?? ''
}

function matchUrlAt(text: string, start: number, rest: string): UrlMatch | null {
  const prev = previousChar(text, start)
  if (prev && INVALID_PRECEDING.test(prev)) return null
  const m = HOST_RE.exec(rest)
  if (!m) return null
  const scheme = m[1]
  const domain = m[2]
  const tld = (m[3] ?? '').toLowerCase()
  if (!scheme) {
    if (prev && INVALID_PRECEDING_NO_SCHEME.test(prev)) return null
    if (!domain || !isKnownTld(tld)) return null
  }
  const next = rest[m[0].length]
  const raw = next === '/' || next === '?' || next === '#' ? rest : m[0]
  const url = trimTrailing(raw)
  const hasPath = url.length > m[0].length
  if (!scheme && !hasPath && domain) {
    const labels = domain.split('.')
    if (labels.length === 2 && CC_TLDS.has(tld) && (labels[0] ?? '').length <= 2) return null
  }
  return { url, start, end: start + url.length }
}

export function hasLink(text: string): boolean {
  return extractUrls(text).length > 0
}

/** Number of distinct URLs (case-insensitive host, scheme and trailing slash ignored). */
export function countUniqueLinks(text: string): number {
  const keys = new Set(
    extractUrls(text).map((m) =>
      m.url
        .replace(SCHEME_RE, '')
        .replace(/^www\./i, '')
        .replace(/\/$/, '')
        .toLowerCase(),
    ),
  )
  return keys.size
}

// ---------------------------------------------------------------------------
// Source links: own content only
// ---------------------------------------------------------------------------

export const DRIVE_PROVIDERS = ['google_drive', 'dropbox', 'onedrive'] as const
export type DriveProvider = (typeof DRIVE_PROVIDERS)[number]

/** Hosts a user may paste as a clip source (exact host match, case-insensitive). */
export const DRIVE_HOSTS: Readonly<Record<DriveProvider, readonly string[]>> = {
  google_drive: ['drive.google.com', 'docs.google.com'],
  dropbox: ['dropbox.com', 'www.dropbox.com', 'dl.dropboxusercontent.com'],
  onedrive: ['onedrive.live.com', '1drv.ms'],
}

/** Hosts a drive download may redirect to while fetching (worker only). */
export const DRIVE_DOWNLOAD_HOSTS: Readonly<Record<DriveProvider, readonly (string | RegExp)[]>> = {
  google_drive: [
    'drive.google.com',
    'docs.google.com',
    'drive.usercontent.google.com',
    /^doc-[a-z0-9-]+-docs\.googleusercontent\.com$/,
  ],
  dropbox: ['www.dropbox.com', 'dropbox.com', 'dl.dropboxusercontent.com', /^uc[a-z0-9_-]+\.dl\.dropboxusercontent\.com$/],
  onedrive: [
    'onedrive.live.com',
    '1drv.ms',
    'api.onedrive.com',
    /^(?:[a-z0-9-]+\.)+files\.1drv\.com$/,
    /^[a-z0-9-]+(?:-my)?\.sharepoint\.com$/,
  ],
}

export const MAX_REDIRECT_HOPS = 5

/**
 * Video and social sites we never download from (matched as the host or any subdomain).
 * Anything not in DRIVE_HOSTS is refused anyway; this list only picks the clearer message.
 */
export const VIDEO_SITE_HOSTS: readonly string[] = [
  // YouTube and Google video CDNs
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'youtubekids.com',
  'googlevideo.com',
  'ytimg.com',
  // other video / social platforms
  'vimeo.com',
  'vimeocdn.com',
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokv.com',
  'instagram.com',
  'cdninstagram.com',
  'facebook.com',
  'fb.com',
  'fb.watch',
  'fbcdn.net',
  'x.com',
  'twitter.com',
  't.co',
  'twimg.com',
  'twitch.tv',
  'dailymotion.com',
  'dai.ly',
  'rumble.com',
  'kick.com',
  'bilibili.com',
  'b23.tv',
  'vk.com',
  'vkvideo.ru',
  'ok.ru',
  'streamable.com',
  'reddit.com',
  'redd.it',
  'threads.net',
  'threads.com',
  'snapchat.com',
  'pinterest.com',
  'pin.it',
  'bsky.app',
  'linkedin.com',
  'loom.com',
  'wistia.com',
  'wistia.net',
  'vidyard.com',
  'odysee.com',
  'bitchute.com',
  'nicovideo.jp',
  'youku.com',
  'iqiyi.com',
  'douyin.com',
  'kuaishou.com',
  'imdb.com',
  'netflix.com',
  'soundcloud.com',
  'spotify.com',
]

function hostMatches(host: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? host === pattern : pattern.test(host)
}

export function isVideoSiteHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return VIDEO_SITE_HOSTS.some((site) => h === site || h.endsWith(`.${site}`))
}

export type SourceUrlRefusal =
  | 'invalid_url'
  | 'not_https'
  | 'has_credentials'
  | 'has_port'
  | 'ip_literal'
  | 'video_site_forbidden'
  | 'host_not_allowed'

export type SourceUrlCheck =
  | { ok: true; provider: DriveProvider; host: string; url: string }
  | { ok: false; reason: SourceUrlRefusal; message: string }

const OWN_CONTENT_HINT =
  'Upload the original file, or share it from Google Drive, Dropbox or OneDrive and paste that link.'

export const SOURCE_URL_MESSAGES: Readonly<Record<SourceUrlRefusal, string>> = {
  invalid_url: `That is not a valid link. ${OWN_CONTENT_HINT}`,
  not_https: `Only https:// links are supported. ${OWN_CONTENT_HINT}`,
  has_credentials: `Links with a user name or password are not supported. ${OWN_CONTENT_HINT}`,
  has_port: `Links with a port number are not supported. ${OWN_CONTENT_HINT}`,
  ip_literal: `Links to an IP address are not supported. ${OWN_CONTENT_HINT}`,
  video_site_forbidden:
    'We only clip your own videos, so links to YouTube or other video sites are not supported. ' + OWN_CONTENT_HINT,
  host_not_allowed: `Only Google Drive, Dropbox and OneDrive links are supported. ${OWN_CONTENT_HINT}`,
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

function refuse(reason: SourceUrlRefusal): SourceUrlCheck {
  return { ok: false, reason, message: SOURCE_URL_MESSAGES[reason] }
}

function parseHttpsUrl(input: string): { url: URL } | { refusal: SourceUrlRefusal } {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > 2048) return { refusal: 'invalid_url' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { refusal: 'invalid_url' }
  }
  if (url.protocol !== 'https:') {
    // still refuse video sites by name even over http
    if (url.hostname && isVideoSiteHost(url.hostname)) return { refusal: 'video_site_forbidden' }
    return { refusal: 'not_https' }
  }
  if (url.username !== '' || url.password !== '') return { refusal: 'has_credentials' }
  if (url.port !== '') return { refusal: 'has_port' }
  const host = url.hostname.toLowerCase()
  if (host.startsWith('[') || IPV4_RE.test(host)) return { refusal: 'ip_literal' }
  return { url }
}

/**
 * Checks a link a user pasted as a clip source. Accepts only https links on DRIVE_HOSTS;
 * YouTube and other video sites are refused with a clear message.
 */
export function checkSourceUrl(input: string): SourceUrlCheck {
  const parsed = parseHttpsUrl(input)
  if ('refusal' in parsed) return refuse(parsed.refusal)
  const { url } = parsed
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isVideoSiteHost(host)) return refuse('video_site_forbidden')
  for (const provider of DRIVE_PROVIDERS) {
    if (DRIVE_HOSTS[provider].some((h) => h === host)) {
      url.hostname = host
      return { ok: true, provider, host, url: url.toString() }
    }
  }
  return refuse('host_not_allowed')
}

/** Whether a fetcher may follow a redirect to `input` while downloading from `provider`. */
export function isAllowedDownloadHop(
  provider: DriveProvider,
  input: string,
): { ok: true } | { ok: false; reason: SourceUrlRefusal } {
  const parsed = parseHttpsUrl(input)
  if ('refusal' in parsed) return { ok: false, reason: parsed.refusal }
  const host = parsed.url.hostname.toLowerCase().replace(/\.$/, '')
  if (isVideoSiteHost(host)) return { ok: false, reason: 'video_site_forbidden' }
  return DRIVE_DOWNLOAD_HOSTS[provider].some((p) => hostMatches(host, p))
    ? { ok: true }
    : { ok: false, reason: 'host_not_allowed' }
}

/**
 * A URL safe to log: query and fragment dropped; for drive hosts the path too (share
 * capabilities live in the path). Unparseable input becomes "[invalid url]".
 */
export function redactUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return '[invalid url]'
  }
  const host = url.hostname.toLowerCase()
  const isDrive = DRIVE_PROVIDERS.some(
    (p) => DRIVE_HOSTS[p].includes(host) || DRIVE_DOWNLOAD_HOSTS[p].some((h) => hostMatches(host, h)),
  )
  const origin = `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`
  if (isDrive) return `${origin}/[redacted]`
  const suffix = url.search || url.hash ? '?[redacted]' : ''
  return `${origin}${url.pathname}${suffix}`
}
