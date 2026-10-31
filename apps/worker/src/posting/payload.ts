import type { JobRow, JobType } from '@app/core'
import { parseJobPayload, type JobPayload } from '@app/services'
import { PermanentJobError, safeErrorMessage } from '../errors'

/** The job's payload validated for its type (zod schemas in @app/services). Invalid → permanent failure. */
export function payloadOf<T extends JobType>(type: T, job: JobRow): JobPayload<T> {
  if (job.type !== type) throw new PermanentJobError(`Expected a ${type} job, got ${job.type}.`)
  try {
    return parseJobPayload(type, job.payload)
  } catch (error) {
    throw new PermanentJobError(safeErrorMessage(error, `Invalid ${type} payload.`))
  }
}
