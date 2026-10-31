// Who is calling a route handler, and creating the app user at sign-in. Server-only.

import { users as usersRepo } from '@app/db'
import type { ServicesFromEnv } from '@app/services'
import { getUserFromRequest, type CurrentUser } from '@/lib/auth'
import { authDeps } from './deps'
import { errorJson } from './http'

/** The signed-in user of a plain Request (dev cookie or Supabase session cookies). */
export function userFromRequest(req: Request): Promise<CurrentUser | null> {
  return getUserFromRequest(req, authDeps())
}

export const notSignedIn = () => errorJson(401, 'unauthorized', 'Sign in to continue.')

/**
 * Creates (or refreshes) the app user at sign-in and starts the trial once. With the dev login on
 * a local database (PGlite or a local Postgres with the Supabase stand-ins) the auth.users row
 * is created first; with Supabase Auth it already exists.
 */
export async function ensureSignedInUser(rt: ServicesFromEnv, user: CurrentUser, options: { devLogin: boolean }): Promise<void> {
  const local = rt.db.driver === 'pglite' || rt.config.APP_ENV === 'development' || rt.config.APP_ENV === 'test'
  if (options.devLogin && local) await usersRepo.devEnsureAuthUser(rt.db, user.id, user.email)
  await rt.services.users.ensureUser(user.id, { email: user.email })
}
