// Media: browser uploads (presigned PUT, or multipart above 5 GB), cloud-drive links for clip
// sources (allowlisted hosts only; never YouTube or other video sites), and the worker's ingest
// result. Users may only clip their own content: clip sources need a rights attestation.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError, isAppError } from '@app/core/errors'
import { checkSourceUrl, redactUrl } from '@app/core/links'
import { SOURCE_LIMITS } from '@app/core/plans'
import type { Actor, MediaKind, MediaStatus } from '@app/core/types'
import { MediaKindSchema, MediaStatusSchema } from '@app/core/types'
import { DriveLinkInputSchema, IdSchema, UploadRequestSchema, mediaKindForMime } from '@app/core/validation'
import type { BoundRepos, MediaRow } from '@app/db'
import {
  MAX_SINGLE_PUT_BYTES,
  checkCompletedParts,
  extForMime,
  parseKey,
  planParts,
  sourceKey,
  supportsMultipart,
  uploadKey,
} from '@app/storage'
import { auditIn } from './audit'
import {
  conflict,
  errorMessage,
  fromZod,
  requireActiveBrand,
  requireMedia,
  requireUser,
  userIdOf,
  validation,
  withErrors,
  type Ctx,
} from './context'
import { requireCanCreate, requireCanProcessMedia, userEntitlements } from './entitlements'
import { enqueueJob } from './jobs'
import { balanceIn, clipReserveKey, releaseIn, reserveIn } from './usage'

/** A media row as shown to users and AI clients: the drive share link (a capability) is never echoed. */
export type MediaView = Omit<MediaRow, 'sourceUrl'>

export function mediaView(row: MediaRow): MediaView {
  const { sourceUrl: _sourceUrl, ...rest } = row
  return rest
}

export type UploadPurpose = 'post' | 'clip_source'

export type UploadTarget =
  | { mode: 'single'; method: 'PUT'; url: string; headers: Record<string, string>; bytes: number; expiresAt: string }
  | {
      mode: 'multipart'
      uploadId: string
      partBytes: number
      parts: Array<{ partNumber: number; bytes: number; url: string; headers: Record<string, string> }>
      expiresAt: string
    }

export interface CreateUploadResult {
  media: MediaView
  upload: UploadTarget
}

/** Whether a media row is a clip source (own video, rights attested). */
export function isClipSource(media: Pick<MediaRow, 'kind' | 'origin' | 'rightsAttestedAt'>): boolean {
  return media.kind === 'video' && (media.origin === 'upload' || media.origin === 'drive_link') && media.rightsAttestedAt !== null
}

const CompleteUploadSchema = z.strictObject({
  uploadId: z.string().min(1).max(1024).optional(),
  parts: z.array(z.unknown()).max(10_000).optional(),
})

const IngestFactsSchema = z.strictObject({
  bytes: z.number().int().min(0).max(SOURCE_LIMITS.maxBytes * 2).optional(),
  durationMs: z.number().int().min(0).max(2_000_000_000).optional(),
  width: z.number().int().min(1).max(20_000).optional(),
  height: z.number().int().min(1).max(20_000).optional(),
  mimeType: z.string().trim().toLowerCase().max(127).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
})
export type IngestFacts = z.input<typeof IngestFactsSchema>

const ListMediaSchema = z.strictObject({
  brandId: IdSchema.optional(),
  kind: MediaKindSchema.optional(),
  status: MediaStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().max(100).optional(),
})

function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase()
}

