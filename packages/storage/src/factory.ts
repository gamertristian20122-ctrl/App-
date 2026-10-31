// Builds the configured ObjectStorage from @app/core config (STORAGE_DRIVER = r2 | fs | memory).

import type { Config } from '@app/core/config'
import type { Logger } from '@app/core/log'
import type { Clock, ObjectStorage } from '@app/core/ports'
import { storageError } from './errors'
import { LocalStorageBase } from './local/base'
import { FsStorage } from './local/fs'
import { MemoryStorage } from './local/memory'
import type { MultipartStorage } from './multipart'
import { R2Storage, type S3Like } from './r2'

export type StorageDriverName = 'r2' | 'fs' | 'memory'

/** What every driver in this package provides. */
export type AppStorage = ObjectStorage & MultipartStorage & { readonly driver: StorageDriverName }

/** Path of the web route that serves the local drivers' signed URLs. */
export const DEV_STORAGE_PATH = '/api/dev-storage'

/**
 * Signing key for local URLs when SESSION_SECRET is unset. Only the fs/memory drivers use it, and
 * production refuses those drivers (config.ts), so it never protects real data.
 */
export const DEV_STORAGE_FALLBACK_SECRET = 'dev-storage-signing-secret-not-for-production'

export function devStorageBaseUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${DEV_STORAGE_PATH}`
}

export type StorageConfig = Pick<
  Config,
  | 'STORAGE_DRIVER'
  | 'STORAGE_FS_DIR'
  | 'APP_URL'
  | 'SESSION_SECRET'
  | 'R2_ACCOUNT_ID'
  | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY'
  | 'R2_BUCKET'
  | 'R2_ENDPOINT'
>

export interface StorageFactoryDeps {
  logger?: Logger
  clock?: Clock
  /** R2 only: replaces the S3 client used for requests (tests). */
  s3Client?: S3Like
}

export function createStorageFromConfig(config: StorageConfig, deps: StorageFactoryDeps = {}): AppStorage {
  const local = {
    baseUrl: devStorageBaseUrl(config.APP_URL),
    signingSecret: config.SESSION_SECRET ?? DEV_STORAGE_FALLBACK_SECRET,
    clock: deps.clock,
  }
  switch (config.STORAGE_DRIVER) {
    case 'r2': {
      if (!config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !config.R2_BUCKET) {
        throw storageError('invalid_input', 'R2 storage is not configured (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).')
      }
      return new R2Storage(
        {
          accountId: config.R2_ACCOUNT_ID,
          endpoint: config.R2_ENDPOINT,
          accessKeyId: config.R2_ACCESS_KEY_ID,
          secretAccessKey: config.R2_SECRET_ACCESS_KEY,
          bucket: config.R2_BUCKET,
        },
        { client: deps.s3Client, logger: deps.logger },
      )
    }
    case 'fs':
      return new FsStorage({ ...local, dir: config.STORAGE_FS_DIR })
    case 'memory':
      return new MemoryStorage(local)
    default:
      throw storageError('invalid_input', 'Unknown STORAGE_DRIVER.')
  }
}

/** True for FsStorage/MemoryStorage: the drivers whose URLs the dev-storage route must serve. */
export function isLocalStorage(storage: unknown): storage is LocalStorageBase {
  return storage instanceof LocalStorageBase
}
