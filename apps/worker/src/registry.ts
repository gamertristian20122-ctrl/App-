// Which handlers this process runs: WORKER_TYPES selects worker groups (posting, media); each job
// type belongs to one group (core JOB_GROUP) and is taken from that group's handler set.

import { JOB_GROUP, JOB_TYPES, type JobType, type Logger, type WorkerGroup } from '@app/core'
import type { Handler } from './types'

export type HandlerSets = Readonly<Record<WorkerGroup, Readonly<Record<string, Handler>>>>

export interface HandlerRegistry {
  handlers: Partial<Record<JobType, Handler>>
  /** Job types this process claims. */
  types: JobType[]
  /** Job types of the enabled groups that have no handler yet (never claimed, so they wait). */
  missing: JobType[]
}

export function buildRegistry(groups: readonly WorkerGroup[], sets: HandlerSets, logger?: Logger): HandlerRegistry {
  const enabled = new Set(groups)
  const handlers: Partial<Record<JobType, Handler>> = {}
  const missing: JobType[] = []
  for (const type of JOB_TYPES) {
    const group = JOB_GROUP[type]
    if (!enabled.has(group)) continue
    const handler = sets[group][type]
    if (typeof handler === 'function') handlers[type] = handler
    else missing.push(type)
  }
  for (const [group, set] of Object.entries(sets) as [WorkerGroup, Readonly<Record<string, Handler>>][]) {
    for (const key of Object.keys(set)) {
      const known = (JOB_TYPES as readonly string[]).includes(key)
      if (!known || JOB_GROUP[key as JobType] !== group) logger?.warn('ignoring a handler outside its worker group', { group, type: key })
    }
  }
  if (missing.length > 0) logger?.warn('job types without a handler in this worker', { types: missing })
  return { handlers, types: Object.keys(handlers) as JobType[], missing }
}
