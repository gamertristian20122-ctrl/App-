// Job queue helpers used by services (enqueue in the same transaction as the work) and by the
// worker (claim / complete / fail). Payloads are validated per job type with zod, both when they
// are enqueued and when a worker reads them back.

import { z } from 'zod'
import { AppError, fromZodError } from '@app/core/errors'
import { backoffMs } from '@app/core/time'
import { JOB_TYPES, PLATFORMS, type JobRow, type JobType } from '@app/core/types'
import { AutoPublishSchema, IdSchema, RenderCarouselInputSchema, RenderCodeVideoInputSchema, RenderVideoInputSchema } from '@app/core/validation'
import type { BoundRepos } from '@app/db'
import { errorMessage, id, notFound, userIdOf, withErrors, type Ctx } from './context'

const Uuid = IdSchema

export const JOB_PAYLOAD_SCHEMAS = {
  publish_post: z.object({ userId: Uuid, postId: Uuid }),
  check_post_status: z.object({ userId: Uuid, postId: Uuid, poll: z.number().int().min(0).default(0) }),
  source_ingest: z.object({ userId: Uuid, mediaId: Uuid }),
  transcribe: z.object({ userId: Uuid, mediaId: Uuid, language: z.string().min(2).max(16).optional() }),
  /** autoPublish: the clip's draft goes through the brand's Auto-post rule when it is rendered. */
  clip_render: z.object({ userId: Uuid, clipId: Uuid, autoPublish: AutoPublishSchema.optional() }),
  carousel_render: z.object({ userId: Uuid, brandId: Uuid, input: RenderCarouselInputSchema }),
  video_render: z.object({ userId: Uuid, brandId: Uuid, input: RenderVideoInputSchema }),
  analytics_pull: z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('post'), userId: Uuid, postId: Uuid, checkpointMs: z.number().int().min(0).optional() }),
    z.object({ scope: z.literal('account'), userId: Uuid, brandId: Uuid }),
  ]),
  import_past_posts: z.object({
    userId: Uuid,
    brandId: Uuid,
    accountId: Uuid,
    platform: z.enum(PLATFORMS),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  cleanup: z.object({ task: z.enum(['all', 'expired', 'sources']).default('all') }),
  code_video_render: z.object({ userId: Uuid, brandId: Uuid, input: RenderCodeVideoInputSchema }),
  /** Fetch a finished video/image from media.source_url (upload_media sourceUrl). */
  url_import: z.object({ userId: Uuid, mediaId: Uuid }),
} as const satisfies Record<JobType, z.ZodType>

export type JobPayload<T extends JobType> = z.output<(typeof JOB_PAYLOAD_SCHEMAS)[T]>
export type JobPayloadInput<T extends JobType> = z.input<(typeof JOB_PAYLOAD_SCHEMAS)[T]>

export function isJobType(value: unknown): value is JobType {
  return typeof value === 'string' && (JOB_TYPES as readonly string[]).includes(value)
}

/** Validates a job's payload for its type (worker side). Throws AppError('validation'). */
export function parseJobPayload<T extends JobType>(type: T, payload: unknown): JobPayload<T> {
  const schema = JOB_PAYLOAD_SCHEMAS[type] as unknown as z.ZodType<JobPayload<T>>
  const result = schema.safeParse(payload)
  if (!result.success) throw fromZodError(result.error, `The ${type} job payload`)
  return result.data
}

export interface EnqueueJob<T extends JobType = JobType> {
  type: T
  payload: JobPayloadInput<T>
  runAt?: Date
  maxAttempts?: number
  /** A second enqueue with the same key returns the existing job. */
  idempotencyKey?: string
}

/** Enqueue through bound repos (use the transaction's repos so the job commits with the work). */
export async function enqueueJob<T extends JobType>(r: BoundRepos, job: EnqueueJob<T>): Promise<{ job: JobRow; created: boolean }> {
  const payload = parseJobPayload(job.type, job.payload) as Record<string, unknown>
  const userId = typeof payload.userId === 'string' ? payload.userId : null
  return r.jobs.enqueue({
    type: job.type,
    payload,
    userId,
    ...(job.runAt ? { runAt: job.runAt } : {}),
    ...(job.maxAttempts ? { maxAttempts: job.maxAttempts } : {}),
    ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
  })
}

export interface ClaimOptions {
  workerId: string
  types: readonly JobType[]
  /** Lease length in seconds. Default 300. */
  leaseSec?: number
  limit?: number
  now?: Date
}

/** What a job looks like to the user (no internal lease fields). */
export interface JobView {
  id: string
  type: string
  status: JobRow['status']
  attempts: number
  runAt: Date
  finishedAt: Date | null
  error: string | null
  result: unknown
  createdAt: Date
}

export function jobView(job: JobRow): JobView {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    runAt: job.runAt,
    finishedAt: job.finishedAt,
    error: job.lastError,
    result: job.result,
    createdAt: job.createdAt,
  }
}

