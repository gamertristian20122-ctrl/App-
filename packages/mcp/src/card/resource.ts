// The approval card resource (ui://approval-card/v1): MCP Apps HTML with a minimal CSP. The only
// outside origins it may load from are the media origins (presigned preview URLs); it makes no
// network requests itself (connectDomains is empty: buttons go through the host's tools/call).

import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { APPROVAL_CARD_URI, MCP_APP_MIME_TYPE } from '../constants'
import { appUrl, type McpContext } from '../context'
import { APPROVAL_CARD_HTML } from './html'

export const APPROVAL_CARD_TITLE = 'Approval card'
export const APPROVAL_CARD_DESCRIPTION =
  'Per-platform preview of a draft post with Approve, Edit and Reject buttons. Only the user can approve.'

// A syntactically valid key that is never written: presigning it reveals the storage URL origin.
const PROBE_KEY = 'users/00000000-0000-4000-8000-000000000000/uploads/origin-probe.jpg'

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.origin : null
  } catch {
    return null
  }
}

/** Origins of media preview URLs (explicit config, else the storage's presigned URL origin). */
export async function mediaOrigins(ctx: McpContext): Promise<string[]> {
  const configured = (ctx.mediaOrigins ?? []).map(originOf).filter((o): o is string => o !== null)
  if (configured.length > 0) return [...new Set(configured)]
  try {
    const probe = await ctx.services.deps.storage.presignGet(PROBE_KEY, 60)
    const origin = originOf(probe)
    return origin ? [origin] : []
  } catch {
    return []
  }
}

export async function readApprovalCard(ctx: McpContext): Promise<ReadResourceResult> {
  const media = await mediaOrigins(ctx)
  const app = originOf(appUrl(ctx))
  return {
    contents: [
      {
        uri: APPROVAL_CARD_URI,
        mimeType: MCP_APP_MIME_TYPE,
        text: APPROVAL_CARD_HTML,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: media },
            prefersBorder: true,
          },
          'openai/widgetDescription': APPROVAL_CARD_DESCRIPTION,
          'openai/widgetPrefersBorder': true,
          'openai/widgetCSP': {
            connect_domains: [],
            resource_domains: media,
            ...(app ? { redirect_domains: [app] } : {}),
          },
        },
      },
    ],
  }
}
