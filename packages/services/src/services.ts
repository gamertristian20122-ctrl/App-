// createServices: builds every service module around one set of dependencies.

import { createAccountsService } from './accounts'
import { createAnalyticsService } from './analytics'
import { createApprovalsService } from './approvals'
import { createAuditService } from './audit'
import { createBillingService } from './billing'
import { createBrandsService } from './brands'
import { createClipsService } from './clips'
import { createCtx, type Ctx, type ServicesDeps } from './context'
import { createDraftsService } from './drafts'
import { createImportsService } from './imports'
import { createJobsService } from './jobs'
import { createMaintenanceService } from './maintenance'
import { createMediaService } from './media'
import { createOAuthService } from './oauth'
import { createPostsService } from './posts'
import { createRendersService } from './renders'
import { createTranscriptsService } from './transcripts'
import { createUsageService } from './usage'
import { createUsersService } from './users'
import { createVoiceService } from './voice'

export function createServices(deps: ServicesDeps) {
  const ctx: Ctx = createCtx(deps)
  const draftsCore = createDraftsService(ctx)
  const approvals = createApprovalsService(ctx, { drafts: draftsCore })
  const accounts = createAccountsService(ctx)
  const posts = createPostsService(ctx)
  return {
    users: createUsersService(ctx),
    brands: createBrandsService(ctx),
    accounts,
    media: createMediaService(ctx),
    transcripts: createTranscriptsService(ctx),
    clips: createClipsService(ctx),
    /** drafts.approve is approvals.approve (a valid one-time nonce is always required). */
    drafts: { ...draftsCore, approve: approvals.approve },
    approvals,
    posts,
    voice: createVoiceService(ctx),
    imports: createImportsService(ctx),
    analytics: createAnalyticsService(ctx),
    usage: createUsageService(ctx),
    billing: createBillingService(ctx),
    jobs: createJobsService(ctx),
    renders: createRendersService(ctx),
    /** OAuth 2.1 authorization server for MCP clients (DCR, PKCE, rotation, bearer verification). */
    oauth: createOAuthService(ctx),
    audit: createAuditService(ctx),
    /** System-level: cleanup job, webhook lookups (not user-scoped). */
    maintenance: createMaintenanceService(ctx, { accounts, posts }),
    /** The dependencies the services were built with (worker convenience). */
    deps: { db: ctx.db, provider: ctx.provider, storage: ctx.storage, clock: ctx.clock, config: ctx.config, log: ctx.log },
  }
}

export type Services = ReturnType<typeof createServices>
