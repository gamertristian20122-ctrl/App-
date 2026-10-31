// Crypto helpers (server-only: uses node:crypto).
// - AES-256-GCM with a versioned key ring (TOKEN_ENCRYPTION_KEYS="v2:base64key,v1:base64key", newest first).
//   New data is always encrypted with the newest key; older keys only decrypt (rotation).
// - Hashing, HMAC, random tokens, constant-time comparison, deterministic UUIDs.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION_RE = /^[A-Za-z0-9_-]{1,32}$/
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/

export class CryptoError extends Error {
  override readonly name = 'CryptoError'
}

export interface KeyRing {
  /** Version used for new encryptions (the first entry). */
  readonly currentVersion: string
  readonly versions: readonly string[]
  /** Returns the key for a version, or undefined. */
  key(version: string): Buffer | undefined
}

function decodeKey(b64: string, version: string): Buffer {
  if (!BASE64_RE.test(b64)) throw new CryptoError(`Key ${version} is not base64.`)
  const key = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (key.length !== KEY_BYTES) throw new CryptoError(`Key ${version} must decode to ${KEY_BYTES} bytes.`)
  return key
}

/**
 * Parses "v2:base64,v1:base64" (newest first). Throws CryptoError with a message that never
 * includes key material.
 */
export function parseKeyRing(spec: string): KeyRing {
  const entries = spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (entries.length === 0) throw new CryptoError('The key ring is empty.')
  const keys = new Map<string, Buffer>()
  for (const entry of entries) {
    const sep = entry.indexOf(':')
    if (sep <= 0) throw new CryptoError('Each key must look like "<version>:<base64 key>".')
    const version = entry.slice(0, sep)
    if (!VERSION_RE.test(version)) throw new CryptoError('Key versions may only use letters, digits, "_" and "-".')
    if (keys.has(version)) throw new CryptoError(`Key version ${version} appears twice.`)
    keys.set(version, decodeKey(entry.slice(sep + 1), version))
  }
  const versions = [...keys.keys()]
  return {
    currentVersion: versions[0] as string,
    versions,
    key: (version) => keys.get(version),
  }
}

/** Builds a key ring from raw keys (newest first). */
export function createKeyRing(entries: ReadonlyArray<{ version: string; key: Uint8Array }>): KeyRing {
  return parseKeyRing(entries.map((e) => `${e.version}:${Buffer.from(e.key).toString('base64')}`).join(','))
}

/** Generates a TOKEN_ENCRYPTION_KEYS entry, e.g. for scripts/generate-secrets.mjs. */
export function generateKeySpec(version = 'v1'): string {
  if (!VERSION_RE.test(version)) throw new CryptoError('Invalid key version.')
  return `${version}:${randomBytes(KEY_BYTES).toString('base64')}`
}

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

const b64url = (b: Buffer): string => b.toString('base64url')

function seal(ring: KeyRing, plaintext: string | Uint8Array, aad?: string) {
  const version = ring.currentVersion
  const key = ring.key(version) as Buffer
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(toBuffer(plaintext)), cipher.final()])
  return { version, iv, ciphertext, tag: cipher.getAuthTag() }
}

function open(ring: KeyRing, version: string, iv: Buffer, ciphertext: Buffer, tag: Buffer, aad?: string): Buffer {
  const key = ring.key(version)
  if (!key) throw new CryptoError(`No key for version ${version}.`)
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CryptoError('Malformed ciphertext.')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new CryptoError('Decryption failed.')
  }
}

/**
 * Encrypts to a printable string "<version>:<iv>:<ciphertext>:<tag>" (base64url parts).
 * `aad` binds the ciphertext to its context (e.g. "connected_accounts:<id>"): decrypt needs the same value.
 */
export function encrypt(ring: KeyRing, plaintext: string | Uint8Array, aad?: string): string {
  const s = seal(ring, plaintext, aad)
  return [s.version, b64url(s.iv), b64url(s.ciphertext), b64url(s.tag)].join(':')
}

