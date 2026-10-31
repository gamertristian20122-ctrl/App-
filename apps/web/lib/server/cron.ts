// Vercel Cron authentication: Vercel sends "Authorization: Bearer <CRON_SECRET>". Server-only.

import { safeEqual } from '@app/core/crypto'
import { errorJson } from './http'

/** null when the request may run the cron job; otherwise the response to send. */
export function checkCronAuth(req: Request, secret: string | undefined): Response | null {
  if (!secret) return errorJson(503, 'unavailable', 'Scheduled jobs are not configured.')
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match?.[1] || !safeEqual(match[1], secret)) return errorJson(401, 'unauthorized', 'Not allowed.')
  return null
}
