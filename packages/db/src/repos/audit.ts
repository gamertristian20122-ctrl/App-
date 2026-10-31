import type { Actor } from '@app/core/types'
import { camelRow, camelRows, clampLimit, json, stripSecretKeys } from '../sql'
import type { Db } from '../types'

export interface AuditRow {
  id: string
  userId: string | null
  actor: Actor
  action: string
  subjectType: string | null
  subjectId: string | null
  meta: Record<string, unknown>
  createdAt: Date
}

const map = (row: Record<string, unknown> | null): AuditRow | null => (row ? camelRow<AuditRow>(row) : null)

export interface AuditInput {
  userId?: string | null
  actor: Actor
  /** e.g. "draft.approved", "post.rescheduled", "brand.created". */
  action: string
  subjectType?: string | null
  subjectId?: string | null
  /** Never secrets: credential-like keys are dropped. */
  meta?: Record<string, unknown>
}

export async function record(db: Db, input: AuditInput): Promise<AuditRow> {
  const row = await db.one(
    `insert into public.audit_log (user_id, actor, action, subject_type, subject_id, meta)
     values ($1, $2::public.actor, $3, $4, $5, $6::text::jsonb)
     returning *`,
    [
      input.userId ?? null,
      input.actor,
      input.action,
      input.subjectType ?? null,
      input.subjectId ?? null,
      json(stripSecretKeys(input.meta ?? {})),
    ],
  )
  return map(row) as AuditRow
}

export interface ListAuditOptions {
  subjectType?: string
  subjectId?: string
  action?: string
  limit?: number
}

/** A user's audit entries, newest first. */
export async function list(db: Db, userId: string, options: ListAuditOptions = {}): Promise<AuditRow[]> {
  const rows = await db.query(
    `select * from public.audit_log
      where user_id = $1
        and ($2::text is null or subject_type = $2)
        and ($3::text is null or subject_id = $3)
        and ($4::text is null or action = $4)
      order by created_at desc, id desc
      limit $5`,
    [userId, options.subjectType ?? null, options.subjectId ?? null, options.action ?? null, clampLimit(options.limit, 100, 1000)],
  )
  return camelRows<AuditRow>(rows)
}
