import { describe, expect, it } from 'vitest'
import {
  APP_UUID_NAMESPACE,
  CryptoError,
  createKeyRing,
  decrypt,
  decryptBytes,
  decryptString,
  encrypt,
  encryptBytes,
  generateKeySpec,
  hmacSha256Hex,
  needsReencrypt,
  parseKeyRing,
  randomToken,
  reencrypt,
  safeEqual,
  sealedKeyVersion,
  sha256Hex,
  uuidV5,
} from '../src/crypto'

const k = (byte: number) => Buffer.alloc(32, byte).toString('base64')

describe('key ring', () => {
  it('parses newest-first versions', () => {
    const ring = parseKeyRing(` v2:${k(2)} , v1:${k(1)} `)
    expect(ring.currentVersion).toBe('v2')
    expect(ring.versions).toEqual(['v2', 'v1'])
    expect(ring.key('v1')).toEqual(Buffer.alloc(32, 1))
    expect(ring.key('v3')).toBeUndefined()
  })

  it('accepts base64url keys', () => {
    const url = Buffer.alloc(32, 0xfb).toString('base64url')
    expect(parseKeyRing(`v1:${url}`).key('v1')).toEqual(Buffer.alloc(32, 0xfb))
  })

  it.each([
    ['', /empty/],
    ['v1', /<version>:<base64 key>/],
    [`:${k(1)}`, /<version>:<base64 key>/],
    [`v 1:${k(1)}`, /versions/],
    [`v1:${k(1)},v1:${k(2)}`, /twice/],
    ['v1:short', /32 bytes/],
    ['v1:not*base64!', /not base64/],
  ])('rejects %j without leaking key material', (spec, message) => {
    let err: unknown
    try {
      parseKeyRing(spec)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CryptoError)
    expect((err as Error).message).toMatch(message)
    expect((err as Error).message).not.toContain(k(1))
  })

  it('generates valid specs', () => {
    const spec = generateKeySpec('v7')
    expect(parseKeyRing(spec).currentVersion).toBe('v7')
    expect(() => generateKeySpec('bad:version')).toThrow(CryptoError)
  })
})

describe('AES-256-GCM', () => {
  const ring = createKeyRing([{ version: 'v1', key: Buffer.alloc(32, 1) }])

  it('round-trips strings and bytes with fresh IVs', () => {
    const a = encrypt(ring, 'refresh-token-123')
    const b = encrypt(ring, 'refresh-token-123')
    expect(a).not.toBe(b)
    expect(a.startsWith('v1:')).toBe(true)
    expect(a).not.toContain('refresh-token-123')
    expect(decryptString(ring, a)).toBe('refresh-token-123')
    const bytes = new Uint8Array([1, 2, 3, 250])
    expect([...decrypt(ring, encrypt(ring, bytes))]).toEqual([1, 2, 3, 250])
  })

  it('binds additional authenticated data', () => {
    const sealed = encrypt(ring, 'secret', 'connected_accounts:a')
    expect(decryptString(ring, sealed, 'connected_accounts:a')).toBe('secret')
    expect(() => decrypt(ring, sealed, 'connected_accounts:b')).toThrow(CryptoError)
    expect(() => decrypt(ring, sealed)).toThrow(CryptoError)
  })

  it('detects tampering', () => {
    const sealed = encrypt(ring, 'secret')
    const parts = sealed.split(':')
    const ct = Buffer.from(parts[2]!, 'base64url')
    ct[0] = ct[0]! ^ 1
    parts[2] = ct.toString('base64url')
    expect(() => decrypt(ring, parts.join(':'))).toThrow('Decryption failed.')
    expect(() => decrypt(ring, 'v1:abc')).toThrow('Malformed ciphertext.')
    expect(() => decrypt(ring, 'v9:a:b:c')).toThrow('No key for version v9.')
  })

  it('binary form for bytea columns', () => {
    const sealed = encryptBytes(ring, 'secret', 'aad')
    expect(sealed[0]).toBe(1)
    expect(decryptBytes(ring, sealed, 'aad').toString()).toBe('secret')
    expect(sealedKeyVersion(sealed)).toBe('v1')
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1
    expect(() => decryptBytes(ring, tampered, 'aad')).toThrow(CryptoError)
    expect(() => decryptBytes(ring, new Uint8Array([2, 0]))).toThrow('Malformed ciphertext.')
    expect(() => decryptBytes(ring, new Uint8Array([1, 2, 118, 49]))).toThrow('Malformed ciphertext.')
  })

  it('rotates: old keys still decrypt, re-encryption uses the newest', () => {
    const old = encrypt(ring, 'secret', 'x')
    const oldBytes = encryptBytes(ring, 'secret', 'x')
    const rotated = createKeyRing([
      { version: 'v2', key: Buffer.alloc(32, 2) },
      { version: 'v1', key: Buffer.alloc(32, 1) },
    ])
    expect(needsReencrypt(rotated, old)).toBe(true)
    expect(decryptString(rotated, old, 'x')).toBe('secret')
    const fresh = reencrypt(rotated, old, 'x')
    expect(sealedKeyVersion(fresh)).toBe('v2')
    expect(needsReencrypt(rotated, fresh)).toBe(false)
    expect(decryptString(rotated, fresh, 'x')).toBe('secret')
    const freshBytes = reencrypt(rotated, oldBytes, 'x')
    expect(sealedKeyVersion(freshBytes)).toBe('v2')
    expect(decryptBytes(rotated, freshBytes, 'x').toString()).toBe('secret')
  })
})

describe('hashing and tokens', () => {
  it('sha256Hex and hmac', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
    // RFC 4231 test case 2
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
  })

  it('randomToken is base64url with the requested entropy', () => {
    const t = randomToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(t)
    expect(randomToken(16)).toHaveLength(22)
    expect(() => randomToken(8)).toThrow(RangeError)
  })

  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })

  it('uuidV5 matches RFC 4122 and is deterministic', () => {
    // python: uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
    const a = uuidV5('dev:alice@example.com')
    expect(a).toBe(uuidV5('dev:alice@example.com'))
    expect(a).not.toBe(uuidV5('dev:bob@example.com'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(APP_UUID_NAMESPACE).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => uuidV5('x', 'nope')).toThrow(RangeError)
  })
})
