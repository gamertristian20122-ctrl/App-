// Row mappers shared by several repositories (not part of the repos namespace).

import { camelRow, toNumberOrNull } from '../sql'
import type { MediaRow } from './media'

export function mapMedia(row: Record<string, unknown>): MediaRow {
  const r = camelRow<MediaRow>(row)
  return { ...r, bytes: toNumberOrNull(row.bytes) }
}
