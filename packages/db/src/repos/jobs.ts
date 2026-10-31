import { backoffMs } from '@app/core/time'
import type { JobRow, JobStatus } from '@app/core/types'
import { camelRow, clampLimit, json, many, truncate } from '../sql'
import type { Db } from '../types'

export type { JobRow }

const mapJob = (row: Record<string, unknown>): JobRow => {
  const r = camelRow<JobRow>(row)
  return { ...r, payload: (r.payload ?? {}) as Record<string, unknown>, result: r.result ?? null }
}
const map = (row: Record<string, unknown> | null): JobRow | null => (row ? mapJob(row) : null)

export interface EnqueueInput {
  type: string
  payload?: Record<string, unknown>
  userId?: string | null
  /** Default: now. */
  runAt?: Date
  /** Default 5. */
  maxAttempts?: number
  /** Unique; a second enqueue with the same key returns the existing job. */
  idempotencyKey?: string | null
}

export interface EnqueueResult {
  job: JobRow
  created: boolean
}

/** Inserts a queued job. Call inside the transaction that creates the work it refers to. */
export async function enqueue(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  const row = await db.one(
    `insert into public.jobs (user_id, type, payload, run_at, max_attempts, idempotency_key)
     values ($1, $2, $3::text::jsonb, coalesce($4::timestamptz, now()), coalesce($5::int, 5), $6)
     on conflict (idempotency_key) do nothing
     returning *`,
    [
      input.userId ?? null,
      input.type,
      json(input.payload ?? {}),
      input.runAt ?? null,
      input.maxAttempts ?? null,
      input.idempotencyKey ?? null,
    ],
  )
  if (row) return { job: mapJob(row), created: true }
  const existing = await getByIdempotencyKey(db, input.idempotencyKey ?? '')
  if (!existing) throw new Error('job idempotency conflict without an existing row')
  return { job: existing, created: false }
}

export interface ClaimInput {
  /** Job types this worker handles. */
  types: readonly string[]
  workerId: string
  /** Lease length; the job is requeued by requeueStale once it expires. */
  leaseSec: number
  /** Max jobs to claim at once. Default 1. */
  limit?: number
  /** Default: database now(). */
  now?: Date
}

/**
 * Claims due jobs (queued, or failed and waiting for a retry, with run_at <= now) in run_at
 * order using FOR UPDATE SKIP LOCKED, so concurrent workers never get the same job. Marks them
 * running with a lease and increments attempts.
 */
export async function claim(db: Db, input: ClaimInput): Promise<JobRow[]> {
  if (input.types.length === 0) return []
  const rows = await db.query(
    `with due as (
       select id from public.jobs
        where status in ('queued', 'failed')
          and run_at <= coalesce($4::timestamptz, now())
          and type = any($1::text[])
        order by run_at, created_at, id
        limit $5
        for update skip locked
     )
     update public.jobs j
        set status = 'running',
            attempts = j.attempts + 1,
            locked_by = $2,
            locked_until = coalesce($4::timestamptz, now()) + make_interval(secs => $3::double precision)
       from due
      where j.id = due.id
     returning j.*`,
    [[...input.types], input.workerId, input.leaseSec, input.now ?? null, clampLimit(input.limit, 1, 100)],
  )
  return rows.map(mapJob).sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
}

/** running -> succeeded. Returns null if this worker no longer holds the job. */
export async function complete(db: Db, jobId: string, workerId: string, result?: unknown): Promise<JobRow | null> {
  return map(
    await db.one(
      `update public.jobs
          set status = 'succeeded', result = $3::text::jsonb, finished_at = now(),
              locked_by = null, locked_until = null, last_error = null
        where id = $1 and status = 'running' and locked_by = $2
        returning *`,
      [jobId, workerId, result === undefined ? null : json(result)],
    ),
  )
}

export interface FailOptions {
  /** Delay before the retry. Default: core backoffMs(attempts). */
  retryInMs?: number
  /** No retry: the job goes straight to dead. */
  permanent?: boolean
  /** Default: database now(). */
  now?: Date
}

/**
 * running -> failed (retried after a backoff) or dead (attempts exhausted or permanent).
 * Returns null if this worker no longer holds the job.
 */
