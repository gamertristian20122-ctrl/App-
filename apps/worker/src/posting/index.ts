import type { Handler } from '../types'
import { analyticsPull } from './analytics-pull'
import { checkPostStatus } from './check-post-status'
import { cleanup } from './cleanup'
import { importPastPosts } from './import-past-posts'
import { publishPost } from './publish-post'

/** Handlers for the "posting" worker group. */
export const postingHandlers: Record<string, Handler> = {
  publish_post: publishPost,
  check_post_status: checkPostStatus,
  analytics_pull: analyticsPull,
  import_past_posts: importPastPosts,
  cleanup,
}

export { analyticsPull, checkPostStatus, cleanup, importPastPosts, publishPost }
export { publishIdempotencyKey } from './publish-post'
