// Maps errors to tool results. AppError messages from @app/services are neutral and safe to show;
// we add what the AI should do next (which field to fix, by how much, which tool to call).
// Anything that is not an AppError becomes a generic message (and is logged, redacted).

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { isAppError, type AppError, type ErrorCode } from '@app/core/errors'
import type { Logger } from '@app/core/log'
import { PLATFORM_LABELS, isPlatform } from '@app/core/types'
import { fail, toJson } from './results'

/** One problem the AI can fix: where, what, and (for limits) by how much. */
export interface Problem {
  path?: string
  message: string
  limit?: number
  actual?: number
}

const LABEL: Record<ErrorCode, string> = {
  bad_request: 'Bad request',
  validation: 'Invalid input',
  unauthorized: 'Not signed in',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  conflict: 'Conflict',
  limit_exceeded: 'Limit reached',
  cap_reached: 'Platform cap reached',
  payment_required: 'Account on hold',
  rate_limited: 'Too many requests',
  unavailable: 'Temporarily unavailable',
  internal: 'Server error',
}

/** Detail keys that are safe to hand to the model (never provider internals). */
const SAFE_DETAIL_KEYS = [
  'reason',
  'limit',
  'used',
  'remaining',
  'requested',
  'platform',
  'cap',
  'suggestedAt',
  'currentRevision',
  'problems',
  'meter',
] as const

export const GENERIC_ERROR = 'Something went wrong on our side. Please try again in a minute.'

function overBy(p: Pick<Problem, 'limit' | 'actual'>): string {
  if (typeof p.limit !== 'number' || typeof p.actual !== 'number' || p.actual <= p.limit) return ''
  return ` That is ${(p.actual - p.limit).toLocaleString('en-US')} over the limit of ${p.limit.toLocaleString('en-US')}.`
}

export function problemLine(p: Problem): string {
  const prefix = p.path ? `${p.path}: ` : ''
  return `- ${prefix}${p.message}${overBy(p)}`
}

/** Problems from AppError details: zod field issues ({ path, message }) or platform issues. */
function problemsFromDetails(details: unknown): Problem[] {
  if (!details || typeof details !== 'object') return []
  const issues = (details as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return []
  const out: Problem[] = []
  for (const raw of issues.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const i = raw as Record<string, unknown>
    if (typeof i.message !== 'string') continue
    const platform = isPlatform(i.platform) ? PLATFORM_LABELS[i.platform] : undefined
    const field = typeof i.field === 'string' ? i.field : undefined
    const path = typeof i.path === 'string' && i.path !== '' ? i.path : platform ? `${platform}${field ? ` ${field}` : ''}` : undefined
    out.push({
      ...(path ? { path } : {}),
      message: i.message,
      ...(typeof i.limit === 'number' ? { limit: i.limit } : {}),
      ...(typeof i.actual === 'number' ? { actual: i.actual } : {}),
    })
  }
  return out
}

function safeDetails(details: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!details || typeof details !== 'object') return out
  const d = details as Record<string, unknown>
  for (const key of SAFE_DETAIL_KEYS) if (d[key] !== undefined) out[key] = toJson(d[key])
  return out
}

function nextStep(err: AppError): string | null {
  const reason = typeof err.details?.reason === 'string' ? err.details.reason : undefined
  switch (err.code) {
    case 'validation':
      return 'Fix the fields above and call the tool again.'
    case 'not_found':
      return 'Check the id: use list_accounts (brands and accounts), list_drafts (drafts) or post_status to find valid ids.'
    case 'conflict':
      if (reason === 'not_approved') {
        return 'The draft needs a person\'s approval first: call approve_draft so the user can approve it, then schedule it.'
      }
      if (reason === 'stale') return 'The draft changed. Call approve_draft again to show the current version.'
      return null
    case 'cap_reached': {
      const at = err.details?.suggestedAt
      const when = at instanceof Date ? at.toISOString() : typeof at === 'string' ? at : null
      return when ? `The earliest free slot is ${when}. Call schedule_post again with at="${when}" or a later time.` : 'Pick a later time.'
    }
    case 'forbidden':
      return reason === 'wrong_channel' || reason === 'not_human' ? 'Only the user can approve, in the approval card or the web app.' : null
    case 'payment_required':
      return 'The user can manage their account and brands in the web app.'
    case 'rate_limited':
    case 'unavailable':
      return 'Try again in a minute.'
    default:
      return null
  }
}

/**
 * The message the model (and the user, through the AI app) sees. Account holds are stated
 * neutrally: the web app's wording asks people to upgrade or choose a plan, which AI app
 * directories do not allow inside the conversation (docs/research/mcp.md §6).
 */
export function modelMessage(err: AppError): string {
  if (err.code !== 'payment_required') return err.message
  const d = err.details ?? {}
  if (d.reason === 'brand_suspended') return 'This brand is paused because the plan allows fewer brands.'
  if (d.reason === 'trial_ended') return 'The free trial has ended.'
  switch (d.status) {
    case 'past_due':
      return 'Clipping and rendering are paused because of a payment issue.'
    case 'canceled':
      return 'The subscription has ended.'
    case 'unpaid':
      return 'The account is on hold for an unpaid invoice.'
    default:
      return 'The account has no active plan.'
  }
}

/** An AppError as a tool error result. */
export function appErrorResult(err: AppError): CallToolResult {
  const problems = problemsFromDetails(err.details)
  const message = modelMessage(err)
  const lines = [`${LABEL[err.code]}: ${message}`]
  if (problems.length > 0) lines.push(...problems.map(problemLine))
  const step = nextStep(err)
  if (step) lines.push(step)
  return fail(lines.join('\n'), {
    code: err.code,
    message,
    ...safeDetails(err.details),
    ...(problems.length > 0 ? { issues: problems } : {}),
  })
}

/** Any thrown value as a tool error result (unknown errors are logged and hidden). */
export function errorResult(error: unknown, log?: Logger, context: Record<string, unknown> = {}): CallToolResult {
  if (isAppError(error)) {
    if (error.code === 'internal' || error.code === 'unavailable') log?.warn('mcp tool failed', { ...context, code: error.code, err: error })
    return appErrorResult(error)
  }
  log?.error('mcp tool crashed', { ...context, err: error instanceof Error ? error : String(error) })
  return fail(`${LABEL.internal}: ${GENERIC_ERROR}`, { code: 'internal', message: GENERIC_ERROR })
}

/** Zod issues as problems (path "a.b.0", never the offending values). */
export function zodProblems(error: z.ZodError): Problem[] {
  return error.issues.map((issue) => ({
    ...(issue.path.length > 0 ? { path: issue.path.map((p) => String(p)).join('.') } : {}),
    message: issue.message,
  }))
}

/** Invalid tool arguments → a tool error that lists every field to fix. */
export function invalidArguments(tool: string, problems: readonly Problem[]): CallToolResult {
  const shown = problems.slice(0, 10)
  const more = problems.length > shown.length ? [`- (and ${problems.length - shown.length} more)`] : []
  const message = `Invalid arguments for ${tool}.`
  return fail([`${LABEL.validation}: ${message}`, ...shown.map(problemLine), ...more, 'Fix these fields and call the tool again.'].join('\n'), {
    code: 'validation',
    message,
    issues: shown,
  })
}
