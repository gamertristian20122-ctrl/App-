// Finishes a browser upload: services.media checks the stored object against what was declared
// (size and type), then images become ready and videos/audio go to the ingest worker.
// Body (multipart uploads only): { uploadId, parts: [{ partNumber, etag }] }.

import { getRuntime } from '@/lib/server/deps'
import { crossOrigin, errorResponse, isSameOrigin, json, readBody, unavailable } from '@/lib/server/http'
import { notSignedIn, userFromRequest } from '@/lib/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  const { services, config, log } = rt
  if (!isSameOrigin(req, config.APP_URL)) return crossOrigin()
  const user = await userFromRequest(req)
  if (!user) return notSignedIn()
  const { id } = await ctx.params

  const body = await readBody(req, 1024 * 1024, { json: true, form: false })
  if (!body.ok) return body.response
  try {
    const result = await services.media.completeUpload(user.id, id, body.data, { via: 'web' })
    return json(result)
  } catch (error) {
    return errorResponse(error, log)
  }
}
