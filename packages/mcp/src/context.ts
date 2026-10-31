// What every tool, prompt and resource receives: the signed-in user and the services. The web app
// builds one per request after verifying the OAuth bearer token (services.oauth.verifyAccessToken).

import type { Logger } from '@app/core/log'
import type { Services } from '@app/services'

export interface McpContext {
  services: Services
  /** The signed-in user (from the verified OAuth bearer token). Every service call is scoped to it. */
  userId: string
  /** Public origin of the web app, e.g. "https://app.example.com" (web fallback links). */
  baseUrl: string
  log?: Logger
  /**
   * Extra origins allowed in the `Origin` header of HTTP requests (DNS-rebinding protection).
   * The origin of `baseUrl` is always allowed; requests without an `Origin` header are allowed.
   */
  allowedOrigins?: readonly string[]
  /**
   * Origins the approval card may load media previews from (its CSP `resourceDomains`). Defaults
   * to the origin of the storage's presigned URLs.
   */
  mediaOrigins?: readonly string[]
}

export const SERVER_NAME = 'social-mcp'
export const SERVER_VERSION = '1.0.0'

/** baseUrl without a trailing slash. */
export function appUrl(ctx: Pick<McpContext, 'baseUrl'>): string {
  return ctx.baseUrl.replace(/\/+$/, '')
}
