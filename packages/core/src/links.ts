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

// ---------------------------------------------------------------------------
// Finished-media imports (upload_media sourceUrl): any public https host except video sites
// ---------------------------------------------------------------------------

export type ImportUrlRefusal = SourceUrlRefusal | 'private_host'

export type ImportUrlCheck = { ok: true; host: string; url: string } | { ok: false; reason: ImportUrlRefusal; message: string }

const SEND_FILE_HINT = 'Send the file itself with upload_media instead (a PUT of the file you made).'

export const IMPORT_URL_MESSAGES: Readonly<Record<ImportUrlRefusal, string>> = {
  invalid_url: `That is not a valid link. ${SEND_FILE_HINT}`,
  not_https: `Only https:// links are supported. ${SEND_FILE_HINT}`,
  has_credentials: `Links with a user name or password are not supported. ${SEND_FILE_HINT}`,
  has_port: `Links with a port number are not supported. ${SEND_FILE_HINT}`,
  ip_literal: `Links to an IP address are not supported; use the file's https link with a host name. ${SEND_FILE_HINT}`,
  video_site_forbidden:
    'Links to YouTube, TikTok, Instagram, Facebook, X, Vimeo, Twitch and other video sites are not accepted: we only post videos you made, never someone else\'s. ' +
    SEND_FILE_HINT,
  host_not_allowed: `That host is not supported. ${SEND_FILE_HINT}`,
  private_host: `Links to private or local hosts are not supported. ${SEND_FILE_HINT}`,
}

/** Host names that never resolve to the public internet (or are reserved for docs and tests). */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'localdomain', 'invalid', 'test', 'example', 'onion', 'arpa']

function isPrivateHostName(host: string): boolean {
  if (!host.includes('.')) return true // single-label names resolve inside the network
  return PRIVATE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
}

/**
 * Checks a link to a finished video or image an AI made (upload_media sourceUrl). Accepts https
 * links to public host names; refuses video and social sites (users may only post their own
 * videos), IP literals, local/private names, ports and credentials. The worker re-checks every
 * redirect hop and only connects to public IP addresses (isPublicIp).
 */
export function checkImportUrl(input: string): ImportUrlCheck {
  const parsed = parseHttpsUrl(input)
  const refuse = (reason: ImportUrlRefusal): ImportUrlCheck => ({ ok: false, reason, message: IMPORT_URL_MESSAGES[reason] })
  if ('refusal' in parsed) return refuse(parsed.refusal)
  const { url } = parsed
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.length > 253) return refuse('invalid_url')
  if (isVideoSiteHost(host)) return refuse('video_site_forbidden')
  if (isPrivateHostName(host)) return refuse('private_host')
  url.hostname = host
  url.hash = ''
  return { ok: true, host, url: url.toString() }
}

function parseIpv4(s: string): number[] | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/** 16 bytes of an IPv6 address (with :: and an embedded IPv4 tail), or null. */
function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null
  let tail: number[] = []
  const lastColon = s.lastIndexOf(':')
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(s.slice(lastColon + 1))
    if (!v4) return null
    tail = v4
    s = `${s.slice(0, lastColon + 1)}0:0`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (h: string) => (h === '' ? [] : h.split(':'))
  const head = groups(halves[0] ?? '')
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  const bytes: number[] = []
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const n = parseInt(g, 16)
    bytes.push(n >> 8, n & 0xff)
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

function inV4(ip: number[], base: [number, number, number, number], bits: number): boolean {
  let left = bits
  for (let i = 0; i < 4 && left > 0; i++) {
    const take = Math.min(8, left)
    const mask = (0xff << (8 - take)) & 0xff
    if (((ip[i] ?? 0) & mask) !== ((base[i] ?? 0) & mask)) return false
    left -= take
  }
  return true
}

const V4_BLOCKED: ReadonlyArray<[[number, number, number, number], number]> = [
  [[0, 0, 0, 0], 8], // "this" network
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (cloud metadata lives here)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
]

function isPublicV4(ip: number[]): boolean {
  return !V4_BLOCKED.some(([base, bits]) => inV4(ip, base, bits))
}

/**
 * Whether an IP address (v4 or v6 text) is a public unicast address the worker may connect to.
 * Private, loopback, link-local, CGNAT, multicast, documentation and reserved ranges are refused,
 * and so are IPv4-mapped / NAT64 / 6to4 / Teredo forms of them. Anything unparseable is refused.
 */
export function isPublicIp(address: string): boolean {
  const v4 = parseIpv4(address.trim())
  if (v4) return isPublicV4(v4)
  const b = parseIpv6(address.trim())
  if (!b) return false
  const word = (i: number) => ((b[i * 2] ?? 0) << 8) | (b[i * 2 + 1] ?? 0)
  const embedded = [b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0]
  const firstSix = [0, 1, 2, 3, 4, 5].map(word)
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated)
  if (firstSix.slice(0, 5).every((w) => w === 0) && (firstSix[5] === 0xffff || firstSix[5] === 0)) {
    if (firstSix[5] === 0 && word(6) === 0 && word(7) <= 1) return false // :: and ::1
    return isPublicV4(embedded)
  }
  // 64:ff9b::/96 (NAT64) carries an IPv4 address
  if (word(0) === 0x64 && word(1) === 0xff9b && [2, 3, 4, 5].every((i) => word(i) === 0)) return isPublicV4(embedded)
  // 2002::/16 (6to4) carries an IPv4 address in bits 16–47
  if (word(0) === 0x2002) return isPublicV4([b[2] ?? 0, b[3] ?? 0, b[4] ?? 0, b[5] ?? 0])
  const first = b[0] ?? 0
  if ((first & 0xe0) !== 0x20) return false // only global unicast 2000::/3
  if (word(0) === 0x2001 && word(1) === 0) return false // Teredo 2001::/32
  if (word(0) === 0x2001 && word(1) === 0x0db8) return false // documentation
  if (word(0) === 0x2001 && (word(1) & 0xfff0) === 0x0010) return false // ORCHID
  if (word(0) === 0x3fff && (word(1) & 0xf000) === 0) return false // documentation 3fff::/20
  return true
}
