// Deployment-wide settings the owner's /setup actions create (not user-scoped). Secret values are
// encrypted by the caller before they get here (`encrypted: true`); this module never sees a key.

import { camelRow } from '../sql'
import type { Db } from '../types'

export interface AppSettingRow {
  key: string
  /** The stored text: a sealed (encrypted) string when `encrypted` is true. */
  value: string
  encrypted: boolean
  createdAt: Date
  updatedAt: Date
}

const KEY_RE = /^[a-z][a-z0-9_.:-]{0,99}$/

function checkKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error('Invalid setting key.')
  return key
}

const map = (row: Record<string, unknown> | null): AppSettingRow | null => (row ? camelRow<AppSettingRow>(row) : null)

export async function get(db: Db, key: string): Promise<AppSettingRow | null> {
  return map(await db.one('select * from public.app_settings where key = $1', [checkKey(key)]))
}

/** Inserts or replaces a setting. */
export async function set(db: Db, key: string, value: string, options: { encrypted?: boolean } = {}): Promise<AppSettingRow> {
  const row = await db.one(
    `insert into public.app_settings (key, value, encrypted) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, encrypted = excluded.encrypted
     returning *`,
    [checkKey(key), value, options.encrypted ?? false],
  )
  return map(row) as AppSettingRow
}

/** Deletes a setting; true when it existed. */
export async function remove(db: Db, key: string): Promise<boolean> {
  const rows = await db.query('delete from public.app_settings where key = $1 returning key', [checkKey(key)])
  return rows.length > 0
}
