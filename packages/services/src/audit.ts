// Audit log: who did what to which subject. Meta never holds secrets (credential-like keys are
// dropped by the repository and refused by a CHECK).

import type { Actor } from '@app/core/types'
import { ActorSchema } from '@app/core/types'
import type { BoundRepos } from '@app/db'
import { userIdOf, withErrors, type Ctx } from './context'

export interface AuditEvent {
  actor: Actor
  action: string
  subjectType?: string
  subjectId?: string
  meta?: Record<string, unknown>
}

/** Records inside the caller's transaction. */
export async function auditIn(r: BoundRepos, userId: string | null, event: AuditEvent) {
  return r.audit.record({
    userId,
    actor: ActorSchema.parse(event.actor),
    action: event.action.slice(0, 100),
    subjectType: event.subjectType ?? null,
    subjectId: event.subjectId ?? null,
    meta: event.meta ?? {},
  })
}

export function createAuditService(ctx: Ctx) {
  return withErrors({
    async record(userId: string, event: AuditEvent) {
      return auditIn(ctx.repos, userIdOf(userId), event)
    },

    /** The user's audit entries, newest first. */
    async list(userId: string, options: { subjectType?: string; subjectId?: string; action?: string; limit?: number } = {}) {
      return ctx.repos.audit.list(userIdOf(userId), {
        ...(options.subjectType ? { subjectType: options.subjectType } : {}),
        ...(options.subjectId ? { subjectId: options.subjectId } : {}),
        ...(options.action ? { action: options.action } : {}),
        limit: options.limit ?? 50,
      })
    },
  })
}

export type AuditService = ReturnType<typeof createAuditService>
