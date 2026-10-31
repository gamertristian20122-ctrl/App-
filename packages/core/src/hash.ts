// Stable content hashing: the same JSON value always gives the same hash, whatever the key order.

import { sha256Hex } from './crypto'

/**
 * JSON.stringify with object keys sorted (by UTF-16 code unit order) at every depth.
 * Follows JSON semantics otherwise: undefined/functions/symbols are dropped from objects and
 * become null in arrays, toJSON() is honoured (Dates become ISO strings), non-finite numbers
 * become null. Throws TypeError for bigint, Map, Set and cycles (ambiguous for hashing).
 */
export function stableStringify(value: unknown): string {
  const out = encode(value, new Set())
  return out === undefined ? 'null' : out
}

function encode(value: unknown, stack: Set<object>): string | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: () => unknown }).toJSON()
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      throw new TypeError('stableStringify: bigint is not supported')
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  if (value === null) return 'null'
  const obj = value as object
  if (obj instanceof Map || obj instanceof Set) throw new TypeError('stableStringify: Map/Set are not supported')
  if (stack.has(obj)) throw new TypeError('stableStringify: circular structure')
  stack.add(obj)
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((v) => encode(v, stack) ?? 'null').join(',')}]`
    }
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const k of keys) {
      const v = encode((obj as Record<string, unknown>)[k], stack)
      if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`)
    }
    return `{${parts.join(',')}}`
  } finally {
    stack.delete(obj)
  }
}

/** SHA-256 (hex) of stableStringify(value). */
export function contentHash(value: unknown): string {
  return sha256Hex(stableStringify(value))
}
