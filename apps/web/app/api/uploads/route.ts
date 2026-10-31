// Starts a browser upload: validates the file (type, size, rights attestation for clip sources)
// and the storage allowance through services.media, and returns a presigned PUT (or multipart
// part URLs above 5 GB). Body: { purpose?: 'post' | 'clip_source', brandId?, filename,
// contentType, bytes, rightsAttested? }.

import { AppError } from '@app/core/errors'
import { getRuntime } from '@/lib/server/deps'
import { crossOrigin, errorResponse, isSameOrigin, json, readBody, unavailable } from '@/lib/server/http'
import { notSignedIn, userFromRequest } from '@/lib/server/session'
import { enumField } from '@/lib/server/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
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

  const body = await readBody(req, 8192, { json: true, form: false })
  if (!body.ok) return body.response
  const { purpose: rawPurpose, ...upload } = body.data
  const purpose = enumField(rawPurpose, ['post', 'clip_source'] as const, 'post')
  if (!purpose.ok) return errorResponse(new AppError('validation', 'purpose must be "post" or "clip_source".'))

  try {
    const result = await services.media.createUpload(user.id, upload, { purpose: purpose.value, via: 'web' })
    return json(result, { status: 201 })
  } catch (error) {
    return errorResponse(error, log)
  }
}