function splitSealed(sealed: string): { version: string; iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const parts = sealed.split(':')
  if (parts.length !== 4) throw new CryptoError('Malformed ciphertext.')
  const [version, iv, ciphertext, tag] = parts as [string, string, string, string]
  return {
    version,
    iv: Buffer.from(iv, 'base64url'),
    ciphertext: Buffer.from(ciphertext, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
  }
}

export function decrypt(ring: KeyRing, sealed: string, aad?: string): Buffer {
  const s = splitSealed(sealed)
  return open(ring, s.version, s.iv, s.ciphertext, s.tag, aad)
}

export function decryptString(ring: KeyRing, sealed: string, aad?: string): string {
  return decrypt(ring, sealed, aad).toString('utf8')
}

// Binary form for bytea columns: [0x01][versionLength][version][iv:12][tag:16][ciphertext]
const BYTES_FORMAT = 0x01

export function encryptBytes(ring: KeyRing, plaintext: string | Uint8Array, aad?: string): Buffer {
  const s = seal(ring, plaintext, aad)
  const version = Buffer.from(s.version, 'utf8')
  return Buffer.concat([Buffer.from([BYTES_FORMAT, version.length]), version, s.iv, s.tag, s.ciphertext])
}

function splitBytes(sealed: Uint8Array): { version: string; iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const b = toBuffer(sealed)
  if (b.length < 2 || b[0] !== BYTES_FORMAT) throw new CryptoError('Malformed ciphertext.')
  const vlen = b[1] as number
  const start = 2 + vlen
  if (vlen === 0 || b.length < start + IV_BYTES + TAG_BYTES) throw new CryptoError('Malformed ciphertext.')
  return {
    version: b.subarray(2, start).toString('utf8'),
    iv: b.subarray(start, start + IV_BYTES),
    tag: b.subarray(start + IV_BYTES, start + IV_BYTES + TAG_BYTES),
    ciphertext: b.subarray(start + IV_BYTES + TAG_BYTES),
  }
}

export function decryptBytes(ring: KeyRing, sealed: Uint8Array, aad?: string): Buffer {
  const s = splitBytes(sealed)
  return open(ring, s.version, s.iv, s.ciphertext, s.tag, aad)
}

/** The key version a sealed value (string or bytes form) was encrypted with. */
export function sealedKeyVersion(sealed: string | Uint8Array): string {
  return typeof sealed === 'string' ? splitSealed(sealed).version : splitBytes(sealed).version
}

/** True when the value was encrypted with an older key and should be re-encrypted. */
export function needsReencrypt(ring: KeyRing, sealed: string | Uint8Array): boolean {
  return sealedKeyVersion(sealed) !== ring.currentVersion
}

/** Re-encrypts with the newest key (same form as the input). */
export function reencrypt<T extends string | Uint8Array>(ring: KeyRing, sealed: T, aad?: string): T {
  if (typeof sealed === 'string') return encrypt(ring, decrypt(ring, sealed, aad), aad) as T
  return encryptBytes(ring, decryptBytes(ring, sealed, aad), aad) as unknown as T
}

// Hashing and tokens -------------------------------------------------------

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(toBuffer(data)).digest('hex')
}

export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', toBuffer(key)).update(toBuffer(data)).digest()
}

export function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): string {
  return hmacSha256(key, data).toString('hex')
}

/** Cryptographically random token, base64url (no padding). 32 bytes = 256 bits by default. */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) throw new RangeError('randomToken: 16–1024 bytes')
  return randomBytes(bytes).toString('base64url')
}

/** Constant-time string comparison (different lengths compare unequal without leaking where). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}

/** Namespace for our deterministic ids (UUID v5 namespace, fixed forever). */
export const APP_UUID_NAMESPACE = '6b1f0a4e-3c2d-5e8f-9a7b-1c2d3e4f5a6b'

function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new RangeError('Invalid UUID')
  return Buffer.from(hex, 'hex')
}

/** RFC 4122 UUID v5 (SHA-1, name-based): the same name always gives the same id. */
export function uuidV5(name: string, namespace: string = APP_UUID_NAMESPACE): string {
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest()
  const b = hash.subarray(0, 16)
  b[6] = ((b[6] as number) & 0x0f) | 0x50
  b[8] = ((b[8] as number) & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
