// Users: the app user row (created on first sign-in, with the 7-day Starter trial) and entitlements.

import { z } from 'zod'
import { TRIAL } from '@app/core/plans'
import { addDays } from '@app/core/time'
import { TimezoneSchema, lineSchema } from '@app/core/validation'
import type { UserRow } from '@app/db'
import { auditIn } from './audit'
import { requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { userEntitlements, type UserEntitlements } from './entitlements'

const EnsureUserSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/, 'Must be an email address.'),
  displayName: lineSchema(0, 200).nullish(),
  timezone: TimezoneSchema.optional(),
})

const ProfilePatchSchema = z
  .strictObject({ displayName: lineSchema(0, 200).nullish(), timezone: TimezoneSchema.optional() })
  .refine((v) => v.displayName !== undefined || v.timezone !== undefined, 'Nothing to change.')

export interface UserSummary {
  user: UserRow
  entitlements: UserEntitlements
}

export function createUsersService(ctx: Ctx) {
  return withErrors({
    /**
     * Creates the app user on first sign-in (the auth user must exist) and starts the 7-day
     * Starter trial once; on later sign-ins refreshes the email. Safe to call on every request.
     */
    async ensureUser(userId: string, input: { email: string; displayName?: string | null; timezone?: string }): Promise<UserRow> {
      const uid = userIdOf(userId)
      const parsed = EnsureUserSchema.safeParse(input)
      if (!parsed.success) throw validation('A valid email address is required.')
      const data = parsed.data
      return ctx.tx(async (r) => {
        await r.users.ensure(uid, {
          email: data.email,
          displayName: data.displayName ?? null,
          ...(data.timezone ? { timezone: data.timezone } : {}),
        })
        const user = await requireUser(r, uid, true)
        const neverSubscribed =
          user.subscriptionStatus === 'none' && user.plan === null && user.trialEndsAt === null && !user.stripeSubscriptionId
        if (!neverSubscribed) return user
        const trialEndsAt = addDays(ctx.now(), TRIAL.days)
        const updated = await r.users.updateBilling(uid, { plan: TRIAL.plan, subscriptionStatus: 'trialing', trialEndsAt })
        await auditIn(r, uid, {
          actor: 'system',
          action: 'user.trial_started',
          subjectType: 'user',
          subjectId: uid,
          meta: { trialEndsAt: trialEndsAt.toISOString(), plan: TRIAL.plan },
        })
        return updated ?? user
      })
    },

    async get(userId: string): Promise<UserRow> {
      return requireUser(ctx.repos, userIdOf(userId))
    },

    /** Limits and permissions right now (plan + add-ons + status + trial) with the usage period. */
    async getEntitlements(userId: string): Promise<UserEntitlements> {
      const user = await requireUser(ctx.repos, userIdOf(userId))
      return userEntitlements(user, ctx.now())
    },

    async summary(userId: string): Promise<UserSummary> {
      const user = await requireUser(ctx.repos, userIdOf(userId))
      return { user, entitlements: userEntitlements(user, ctx.now()) }
    },

    async updateProfile(userId: string, patch: { displayName?: string | null; timezone?: string }): Promise<UserRow> {
      const uid = userIdOf(userId)
      const parsed = ProfilePatchSchema.safeParse(patch)
      if (!parsed.success) throw validation(parsed.error.issues[0]?.message ?? 'Invalid profile.')
      const row = await ctx.repos.users.updateProfile(uid, {
        ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName || null } : {}),
        ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
      })
      if (!row) return requireUser(ctx.repos, uid)
      return row
    },
  })
}

export type UsersService = ReturnType<typeof createUsersService>
