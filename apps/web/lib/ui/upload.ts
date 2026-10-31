// Browser upload flow against the web API (owned by the backend routes):
//   POST /api/uploads → { media: { id }, upload: { mode: 'single', url, headers } | { mode: 'multipart', … } }
//   PUT the bytes to the presigned URL(s) → POST /api/uploads/<mediaId>/complete.
// The older documented contract { mediaId, uploadUrl, headers } is accepted too. Browser-safe; the
// network functions are injected so the flow is testable without a browser.

import { ALLOWED_MIME } from '@app/core/validation'

export type UploadPurpose = 'post' | 'clip_source'

export interface SinglePlan {
  mode: 'single'
  mediaId: string
  url: string
  headers: Record<string, string>
}

export interface MultipartPlan {
  mode: 'multipart'
  mediaId: string
  uploadId: string
  parts: Array<{ partNumber: number; bytes: number; url: string; headers: Record<string, string> }>
}

export type UploadPlan = SinglePlan | MultipartPlan

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const r = record(value)
  if (!r) return out
  for (const [k, v] of Object.entries(r)) if (typeof v === 'string') out[k] = v
  return out
}

/** Reads the POST /api/uploads response (either contract). null when it is not usable. */
export function normalizeUploadResponse(body: unknown): UploadPlan | null {
  const r = record(body)
  if (!r) return null
  if (typeof r.mediaId === 'string' && typeof r.uploadUrl === 'string') {
    return { mode: 'single', mediaId: r.mediaId, url: r.uploadUrl, headers: stringHeaders(r.headers) }
  }
  const media = record(r.media)
  const upload = record(r.upload)
  if (!media || typeof media.id !== 'string' || !upload) return null
  if (upload.mode === 'multipart' && typeof upload.uploadId === 'string' && Array.isArray(upload.parts)) {
    const parts: MultipartPlan['parts'] = []
    for (const p of upload.parts) {
      const part = record(p)
      if (!part || typeof part.partNumber !== 'number' || typeof part.bytes !== 'number' || typeof part.url !== 'string') return null
      parts.push({ partNumber: part.partNumber, bytes: part.bytes, url: part.url, headers: stringHeaders(part.headers) })
    }
    return { mode: 'multipart', mediaId: media.id, uploadId: upload.uploadId, parts }
  }
  if (typeof upload.url === 'string') return { mode: 'single', mediaId: media.id, url: upload.url, headers: stringHeaders(upload.headers) }
  return null
}

const EXT_MIME: Record<string, string> = {
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
}

const ALL_ALLOWED = new Set<string>(Object.values(ALLOWED_MIME).flat())

/** The file's MIME type, falling back to its extension when the browser leaves it empty. */
export function contentTypeFor(file: { name: string; type: string }): string | null {
  const type = file.type.toLowerCase()
  if (ALL_ALLOWED.has(type)) return type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? null
}

/** The `accept` attribute for file inputs. */
export const UPLOAD_ACCEPT = [...ALL_ALLOWED].join(',')

/** Headers the browser sets itself (setting them from script fails). */
const FORBIDDEN_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding', 'origin', 'referer'])

export function safePutHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) out[k] = v
  return out
}

export interface PutResult {
  ok: boolean
  status: number
  etag: string | null
}

export interface UploadDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  /** PUTs bytes with progress (XMLHttpRequest in the browser). */
  put: (url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void) => Promise<PutResult>
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } }
    return typeof body.error?.message === 'string' ? body.error.message : fallback
  } catch {
    return fallback
  }
}

export interface UploadInput {
  file: Blob & { name: string; type: string }
  purpose: UploadPurpose
  brandId?: string | null
  rightsAttested: boolean
}

/** Runs the whole upload. Resolves with the media id; rejects with an UploadError (user-safe message). */
export async function uploadFile(input: UploadInput, deps: UploadDeps, onProgress: (fraction: number) => void = () => undefined): Promise<{ mediaId: string; ingestQueued: boolean }> {
  const contentType = contentTypeFor(input.file)
  if (!contentType) throw new UploadError('This file type is not supported. Use MP4, MOV, WebM, MKV, JPEG, PNG, WebP, GIF or common audio files.')
  if (input.purpose === 'clip_source' && !input.rightsAttested) throw new UploadError('Confirm that you own this video or have the rights to use it.')

  const start = await deps.fetch('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      purpose: input.purpose,
      filename: input.file.name.replace(/[\\/]/g, '_').slice(0, 255) || 'upload',
      contentType,
      bytes: input.file.size,
      rightsAttested: input.rightsAttested,
      ...(input.brandId ? { brandId: input.brandId } : {}),
    }),
  })
  if (!start.ok) throw new UploadError(await errorMessage(start, 'The upload could not be started.'))
  const plan = normalizeUploadResponse(await start.json())
  if (!plan) throw new UploadError('The upload could not be started.')

  const total = input.file.size || 1
  let completeBody: Record<string, unknown> = {}
  if (plan.mode === 'single') {
    const res = await deps.put(plan.url, input.file, safePutHeaders(plan.headers), (loaded) => onProgress(Math.min(1, loaded / total)))
    if (!res.ok) throw new UploadError(`The file could not be uploaded (status ${res.status}).`)
  } else {
    const done: Array<{ partNumber: number; etag: string }> = []
    let offset = 0
    let sent = 0
    for (const part of plan.parts) {
      const chunk = input.file.slice(offset, offset + part.bytes)
      offset += part.bytes
      const res = await deps.put(part.url, chunk, safePutHeaders(part.headers), (loaded) => onProgress(Math.min(1, (sent + loaded) / total)))
      if (!res.ok || !res.etag) throw new UploadError(`Part ${part.partNumber} could not be uploaded.`)
      sent += part.bytes
      done.push({ partNumber: part.partNumber, etag: res.etag })
    }
    completeBody = { uploadId: plan.uploadId, parts: done }
  }
  onProgress(1)

  const complete = await deps.fetch(`/api/uploads/${encodeURIComponent(plan.mediaId)}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(completeBody),
  })
  if (!complete.ok) throw new UploadError(await errorMessage(complete, 'The upload could not be finished.'))
  let ingestQueued = false
  try {
    const body = (await complete.json()) as { ingestQueued?: unknown }
    ingestQueued = body.ingestQueued === true
  } catch {
    ingestQueued = false
  }
  return { mediaId: plan.mediaId, ingestQueued }
}

/** XMLHttpRequest PUT with upload progress (browser only). */
export function xhrPut(url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void): Promise<PutResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, etag: xhr.getResponseHeader('ETag') })
    xhr.onerror = () => resolve({ ok: false, status: 0, etag: null })
    xhr.send(body)
  })
}
