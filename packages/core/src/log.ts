// Structured JSON logger with deep redaction. Never log secrets: values under keys matching
// REDACT_KEY_PATTERN are replaced at any depth, and secret-looking substrings (Bearer/Apikey/Basic
// credentials, JWTs, secret query parameters) are scrubbed from every string, including messages.

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const REDACTED = '[REDACTED]'

/** Keys whose values are always redacted (matched anywhere in the key, case-insensitive). */
export const REDACT_KEY_PATTERN =
  /token|secret|password|passwd|authorization|api[-_]?key|cookie|code_verifier|credential|private[-_]?key|signature|session[-_]?secret/i

type Replacer = string | ((match: string, ...groups: string[]) => string)

/** Prose ("Basic configuration") vs credentials ("dXNlcjpwYXNz", "sk-123"). */
function looksLikeCredential(value: string): boolean {
  const rest = value.slice(1)
  return /[0-9._~+/=-]/.test(value) || (/[a-z]/.test(rest) && /[A-Z]/.test(rest)) || value.length >= 20
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, Replacer]> = [
  // Authorization header values: "Bearer x", "Apikey x", "Basic x"
  [
    /\b(Bearer|Apikey|Api-Key|Basic)(\s+)([A-Za-z0-9._~+/=-]{6,})/gi,
    (match, scheme, space, value) => (looksLikeCredential(value as string) ? `${scheme}${space}${REDACTED}` : match),
  ],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Stripe-style secret keys
  [/\b(?:sk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{8,}/g, REDACTED],
  // secret-ish query / form parameters
  [
    /([?&;](?:access_token|refresh_token|id_token|token|code|code_verifier|client_secret|api_key|apikey|key|secret|signature|sig|password|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&#\s"']+/gi,
    `$1${REDACTED}`,
  ],
  // key=value / key: value pairs in free text
  [
    /\b((?:access_token|refresh_token|client_secret|api[_-]?key|password|secret|token)\s*[=:]\s*)["']?[^\s"',;&]{4,}["']?/gi,
    `$1${REDACTED}`,
  ],
]

/** Removes secret-looking substrings from free text. */
export function scrubString(input: string): string {
  let s = input
  for (const [re, replacement] of SECRET_PATTERNS) {
    s = typeof replacement === 'string' ? s.replace(re, replacement) : s.replace(re, replacement)
  }
  return s
}

const MAX_DEPTH = 10
const MAX_STRING = 10_000
const MAX_ARRAY = 200

function serializeError(err: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: scrubString(err.message) }
  if (err.stack) out.stack = scrubString(err.stack)
  for (const [k, v] of Object.entries(err)) {
    if (k === 'name' || k === 'message' || k === 'stack') continue
    out[k] = REDACT_KEY_PATTERN.test(k) ? REDACTED : redactValue(v, seen, depth + 1)
  }
  if ('cause' in err && err.cause !== undefined) out.cause = redactValue(err.cause, seen, depth + 1)
  return out
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value
  switch (typeof value) {
    case 'string':
      return scrubString(value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value)
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'symbol':
      return value.toString()
    case 'function':
      return undefined
  }
  const obj = value as object
  if (depth >= MAX_DEPTH) return '[Truncated]'
  if (seen.has(obj)) return '[Circular]'
  seen.add(obj)
  try {
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString()
    if (obj instanceof Error) return serializeError(obj, seen, depth)
    if (obj instanceof URL) return scrubString(obj.toString())
    if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`
    if (typeof Headers !== 'undefined' && obj instanceof Headers) {
      const out: Record<string, unknown> = {}
      obj.forEach((v, k) => {
        out[k] = REDACT_KEY_PATTERN.test(k) ? REDACTED : scrubString(v)
      })
      return out
    }
    if (obj instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of obj) {
        const key = String(k)
        out[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED : redactValue(v, seen, depth + 1)
      }
      return out
    }
    if (obj instanceof Set) return redactValue([...obj], seen, depth)
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_ARRAY).map((v) => redactValue(v, seen, depth + 1))
      if (obj.length > MAX_ARRAY) items.push(`…[${obj.length - MAX_ARRAY} more]`)
      return items
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (REDACT_KEY_PATTERN.test(k)) {
        out[k] = v === null || v === undefined ? v : REDACTED
      } else {
        const r = redactValue(v, seen, depth + 1)
        if (r !== undefined) out[k] = r
      }
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

/** Deep copy of `value` with secrets removed. Safe on cycles, Errors, Headers, Maps and binary data. */
export function redact<T = unknown>(value: T): unknown {
  return redactValue(value, new WeakSet(), 0)
}

export type LogFields = Record<string, unknown>

export interface Logger {
  readonly level: LogLevel
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields | Error): void
  /** A logger that adds `bindings` to every line. */
  child(bindings: LogFields): Logger
  isLevelEnabled(level: LogLevel): boolean
}

export type LogSink = (line: string, level: LogLevel) => void

export interface LoggerOptions {
  /** Service name, e.g. "web", "worker", "mcp". */
  name?: string
  level?: LogLevel
  bindings?: LogFields
  /** Where lines go. Default: console (error level → console.error). */
  sink?: LogSink
  now?: () => Date
}

const defaultSink: LogSink = (line, level) => {
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** Creates a JSON-lines logger: {"level","time","name","msg",...bindings,...fields}. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info'
  const sink = options.sink ?? defaultSink
  const now = options.now ?? (() => new Date())
  const bindings = options.bindings ?? {}
  const threshold = LOG_LEVELS.indexOf(level)

  const enabled = (l: LogLevel) => LOG_LEVELS.indexOf(l) >= threshold

  const write = (l: LogLevel, msg: string, fields?: LogFields | Error) => {
    if (!enabled(l)) return
    const extra = fields instanceof Error ? { err: fields } : (fields ?? {})
    const record = redact({ ...bindings, ...extra }) as Record<string, unknown>
    const line: Record<string, unknown> = { level: l, time: now().toISOString() }
    if (options.name) line.name = options.name
    line.msg = scrubString(String(msg))
    for (const [k, v] of Object.entries(record)) if (!(k in line)) line[k] = v
    let text: string
    try {
      text = JSON.stringify(line)
    } catch {
      text = JSON.stringify({ level: l, time: line.time, name: options.name, msg: line.msg, note: 'unserializable fields' })
    }
    sink(text, l)
  }

  return {
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (more) => createLogger({ ...options, bindings: { ...bindings, ...more } }),
    isLevelEnabled: enabled,
  }
}

/** A logger that drops everything (tests, scripts). */
export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} })
