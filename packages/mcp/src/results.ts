// Tool results: concise text for the model plus structuredContent (JSON-safe: Dates become ISO
// strings, undefined is dropped). `_meta` is UI-only (the approval card) and never echoed in text.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Recursively converts a value to plain JSON (Date → ISO string, undefined dropped, bigint → number). */
export function toJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return null
  if (value === null || value === undefined) return value ?? null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? null : value
  if (Array.isArray(value)) return value.map((v) => toJson(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || typeof v === 'function') continue
    out[k] = toJson(v, depth + 1)
  }
  return out
}

export function asRecord(value: unknown): Record<string, unknown> {
  const json = toJson(value)
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : { value: json }
}

/** A successful tool result. */
export function ok(text: string, structured: Record<string, unknown>, meta?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text }],
    structuredContent: asRecord(structured),
  }
  if (meta) result._meta = meta
  return result
}

/** A tool error (isError: true) the model can read and act on. */
export function fail(text: string, error: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { error: asRecord(error) },
    isError: true,
  }
}

/** "a, b and c" */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Trims long text for a one-line summary. */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
