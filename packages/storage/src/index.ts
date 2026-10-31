// @app/storage: ObjectStorage implementations — R2 (S3 API), FsStorage (local dev) and MemoryStorage
// (tests) — plus key helpers, multipart support and the HTTP handler for local signed URLs.
// Server-only (uses node:fs and node:crypto).

export * from './keys'
export * from './errors'
export {
  MAX_SINGLE_PUT_BYTES,
  MAX_PRESIGN_TTL_SEC,
  DEFAULT_PUT_TTL_SEC,
  ContentTypeSchema,
} from './validate'
export * from './multipart'
export * from './bucket'
export { R2Storage, createR2Client, r2Endpoint, mapS3Error, DEFAULT_MULTIPART_THRESHOLD_BYTES } from './r2'
export type { R2StorageConfig, R2StorageDeps, S3Like, Presigner } from './r2'
export { LocalStorageBase, type LocalStorageOptions, type LocalBackend, type LocalObject } from './local/base'
export { FsStorage, type FsStorageOptions } from './local/fs'
export { MemoryStorage, type MemoryStorageOptions } from './local/memory'
export { LocalUrlSigner, type LocalGrant, type LocalOp } from './local/signing'
export { createLocalStorageHandler, parseRange, type LocalStorageHandlerOptions } from './local/handler'
export * from './factory'
