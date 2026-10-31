import type { Db } from '../types'
import * as accounts from './accounts'
import * as analytics from './analytics'
import * as approvalNonces from './approvalNonces'
import * as audit from './audit'
import * as brands from './brands'
import * as clips from './clips'
import * as drafts from './drafts'
import * as jobs from './jobs'
import * as maintenance from './maintenance'
import * as media from './media'
import * as oauth from './oauth'
import * as pastPosts from './pastPosts'
import * as posts from './posts'
import * as stripeEvents from './stripeEvents'
import * as transcripts from './transcripts'
import * as usage from './usage'
import * as users from './users'
import * as voice from './voice'

export {
  accounts,
  analytics,
  approvalNonces,
  audit,
  brands,
  clips,
  drafts,
  jobs,
  maintenance,
  media,
  oauth,
  pastPosts,
  posts,
  stripeEvents,
  transcripts,
  usage,
  users,
  voice,
}

/** Every repository namespace. Functions take (db, ...args). */
export const repos = {
  accounts,
  analytics,
  approvalNonces,
  audit,
  brands,
  clips,
  drafts,
  jobs,
  maintenance,
  media,
  oauth,
  pastPosts,
  posts,
  stripeEvents,
  transcripts,
  usage,
  users,
  voice,
}

type BoundModule<M> = {
  [K in keyof M as M[K] extends (db: Db, ...args: never[]) => unknown ? K : never]: M[K] extends (
    db: Db,
    ...args: infer A
  ) => infer R
    ? (...args: A) => R
    : never
}

export type BoundRepos = { [K in keyof typeof repos]: BoundModule<(typeof repos)[K]> }

/**
 * The repositories with `db` pre-applied, e.g. `const r = bindRepos(tx); await r.drafts.get(userId, id)`.
 * Cheap: bind per transaction.
 */
export function bindRepos(db: Db): BoundRepos {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, mod] of Object.entries(repos)) {
    const bound: Record<string, unknown> = {}
    for (const [fnName, fn] of Object.entries(mod as Record<string, unknown>)) {
      if (typeof fn === 'function') {
        bound[fnName] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(db, ...args)
      }
    }
    out[name] = bound
  }
  return out as unknown as BoundRepos
}