export async function fail(db: Db, jobId: string, workerId: string, error: string, options: FailOptions = {}): Promise<JobRow | null> {
  return db.tx(async (tx) => {
    const current = map(
      await tx.one(`select * from public.jobs where id = $1 and status = 'running' and locked_by = $2 for update`, [
        jobId,
        workerId,
      ]),
    )
    if (!current) return null
    const dead = options.permanent === true || current.attempts >= current.maxAttempts
    const delayMs = Math.max(0, Math.floor(options.retryInMs ?? backoffMs(current.attempts)))
    return map(
      await tx.one(
        `update public.jobs
            set status = $2::public.job_status,
                last_error = $3,
                run_at = case when $2::public.job_status = 'failed'
                              then coalesce($5::timestamptz, now()) + make_interval(secs => $4::double precision / 1000)
                              else run_at end,
                finished_at = case when $2::public.job_status = 'dead' then now() else null end,
                locked_by = null, locked_until = null
          where id = $1
          returning *`,
        [jobId, dead ? 'dead' : 'failed', truncate(error, 4000), delayMs, options.now ?? null],
      ),
    )
  })
}

/** Extends the lease of a job this worker holds. False if the lease was lost. */
export async function extendLease(db: Db, jobId: string, workerId: string, leaseSec: number, now?: Date): Promise<boolean> {
  const rows = await db.query(
    `update public.jobs
        set locked_until = coalesce($4::timestamptz, now()) + make_interval(secs => $3::double precision)
      where id = $1 and status = 'running' and locked_by = $2
      returning id`,
    [jobId, workerId, leaseSec, now ?? null],
  )
  return rows.length > 0
}

export interface RequeueStaleResult {
  /** Jobs put back to failed (retry now). */
  requeued: number
  /** Jobs whose attempts were exhausted. */
  dead: number
}

/** Running jobs whose lease expired (worker crashed): retry now, or dead when out of attempts. */
export async function requeueStale(db: Db, now?: Date): Promise<RequeueStaleResult> {
  const rows = await db.query<{ status: JobStatus }>(
    `update public.jobs
        set status = case when attempts >= max_attempts then 'dead'::public.job_status else 'failed'::public.job_status end,
            finished_at = case when attempts >= max_attempts then now() else null end,
            run_at = case when attempts >= max_attempts then run_at else coalesce($1::timestamptz, now()) end,
            last_error = 'lease expired (worker stopped)',
            locked_by = null, locked_until = null
      where status = 'running' and locked_until < coalesce($1::timestamptz, now())
      returning status`,
    [now ?? null],
  )
  return {
    requeued: rows.filter((r) => r.status === 'failed').length,
    dead: rows.filter((r) => r.status === 'dead').length,
  }
}

export async function get(db: Db, jobId: string): Promise<JobRow | null> {
  return map(await db.one('select * from public.jobs where id = $1', [jobId]))
}

export async function getByIdempotencyKey(db: Db, idempotencyKey: string): Promise<JobRow | null> {
  return map(await db.one('select * from public.jobs where idempotency_key = $1', [idempotencyKey]))
}

export interface ListJobsOptions {
  type?: string
  status?: JobStatus | readonly JobStatus[]
  limit?: number
}

/** A user's jobs, newest first. */
export async function listForUser(db: Db, userId: string, options: ListJobsOptions = {}): Promise<JobRow[]> {
  const rows = await db.query(
    `select * from public.jobs
      where user_id = $1
        and ($2::text is null or type = $2)
        and ($3::text[]::public.job_status[] is null or status = any($3::text[]::public.job_status[]))
      order by created_at desc, id desc
      limit $4`,
    [userId, options.type ?? null, many(options.status), clampLimit(options.limit)],
  )
  return rows.map(mapJob)
}

/** Re-queues a dead or failed job now with a fresh attempt budget (manual retry). */
export async function retry(db: Db, jobId: string): Promise<JobRow | null> {
  return map(
    await db.one(
      `update public.jobs
          set status = 'queued', attempts = 0, run_at = now(), finished_at = null, last_error = null
        where id = $1 and status in ('dead', 'failed')
        returning *`,
      [jobId],
    ),
  )
}
