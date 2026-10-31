import { connectAccount, listAccounts } from './accounts'
import { approvalDecide, approvalEditVariant, approveDraft, createDraft, listDrafts, postStatus, schedulePost } from './drafts'
import { getAnalytics, importPastPosts, saveVoiceProfile } from './insights'
import { getTranscript, makeClips, renderCarousel, renderVideo } from './media'
import { publishVideo, renderCodeVideo, uploadMedia } from './publish'
import type { ToolDef } from './types'

export type { ToolDef, ToolAnnotationsFull } from './types'

/** Every tool, in the fixed order tools/list returns them (the spec asks for a stable order). */
export const TOOLS: readonly ToolDef[] = [
  connectAccount,
  listAccounts,
  createDraft,
  listDrafts,
  approveDraft,
  schedulePost,
  postStatus,
  getTranscript,
  makeClips,
  importPastPosts,
  saveVoiceProfile,
  renderCarousel,
  renderVideo,
  getAnalytics,
  uploadMedia,
  renderCodeVideo,
  publishVideo,
  approvalDecide,
  approvalEditVariant,
]

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]))
