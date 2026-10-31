import { describe, expect, it } from 'vitest'
import { contentHash, stableStringify } from '../src/hash'

describe('stableStringify', () => {
  it('sorts keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
  })

  it('follows JSON semantics', () => {
    expect(stableStringify({ a: undefined, b: () => 1, c: null, d: Number.NaN, e: [undefined, Symbol('s')] })).toBe(
      '{"c":null,"d":null,"e":[null,null]}',
    )
    expect(stableStringify(new Date('2026-01-01T00:00:00Z'))).toBe('"2026-01-01T00:00:00.000Z"')
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify('é"\n')).toBe(JSON.stringify('é"\n'))
    expect(stableStringify({ toJSON: () => ({ b: 1, a: 2 }) })).toBe('{"a":2,"b":1}')
  })

  it('refuses ambiguous values', () => {
    expect(() => stableStringify({ a: 1n })).toThrow(TypeError)
    expect(() => stableStringify(new Map())).toThrow(TypeError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => stableStringify(cyclic)).toThrow(/circular/)
  })

  it('allows repeated (non-cyclic) references', () => {
    const shared = { x: 1 }
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}')
  })
})

describe('contentHash', () => {
  it('ignores key order and changes with content', () => {
    const a = contentHash({ platform: 'x', text: 'hi', mediaIds: ['m1'] })
    const b = contentHash({ mediaIds: ['m1'], text: 'hi', platform: 'x' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(contentHash({ platform: 'x', text: 'hi!', mediaIds: ['m1'] })).not.toBe(a)
    expect(contentHash({ platform: 'x', text: 'hi', mediaIds: ['m2', 'm1'] })).not.toBe(contentHash({ platform: 'x', text: 'hi', mediaIds: ['m1', 'm2'] }))
  })
})
