/** The approval card (MCP Apps UI resource). Versioned: hosts cache by URI. */
export const APPROVAL_CARD_URI = 'ui://approval-card/v1'

/** MCP Apps HTML profile (also what ChatGPT's Apps SDK expects for widget templates). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

/**
 * Key of the UI-only `_meta` entry on approve_draft / approval_edit_variant results: the one-time
 * card nonce and the media preview URLs. Never copied into content or structuredContent.
 */
export const APPROVAL_META_KEY = 'approvalCard'

/** Tool descriptor _meta for tools callable only from the approval card (hidden from the model). */
export const APP_ONLY_META = {
  ui: { visibility: ['app'] },
  'openai/visibility': 'private',
  'openai/widgetAccessible': true,
} as const

/** Tool descriptor _meta for approve_draft: render its result with the approval card. */
export const CARD_TOOL_META = {
  ui: { resourceUri: APPROVAL_CARD_URI },
  'openai/outputTemplate': APPROVAL_CARD_URI,
  'openai/widgetAccessible': true,
  'openai/toolInvocation/invoking': 'Opening the approval card…',
  'openai/toolInvocation/invoked': 'Approval card ready',
} as const
