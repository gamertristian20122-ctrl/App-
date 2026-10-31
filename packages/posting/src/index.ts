// @app/posting: PostingProvider implementations. upload-post/ is the ONLY code that may call
// Upload-Post; fake/ is for tests and local dev. Server-only (uses node:crypto).

import type { Config } from '@app/core/config'
import type { Logger } from '@app/core/log'
import type { Clock, PostingProvider } from '@app/core/ports'
import { FakePostingProvider, type FakePostingProviderOptions } from './fake'
import { UploadPostProvider, type FetchLike, type UploadPostProviderOptions } from './upload-post'

export * from './errors'
export * from './publish-input'
export * from './fake'
// The HTTP client is deliberately not exported: only the adapter talks to Upload-Post.
export {
  UploadPostProvider,
  UPLOAD_POST_DEFAULT_BASE_URL,
  CONNECT_PAGE_PLATFORMS,
  WEBHOOK_HEADERS,
  WEBHOOK_TOLERANCE_SEC,
  MAX_WEBHOOK_BYTES,
  accountsFromSocialAccounts,
  mapUploadStatus,
  normalizeMetrics,
  parseUploadPostWebhook,
  parseUploadPostWebhookPayload,
  platformFromRequestId,
  profileRefForBrand,
  requestIdFor,
  signUploadPostWebhook,
  verifyUploadPostSignature,
  type AccountStatusEvent,
  type ConnectPageBranding,
  type FetchLike,
  type IgnoredEvent,
  type ProviderDestination,
  type UploadCompletedEvent,
  type UploadPostProfile,
  type UploadPostProviderOptions,
  type UploadPostWebhookEvent,
  type VerifyWebhookInput,
  type WebhookHeaders,
} from './upload-post'

export type CreatePostingProviderOptions =
  | ({ kind: 'upload_post' } & UploadPostProviderOptions)
  | ({ kind: 'fake' } & FakePostingProviderOptions)

export function createPostingProvider(options: { kind: 'upload_post' } & UploadPostProviderOptions): UploadPostProvider
export function createPostingProvider(options: { kind: 'fake' } & FakePostingProviderOptions): FakePostingProvider
export function createPostingProvider(options: CreatePostingProviderOptions): PostingProvider
export function createPostingProvider(options: CreatePostingProviderOptions): PostingProvider {
  switch (options.kind) {
    case 'upload_post': {
      const { kind: _kind, ...rest } = options
      return new UploadPostProvider(rest)
    }
    case 'fake': {
      const { kind: _kind, ...rest } = options
      return new FakePostingProvider(rest)
    }
    default: {
      const kind: never = options
      throw new Error(`Unknown posting provider: ${String((kind as { kind?: unknown }).kind)}`)
    }
  }
}

export interface PostingDeps {
  fetch?: FetchLike
  clock?: Clock
  logger?: Logger
  /** Profile username prefix per environment (see UploadPostProviderOptions.profilePrefix). */
  profilePrefix?: string
  connectPage?: UploadPostProviderOptions['connectPage']
}

/** Builds the provider selected by POSTING_PROVIDER (web app and worker use this). */
export function createPostingProviderFromConfig(
  config: Pick<Config, 'POSTING_PROVIDER' | 'UPLOAD_POST_API_KEY' | 'UPLOAD_POST_BASE_URL'> &
    Partial<Pick<Config, 'UPLOAD_POST_PROFILE_PREFIX'>>,
  deps: PostingDeps = {},
): PostingProvider {
  if (config.POSTING_PROVIDER === 'upload_post') {
    return createPostingProvider({
      kind: 'upload_post',
      apiKey: config.UPLOAD_POST_API_KEY ?? '',
      baseUrl: config.UPLOAD_POST_BASE_URL,
      fetch: deps.fetch,
      clock: deps.clock,
      logger: deps.logger,
      profilePrefix: deps.profilePrefix ?? config.UPLOAD_POST_PROFILE_PREFIX,
      connectPage: deps.connectPage,
    })
  }
  return createPostingProvider({ kind: 'fake', clock: deps.clock })
}

/** UPLOAD_POST_WEBHOOK_SECRET may hold "current,previous" while rotating. */
export function webhookSecrets(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
