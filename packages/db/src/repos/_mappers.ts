// Row mappers shared by several repositories (not part of the repos namespace).

import { isPlatform, type Platform } from '@app/core/types'
import { camelRow, toNumberOrNull } from '../sql'
import type { MediaRow } from './media'

export function mapMedia(row: Record<string, unknown>): MediaRow {
  const r = camelRow<MediaRow>(row)
  return { ...r, bytes: toNumberOrNull(row.bytes) }
}

/**
 * Postgres arrays of a custom enum arrive as a JS array (postgres.js, which loads array types) or
 * as the text form "{a,b}" (PGlite): both become a list of known platforms.
 */
export function platformList(value: unknown): Platform[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.replace(/^\{|\}$/g, '').split(',').map((v) => v.trim().replace(/^"|"$/g, ''))
      : []
  return items.filter((v): v is Platform => isPlatform(v))
}