function encodeCursor(row: MediaRow): string {
  return Buffer.from(row.createdAt.toISOString(), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): Date | undefined {
  if (!cursor) return undefined
  const date = new Date(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (Number.isNaN(date.getTime())) throw validation('Invalid cursor.')
  return date
}

export interface IngestResult {
  media: MediaView
  /** A transcribe job was queued (clip sources). */
  transcribe: boolean
  /** Set when the ingest was refused (too long, not enough clipping time, ...). */
  error?: string
}

export function createMediaService(ctx: Ctx) {
  async function failIn(r: BoundRepos, userId: string, media: MediaRow, message: string, actor: Actor): Promise<MediaRow> {
    const row = await r.media.update(userId, media.id, { status: 'failed', sourceUrl: null })
    if (isClipSource(media)) await releaseIn(r, userId, { reserveKey: clipReserveKey(media.id), subjectId: media.id, note: 'ingest failed' })
    await auditIn(r, userId, {
      actor,
      action: 'media.failed',
      subjectType: 'media',
      subjectId: media.id,
      meta: { reason: message.slice(0, 300) },
    })
    return row ?? media
  }

  /** Best effort: removes the file of a media row that failed (the row stays for lineage). */
  async function deleteStored(media: MediaRow): Promise<void> {
    await ctx.storage.delete(media.storageKey).catch((error: unknown) => {
      ctx.log.warn('could not delete a failed media file', { mediaId: media.id, error: errorMessage(error) })
    })
  }

  return withErrors({
    /**
     * Starts a browser upload: validates type/size, checks the storage allowance, creates a
     * pending media row and returns a presigned PUT (or multipart part URLs above 5 GB).
     * Clip sources (purpose "clip_source") must be videos with the rights attestation.
     */
    async createUpload(userId: string, input: unknown, options: { purpose?: UploadPurpose; via?: Actor } = {}): Promise<CreateUploadResult> {
      const uid = userIdOf(userId)
      const data = fromZod(UploadRequestSchema, input, 'Upload')
      const purpose: UploadPurpose = options.purpose === 'clip_source' ? 'clip_source' : 'post'
      const kind = mediaKindForMime(data.contentType) as MediaKind
      if (purpose === 'clip_source') {
        if (kind !== 'video') throw validation('Only videos can be clipped.')
        if (!data.rightsAttested) {
          throw validation('Confirm that you own this video or have the rights to use it.', { field: 'rightsAttested' })
        }
      }
      const ext = extForMime(data.contentType) ?? 'bin'
      const key = uploadKey(uid, randomUUID(), ext)

      const media = await ctx.tx(async (r) => {
        const user = await requireUser(r, uid, true)
        const ent = userEntitlements(user, ctx.now())
        requireCanCreate(ent)
        if (purpose === 'clip_source') requireCanProcessMedia(ent)
        if (data.brandId) await requireActiveBrand(r, uid, data.brandId)
        const stored = await r.media.storageBytes(uid)
        if (stored + data.bytes > ent.storageBytes) {
          throw new AppError('limit_exceeded', 'Your storage is full. Delete old media to make room.', {
            limit: ent.storageBytes,
            used: stored,
            remaining: Math.max(0, ent.storageBytes - stored),
            requested: data.bytes,
          })
        }
        const row = await r.media.create(uid, {
          brandId: data.brandId ?? null,
          kind,
          origin: 'upload',
          status: 'pending',
          storageKey: key,
          mimeType: data.contentType,
          bytes: data.bytes,
          rightsAttestedAt: purpose === 'clip_source' ? ctx.now() : null,
        })
        await auditIn(r, uid, {
          actor: options.via ?? 'web',
          action: 'media.upload_started',
          subjectType: 'media',
          subjectId: row.id,
          meta: { kind, bytes: data.bytes, purpose },
        })
        return row
      })

      const ttl = ctx.config.uploadUrlTtlSec
      const expiresAt = new Date(ctx.now().getTime() + ttl * 1000).toISOString()
      if (data.bytes <= MAX_SINGLE_PUT_BYTES) {
        const put = await ctx.storage.presignPut(key, data.contentType, data.bytes)
        return {
          media: mediaView(media),
          upload: { mode: 'single', method: 'PUT', url: put.url, headers: put.headers, bytes: data.bytes, expiresAt },
        }
      }
      const storage = ctx.storage
      if (!supportsMultipart(storage)) throw validation('Files over 5 GB are not supported by this storage.')
      const plan = planParts(data.bytes)
      const { uploadId } = await storage.createMultipartUpload(key, data.contentType)
      const parts = []
      for (const part of plan) {
        const put = await storage.presignUploadPart(key, uploadId, part.partNumber, part.bytes, ttl)
        parts.push({ partNumber: part.partNumber, bytes: part.bytes, url: put.url, headers: put.headers })
      }
      return {
        media: mediaView(media),
        upload: { mode: 'multipart', uploadId, partBytes: plan[0]?.bytes ?? data.bytes, parts, expiresAt },
      }
    },

    /**
     * Finishes an upload: checks the stored object (size and type must match what was declared),
     * then images become ready and videos/audio go to the ingest worker (duration probe; clip
     * sources are then metered and transcribed). Idempotent once ready.
     */
    async completeUpload(
      userId: string,
      mediaId: string,
      input: { uploadId?: string; parts?: unknown[] } = {},
      options: { via?: Actor } = {},
    ): Promise<{ media: MediaView; ingestQueued: boolean }> {
      const uid = userIdOf(userId)
      const data = fromZod(CompleteUploadSchema, input ?? {}, 'Upload completion')
      const media = await requireMedia(ctx.repos, uid, mediaId)
      if (media.origin !== 'upload') throw validation('This media was not uploaded from a browser.')
      if (media.status === 'ready') return { media: mediaView(media), ingestQueued: false }
      if (media.status === 'failed') throw conflict('This upload failed. Start a new upload.')

      if (data.uploadId) {
        const storage = ctx.storage
        if (!supportsMultipart(storage)) throw validation('Multipart uploads are not supported by this storage.')
        let parts
        try {
          parts = checkCompletedParts(data.parts ?? [])
        } catch (error) {
          throw validation(isAppError(error) ? error.message : 'Invalid part list.')
        }
        await storage.completeMultipartUpload(media.storageKey, data.uploadId, parts)
      }

      const head = await ctx.storage.head(media.storageKey)
      if (!head) throw validation('The file has not been uploaded yet. Upload it, then try again.')
      const declaredType = baseMime(media.mimeType ?? '')
      const problem =
        media.bytes !== null && head.bytes !== media.bytes
          ? 'The uploaded file does not match the declared size.'
          : declaredType && baseMime(head.contentType) !== declaredType
            ? 'The uploaded file does not match the declared type.'
            : null
      if (problem) {
        await ctx.storage.delete(media.storageKey).catch(() => undefined)
        await ctx.tx((r) => failIn(r, uid, media, problem, options.via ?? 'web'))
        throw validation(problem)
      }

      return ctx.tx(async (r) => {
        if (media.kind === 'video' || media.kind === 'audio') {
          const row = await r.media.update(uid, media.id, { bytes: head.bytes })
          await enqueueJob(r, {
            type: 'source_ingest',
            payload: { userId: uid, mediaId: media.id },
            idempotencyKey: `source_ingest:${media.id}`,
          })
          await auditIn(r, uid, { actor: options.via ?? 'web', action: 'media.uploaded', subjectType: 'media', subjectId: media.id })
          return { media: mediaView(row ?? media), ingestQueued: true }
        }
        const row = await r.media.update(uid, media.id, { status: 'ready', bytes: head.bytes })
        await auditIn(r, uid, { actor: options.via ?? 'web', action: 'media.uploaded', subjectType: 'media', subjectId: media.id })
        return { media: mediaView(row ?? media), ingestQueued: false }
      })
    },

    /**
     * Registers a cloud-drive link to the user's own video as a clip source. Only https links on
     * Google Drive, Dropbox and OneDrive are accepted; YouTube and other video sites are refused
     * (we never download them). The worker downloads the file (source_ingest).
     */
    async registerDriveLink(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<{ media: MediaView }> {
      const uid = userIdOf(userId)
      const data = fromZod(DriveLinkInputSchema, input, 'Link')
      const check = checkSourceUrl(data.url)
      if (!check.ok) {
        ctx.log.info('drive link refused', { reason: check.reason, url: redactUrl(data.url) })
        throw new AppError('validation', check.message, { reason: check.reason, field: 'url' })
      }
      return ctx.tx(async (r) => {
        const user = await requireUser(r, uid, true)
        const ent = userEntitlements(user, ctx.now())
        requireCanCreate(ent)
        requireCanProcessMedia(ent)
        if (data.brandId) await requireActiveBrand(r, uid, data.brandId)
        // Refuse before the worker downloads anything (the size and length are unknown until then).
        const clip = await balanceIn(r, uid, ent, 'clip_seconds')
        if (clip.remaining <= 0) {
          throw new AppError('limit_exceeded', 'No clipping time is left this period, so this video cannot be added.', {
            meter: 'clip_seconds',
            remaining: 0,
            limit: clip.limit,
            periodEnd: clip.period.end.toISOString(),
          })
        }
        const stored = await r.media.storageBytes(uid)
        if (stored >= ent.storageBytes) {
          throw new AppError('limit_exceeded', 'Your storage is full. Delete old media to make room.', {
            limit: ent.storageBytes,
            used: stored,
            remaining: 0,
          })
        }
        const pending = await r.media.list(uid, { origin: 'drive_link', status: 'pending', limit: ctx.config.maxPendingDriveLinks })
        if (pending.length >= ctx.config.maxPendingDriveLinks) {
          throw new AppError('limit_exceeded', `${pending.length} links are still being downloaded. Wait until they are done, then add more.`, {
            pending: pending.length,
            limit: ctx.config.maxPendingDriveLinks,
          })
        }
        const row = await r.media.create(uid, {
          brandId: data.brandId ?? null,
          kind: 'video',
          origin: 'drive_link',
          status: 'pending',
          storageKey: sourceKey(uid, randomUUID(), 'mp4'),
          sourceHost: check.host,
          sourceUrl: check.url,
          rightsAttestedAt: ctx.now(),
        })
        await enqueueJob(r, {
          type: 'source_ingest',
          payload: { userId: uid, mediaId: row.id },
          idempotencyKey: `source_ingest:${row.id}`,
        })
        await auditIn(r, uid, {
          actor: options.via ?? 'web',
          action: 'media.drive_link_registered',
          subjectType: 'media',
          subjectId: row.id,
          meta: { host: check.host, provider: check.provider },
        })
        return { media: mediaView(row) }
      })
    },

    async get(userId: string, mediaId: string): Promise<MediaView> {
      return mediaView(await requireMedia(ctx.repos, userIdOf(userId), mediaId))
    },

    /** Worker only: the full row, including the drive link to download. */
    async getForWorker(userId: string, mediaId: string): Promise<MediaRow> {
      return requireMedia(ctx.repos, userIdOf(userId), mediaId)
    },

    async list(userId: string, input: unknown = {}): Promise<{ items: MediaView[]; nextCursor: string | null }> {
      const uid = userIdOf(userId)
      const data = fromZod(ListMediaSchema, input ?? {}, 'Filter')
      const before = decodeCursor(data.cursor)
      const rows = await ctx.repos.media.list(uid, {
        ...(data.brandId ? { brandId: data.brandId } : {}),
        ...(data.kind ? { kind: data.kind } : {}),
        ...(data.status ? { status: data.status as MediaStatus } : {}),
        ...(before ? { before } : {}),
        limit: data.limit + 1,
      })
      const page = rows.slice(0, data.limit)
      const last = page[page.length - 1]
      return { items: page.map(mediaView), nextCursor: rows.length > data.limit && last ? encodeCursor(last) : null }
    },

    /** A short-lived download URL for a ready file (previews). */
    async downloadUrl(userId: string, mediaId: string, ttlSec?: number): Promise<{ url: string; expiresAt: string }> {
      const media = await requireMedia(ctx.repos, userIdOf(userId), mediaId)
      if (media.status !== 'ready') throw conflict('This file is not ready yet.')
      const ttl = Math.max(60, Math.min(7 * 86_400, Math.floor(ttlSec ?? ctx.config.previewUrlTtlSec)))
      const url = await ctx.storage.presignGet(media.storageKey, ttl)
      return { url, expiresAt: new Date(ctx.now().getTime() + ttl * 1000).toISOString() }
    },

    /** Deletes the stored file; the row stays as `deleted` (lineage, clips). */
    async remove(userId: string, mediaId: string, options: { via?: Actor } = {}): Promise<MediaView> {
      const uid = userIdOf(userId)
      const media = await requireMedia(ctx.repos, uid, mediaId)
      await ctx.storage.delete(media.storageKey)
      return ctx.tx(async (r) => {
        const row = await r.media.update(uid, media.id, { status: 'deleted', sourceUrl: null })
        // A source deleted before its transcript exists will never be transcribed: give the
        // reserved clipping time back (a transcript means it was already settled).
        if (isClipSource(media) && !(await r.transcripts.getByMedia(uid, media.id))) {
          await releaseIn(r, uid, { reserveKey: clipReserveKey(media.id), subjectId: media.id, note: 'deleted' })
        }
        await auditIn(r, uid, { actor: options.via ?? 'web', action: 'media.deleted', subjectType: 'media', subjectId: media.id })
        return mediaView(row ?? media)
      })
    },

    /**
     * Worker (source_ingest): moves a pending clip-source upload from its `uploads/` key to its
     * immutable `sources/` key (the worker has already written the file there), so a still-valid
     * presigned PUT can no longer swap the file after ingest. Only the media's own source key is
     * accepted. Returns null when the row is no longer pending at `fromKey` (raced / deleted).
     */
    async promoteSource(userId: string, mediaId: string, fromKey: string, toKey: string): Promise<MediaView | null> {
      const uid = userIdOf(userId)
      const media = await requireMedia(ctx.repos, uid, mediaId)
      if (!isClipSource(media) || media.origin !== 'upload') throw validation('Only uploaded clip sources are promoted.')
      const ext = parseKey(toKey)?.ext
      if (!ext || toKey !== sourceKey(uid, media.id, ext)) throw validation('The target must be this media’s own source key.')
      if (typeof fromKey !== 'string' || fromKey.length === 0) throw validation('Invalid source key.')
      const row = await ctx.repos.media.moveStorageKey(uid, media.id, fromKey, toKey)
      return row ? mediaView(row) : null
    },

    /**
     * Worker (source_ingest) result: the file is in storage at media.storageKey and was probed.
     * Applies the source limits (≤ 4 h, ≤ 10 GB); for clip sources reserves the clipping time
     * (seconds of source video, charged once per source) and queues transcription. A refusal
     * (too long, not enough clipping time, payment issue) marks the media failed and is returned
     * in `error` (the job itself succeeded). Idempotent once ready.
     */
    async markIngested(userId: string, mediaId: string, facts: IngestFacts): Promise<IngestResult> {
      const uid = userIdOf(userId)
      const data = fromZod(IngestFactsSchema, facts ?? {}, 'Ingest result')
      const media = await requireMedia(ctx.repos, uid, mediaId)
      if (media.status === 'ready') return { media: mediaView(media), transcribe: false }
      if (media.status !== 'pending') throw conflict('This media is not waiting for ingest.')

      const durationMs = data.durationMs ?? media.durationMs
      const bytes = data.bytes ?? media.bytes
      const refuse = async (message: string): Promise<IngestResult> => {
        const row = await ctx.tx((r) => failIn(r, uid, media, message, 'worker'))
        // a refused file is never used: do not keep it in storage for the retention period
        await deleteStored(media)
        return { media: mediaView(row), transcribe: false, error: message }
      }
      if (media.kind === 'video' || media.kind === 'audio') {
        if (durationMs === null || durationMs === undefined) return refuse('Could not read the length of this file.')
        if (durationMs > SOURCE_LIMITS.maxDurationMs) return refuse('Videos may be at most 4 hours long.')
      }
      if (bytes !== null && bytes !== undefined && bytes > SOURCE_LIMITS.maxBytes) return refuse('Files may be at most 10 GB.')

      const clipSource = isClipSource(media)
      try {
        return await ctx.tx(async (r) => {
          // storage allowance with the real size (drive links were unknown at registration)
          const user = await requireUser(r, uid, true)
          const ent = userEntitlements(user, ctx.now())
          if (bytes !== null && bytes !== undefined) {
            const others = (await r.media.storageBytes(uid)) - (media.bytes ?? 0)
            if (others + bytes > ent.storageBytes) {
              throw new AppError('limit_exceeded', 'Your storage is full. Delete old media to make room.', {
                limit: ent.storageBytes,
                used: others,
                requested: bytes,
              })
            }
          }
          if (clipSource) {
            await reserveIn(ctx, r, uid, {
              meter: 'clip_seconds',
              amount: Math.max(1, Math.ceil((durationMs ?? 0) / 1000)),
              idempotencyKey: clipReserveKey(media.id),
              subjectType: 'media',
              subjectId: media.id,
              note: 'source video',
            })
          }
          const row = await r.media.update(uid, media.id, {
            status: 'ready',
            ...(durationMs !== null && durationMs !== undefined ? { durationMs } : {}),
            ...(bytes !== null && bytes !== undefined ? { bytes } : {}),
            ...(data.width ? { width: data.width } : {}),
            ...(data.height ? { height: data.height } : {}),
            ...(data.mimeType ? { mimeType: data.mimeType } : {}),
            ...(data.sha256 ? { sha256: data.sha256 } : {}),
            ...(media.origin === 'drive_link' ? { sourceUrl: null } : {}),
          })
          if (clipSource) {
            await enqueueJob(r, {
              type: 'transcribe',
              payload: { userId: uid, mediaId: media.id },
              idempotencyKey: `transcribe:${media.id}`,
            })
          }
          await auditIn(r, uid, {
            actor: 'worker',
            action: 'media.ingested',
            subjectType: 'media',
            subjectId: media.id,
            meta: { durationMs: durationMs ?? null, clipSource },
          })
          return { media: mediaView(row ?? media), transcribe: clipSource }
        })
      } catch (error) {
        if (isAppError(error) && (error.code === 'limit_exceeded' || error.code === 'payment_required')) {
          return refuse(error.message)
        }
        throw error
      }
    },

    /** Worker: ingest failed for good (download refused, unreadable file). Releases any reservation. */
    async markFailed(userId: string, mediaId: string, error: unknown): Promise<MediaView> {
      const uid = userIdOf(userId)
      const media = await requireMedia(ctx.repos, uid, mediaId)
      if (media.status === 'ready' || media.status === 'deleted') return mediaView(media)
      const row = await ctx.tx((r) => failIn(r, uid, media, errorMessage(error, 'Processing failed.'), 'worker'))
      await deleteStored(media)
      return mediaView(row)
    },
  })
}

export type MediaService = ReturnType<typeof createMediaService>