const WorkerIdSchema = z.string().trim().min(1).max(200)

export function createJobsService(ctx: Ctx) {
  const workerIdOf = (value: unknown) => {
    const r = WorkerIdSchema.safeParse(value)
    if (!r.success) throw new AppError('validation', 'Invalid worker id.')
    return r.data
  }

  return withErrors({
    /** System enqueue (cron fan-out, worker follow-ups). Payload validated per type. */
    async enqueue<T extends JobType>(job: EnqueueJob<T>) {
      if (!isJobType(job.type)) throw new AppError('validation', 'Unknown job type.')
      return enqueueJob(ctx.repos, job)
    },

    /** Claims due jobs of the given types (FOR UPDATE SKIP LOCKED). */
    async claim(options: ClaimOptions): Promise<JobRow[]> {
      const types = options.types.filter(isJobType)
      if (types.length === 0) return []
      return ctx.repos.jobs.claim({
        types,
        workerId: workerIdOf(options.workerId),
        leaseSec: Math.max(5, Math.min(3_600, Math.floor(options.leaseSec ?? 300))),
        limit: options.limit ?? 1,
        ...(options.now ? { now: options.now } : {}),
      })
    },

    /** running → succeeded. Null if this worker lost the lease. */
    async complete(jobId: string, workerId: string, result?: unknown) {
      return ctx.repos.jobs.complete(id(jobId, 'Job'), workerIdOf(workerId), result)
    },

    /**
     * running → failed (retry after a backoff; default core backoffMs(attempts)) or dead
     * (attempts exhausted or permanent). The stored message is scrubbed of secrets.
     */
    async fail(jobId: string, workerId: string, error: unknown, options: { retryInMs?: number; permanent?: boolean; now?: Date } = {}) {
      return ctx.repos.jobs.fail(id(jobId, 'Job'), workerIdOf(workerId), errorMessage(error, 'Job failed.'), {
        ...(options.retryInMs !== undefined ? { retryInMs: Math.max(0, options.retryInMs) } : {}),
        ...(options.permanent ? { permanent: true } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    },

    /** Extends a held lease from `now` (app clock; default the database clock). False if the lease was lost. */
    async extendLease(jobId: string, workerId: string, leaseSec: number, now?: Date) {
      return ctx.repos.jobs.extendLease(id(jobId, 'Job'), workerIdOf(workerId), Math.max(5, Math.min(3_600, Math.floor(leaseSec))), now)
    },

    /** running → queued without using up the attempt (worker shutdown). False if the lease was lost. */
    async release(jobId: string, workerId: string, now?: Date) {
      return ctx.repos.jobs.release(id(jobId, 'Job'), workerIdOf(workerId), now)
    },

    /** Expired leases (crashed workers) → retry now, or dead when out of attempts. */
    async requeueStale(now?: Date) {
      return ctx.repos.jobs.requeueStale(now)
    },

    /** One of the user's jobs (render / import progress). Other users' jobs → not_found. */
    async get(userId: string, jobId: string): Promise<JobView> {
      const uid = userIdOf(userId)
      const job = await ctx.repos.jobs.get(id(jobId, 'Job'))
      if (!job || job.userId !== uid) throw notFound('Job')
      return jobView(job)
    },

    async listForUser(userId: string, options: { type?: JobType; limit?: number } = {}): Promise<JobView[]> {
      const rows = await ctx.repos.jobs.listForUser(userIdOf(userId), {
        ...(options.type ? { type: options.type } : {}),
        limit: options.limit ?? 20,
      })
      return rows.map(jobView)
    },

    parsePayload: parseJobPayload,

    /** Default retry delay for a failed attempt (worker convenience). */
    backoffMs: (attempt: number) => backoffMs(attempt),
  })
}

export type JobsService = ReturnType<typeof createJobsService>
