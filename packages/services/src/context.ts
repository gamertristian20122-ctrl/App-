// Shared plumbing for every service module: dependencies, transactions, error translation and the
// ownership guards ("load this id for this user or throw not_found").

import { AppError, isAppError, parseOrThrow, type ErrorDetails } from '@app/core/errors'
import { scrubString, silentLogger, type Logger } from '@app/core/log'
import type { Clock, ObjectStorage, PostingProvider } from '@app/core/ports'
import { systemClock } from '@app/core/time'
import { IdSchema } from '@app/core/validation'
import { bindRepos, dbErrorToAppError, type BoundRepos, type Db } from '@app/db'
import { resolveServicesConfig, type ServicesConfig } from './config'

export interface ServicesDeps {
  db: Db
  provider: PostingProvider
  storage: ObjectStorage
  clock?: Clock
  config?: Partial<ServicesConfig>
  log?: Logger
}

/** What every module receives. */
export interface Ctx {
  db: Db
  provider: PostingProvider
  storage: ObjectStorage
  clock: Clock
  config: ServicesConfig
  log: Logger
  /** Repositories bound to the root handle (outside transactions). */
  repos: BoundRepos
  /** Runs fn in a transaction with repositories bound to it. Never touch ctx.db / ctx.repos inside. */
  tx<T>(fn: (r: BoundRepos, db: Db) => Promise<T>): Promise<T>
  now(): Date
}

export function createCtx(deps: ServicesDeps): Ctx {
  const clock = deps.clock ?? systemClock
  return {
    db: deps.db,
    provider: deps.provider,
    storage: deps.storage,
    clock,
    config: resolveServicesConfig(deps.config),
    log: deps.log ?? silentLogger,
    repos: bindRepos(deps.db),
    tx: (fn) => deps.db.tx((tx) => fn(bindRepos(tx), tx)),
    now: () => clock.now(),
  }
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** DbError → AppError (unique → conflict, FK → not_found, ...); AppErrors and others pass through. */
export function translateError(error: unknown): unknown {
  if (isAppError(error)) return error
  return dbErrorToAppError(error) ?? error
}

type AnyFn = (...args: never[]) => unknown

/** Wraps every function of a module so database errors surface as AppErrors. */
export function withErrors<T extends Record<string, unknown>>(mod: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') {
      out[name] = value
      continue
    }
    const fn = value as AnyFn
    out[name] = (...args: never[]) => {
      let result: unknown
      try {
        result = fn(...args)
      } catch (error) {
        throw translateError(error)
      }
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          throw translateError(error)
        })
      }
      return result
    }
  }
  return out as T
}

/** Parses external input with a zod schema or throws AppError('validation') listing the issues. */
export const fromZod = parseOrThrow

export const notFound = (what: string, details?: ErrorDetails): AppError =>
  new AppError('not_found', `${what} was not found.`, details)

export const validation = (message: string, details?: ErrorDetails): AppError =>
  new AppError('validation', message, details)

export const conflict = (message: string, details?: ErrorDetails): AppError => new AppError('conflict', message, details)

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

/**
 * Normalises an id we received (lower-case UUID). A malformed id can never belong to the user, so
 * it is reported as not_found (same answer as another user's id: no existence oracle).
 */
export function id(value: unknown, what: string): string {
  const parsed = IdSchema.safeParse(value)
  if (!parsed.success) throw notFound(what)
  return parsed.data
}

/** The signed-in user's id (comes from auth, still validated). */
export function userIdOf(value: unknown): string {
  const parsed = IdSchema.safeParse(value)
  if (!parsed.success) throw new AppError('unauthorized', 'Sign in again.')
  return parsed.data
}

// ---------------------------------------------------------------------------------------------
// Ownership guards (every id is loaded with the user's id; foreign ids → not_found)
// ---------------------------------------------------------------------------------------------

export async function requireBrand(r: BoundRepos, userId: string, brandId: unknown) {
  const brand = await r.brands.get(userId, id(brandId, 'Brand'))
  if (!brand) throw notFound('Brand')
  return brand
}

/** A brand that can take new work (not archived or suspended). */
export async function requireActiveBrand(r: BoundRepos, userId: string, brandId: unknown) {
  const brand = await requireBrand(r, userId, brandId)
  if (brand.status === 'archived') throw conflict('This brand is archived. Restore it first.', { brandId: brand.id })
  if (brand.status === 'suspended') {
    throw new AppError(
      'payment_required',
      'This brand is paused because your plan allows fewer brands. Upgrade or archive another brand to resume it.',
      { brandId: brand.id },
    )
  }
  return brand
}

export async function requireDraft(r: BoundRepos, userId: string, draftId: unknown) {
  const draft = await r.drafts.get(userId, id(draftId, 'Draft'))
  if (!draft) throw notFound('Draft')
  return draft
}

export async function requireMedia(r: BoundRepos, userId: string, mediaId: unknown) {
  const media = await r.media.get(userId, id(mediaId, 'Media'))
  if (!media || media.status === 'deleted') throw notFound('Media')
  return media
}

export async function requirePost(r: BoundRepos, userId: string, postId: unknown) {
  const post = await r.posts.get(userId, id(postId, 'Post'))
  if (!post) throw notFound('Post')
  return post
}

export async function requireClip(r: BoundRepos, userId: string, clipId: unknown) {
  const clip = await r.clips.get(userId, id(clipId, 'Clip'))
  if (!clip) throw notFound('Clip')
  return clip
}

export async function requireAccount(r: BoundRepos, userId: string, accountId: unknown) {
  const account = await r.accounts.get(userId, id(accountId, 'Connected account'))
  if (!account) throw notFound('Connected account')
  return account
}

/** Loads the user row; a missing row means the app user was never created. */
export async function requireUser(r: BoundRepos, userId: string, lock = false) {
  const user = lock ? await r.users.lockForUpdate(userId) : await r.users.get(userId)
  if (!user) throw new AppError('unauthorized', 'Your account is not set up yet. Sign in again.')
  return user
}

/** A short, safe error string from anything thrown (for rows and job errors; never secrets). */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (isAppError(error)) return scrubString(error.message).slice(0, 1_000)
  if (error instanceof Error && error.message) return scrubString(error.message).slice(0, 500)
  if (typeof error === 'string' && error) return scrubString(error).slice(0, 500)
  return fallback
}
