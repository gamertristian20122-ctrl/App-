// Object keys. Every key is scoped to one user: `users/{userId}/{area}/{id}.{ext}`.
// Build keys only with these helpers; every storage driver rejects keys that do not follow the
// layout (wrong prefix, path traversal, odd characters), so a bug elsewhere cannot write outside a
// user's prefix or escape the FsStorage directory.
//
//   users/{userId}/uploads/{mediaId}.{ext}   browser uploads through a presigned PUT (any media kind)
//   users/{userId}/sources/{mediaId}.{ext}   clip sources the worker ingests (cloud-drive links)
//   users/{userId}/clips/{clipId}.{ext}      rendered vertical clips (default mp4)
//   users/{userId}/renders/{mediaId}.{ext}   carousel slides (png) and template videos (mp4)

import { storageError } from './errors'

export const KEY_AREAS = ['uploads', 'sources', 'clips', 'renders'] as const
export type KeyArea = (typeof KEY_AREAS)[number]

/** Longest key we accept (S3 allows 1024 bytes; ours are far shorter). */
export const MAX_KEY_LENGTH = 512

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EXT_RE = /^[a-z0-9]{1,8}$/
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const KEY_RE = /^users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/
const PARSE_RE =
  /^users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(uploads|sources|clips|renders)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{1,8})$/

function uuid(value: unknown, what: string): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!UUID_RE.test(v)) throw storageError('invalid_key', `${what} must be a UUID.`)
  return v
}

/** "MP4", ".mp4" and "mp4" all become "mp4". Only 1–8 lowercase letters/digits are accepted. */
export function normalizeExt(ext: unknown): string {
  const v = typeof ext === 'string' ? ext.trim().toLowerCase().replace(/^\./, '') : ''
  if (!EXT_RE.test(v)) throw storageError('invalid_key', 'File extension must be 1–8 letters or digits.')
  return v
}

/** The prefix that holds every object of one user (for listing or bulk deletes). */
export function userPrefix(userId: string): string {
  return `users/${uuid(userId, 'userId')}/`
}

function build(area: KeyArea, userId: string, id: string, ext: string, idName: string): string {
  return `${userPrefix(userId)}${area}/${uuid(id, idName)}.${normalizeExt(ext)}`
}

/** A source video for clipping (ingested from a cloud-drive link, or an upload promoted to a source). */
export function sourceKey(userId: string, mediaId: string, ext: string): string {
  return build('sources', userId, mediaId, ext, 'mediaId')
}

/** A browser upload through a presigned PUT. */
export function uploadKey(userId: string, mediaId: string, ext: string): string {
  return build('uploads', userId, mediaId, ext, 'mediaId')
}

/** A rendered clip. */
export function clipKey(userId: string, clipId: string, ext = 'mp4'): string {
  return build('clips', userId, clipId, ext, 'clipId')
}

/** A rendered carousel slide or template video (one media asset per object). */
export function renderKey(userId: string, mediaId: string, ext: string): string {
  return build('renders', userId, mediaId, ext, 'mediaId')
}

export interface ParsedKey {
  userId: string
  area: KeyArea
  id: string
  ext: string
}

/** Splits a key built by the helpers above; null for anything else. */
export function parseKey(key: string): ParsedKey | null {
  const m = PARSE_RE.exec(key)
  if (!m) return null
  return { userId: m[1] as string, area: m[2] as KeyArea, id: m[3] as string, ext: m[4] as string }
}

/** Whether `key` is a valid key inside `userId`'s prefix. */
export function isKeyOwnedBy(key: string, userId: string): boolean {
  try {
    return assertValidKey(key).startsWith(userPrefix(userId))
  } catch {
    return false
  }
}

/** The user id embedded in a valid key, or null. */
export function keyOwner(key: string): string | null {
  try {
    return KEY_RE.exec(assertValidKey(key))?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Checks the key layout every driver relies on: `users/{uuid}/` followed by one or more path
 * segments of [A-Za-z0-9._-] that do not start with a dot (so no "." / ".." / hidden files), no empty
 * segments, no trailing slash, at most MAX_KEY_LENGTH characters. Returns the key unchanged.
 */
export function assertValidKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw storageError('invalid_key', 'Storage key is missing or too long.')
  }
  const m = KEY_RE.exec(key)
  if (!m) throw storageError('invalid_key', 'Storage keys must start with users/{userId}/.')
  const rest = (m[2] as string).split('/')
  if (rest.length === 0 || rest.some((segment) => !SEGMENT_RE.test(segment))) {
    throw storageError('invalid_key', 'Storage key contains an invalid path segment.')
  }
  return key
}

// ---------------------------------------------------------------------------
// MIME type ↔ extension (covers ALLOWED_MIME in @app/core/validation plus render outputs)
// ---------------------------------------------------------------------------

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
  'text/vtt': 'vtt',
  'application/x-subrip': 'srt',
  'application/json': 'json',
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  flac: 'audio/flac',
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
  json: 'application/json',
}

/** Extension for a MIME type (parameters such as "; codecs=" are ignored); null when unknown. */
export function extForMime(mime: string): string | null {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXT_BY_MIME[base] ?? null
}

/** MIME type for an extension; null when unknown. */
export function mimeForExt(ext: string): string | null {
  return MIME_BY_EXT[ext.trim().toLowerCase().replace(/^\./, '')] ?? null
}
