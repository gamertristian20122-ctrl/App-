// Worker heartbeats: each worker process upserts its row every minute (apps/worker), and the
// owner's /setup page reads how long ago each worker group was seen. Times come from the database
// clock on both sides, so clock skew between Railway and Vercel does not matter.

import { camelRows, toNumber } from '../sql'
import type { Db } from '../types'

export type WorkerGroupName = 'posting' | 'media'

export interface HeartbeatRow {
  workerId: string
  types: WorkerGroupName[]
  lastSeenAt: Date
  version: string | null
  startedAt: Date
  createdAt: Date
  /** Seconds since last_seen_at, by the database clock. */
  ageSec: number
}

export interface BeatInput {
  workerId: string
  types: readonly WorkerGroupName[]
  version?: string | null
}

/** Heartbeats older than this are deleted on every beat (old deployments' worker ids). */
export const HEARTBEAT_RETENTION_HOURS = 24

/** Records that `workerId` is alive now (and forgets workers not seen for a day). */
export async function beat(db: Db, input: BeatInput): Promise<void> {
  const types = [...new Set(input.types)]
  await db.query(
    `insert into public.worker_heartbeats (worker_id, types, version) values ($1, $2::text[], $3)
     on conflict (worker_id) do update set types = excluded.types, version = excluded.version, last_seen_at = now()`,
    [input.workerId.slice(0, 200), types, input.version ? input.version.slice(0, 100) : null],
  )
  await db.query(`delete from public.worker_heartbeats where last_seen_at < now() - make_interval(hours => $1)`, [HEARTBEAT_RETENTION_HOURS])
}

/** Removes a worker's row (graceful shutdown), so /setup does not count it as running. */
export async function remove(db: Db, workerId: string): Promise<void> {
  await db.query('delete from public.worker_heartbeats where worker_id = $1', [workerId])
}

/** Every heartbeat, most recent first. */
export async function list(db: Db): Promise<HeartbeatRow[]> {
  const rows = await db.query(
    `select worker_id, types, last_seen_at, version, started_at, created_at,
            greatest(0, extract(epoch from (now() - last_seen_at)))::float8 as age_sec
       from public.worker_heartbeats
      order by last_seen_at desc
      limit 200`,
  )
  return camelRows<HeartbeatRow>(rows).map((r) => ({ ...r, ageSec: Math.round(toNumber(r.ageSec)) }))
}
