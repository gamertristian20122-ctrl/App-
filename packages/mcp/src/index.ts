// @app/mcp: the MCP server (tools, prompts, approval-card UI resource). See docs/ARCHITECTURE.md
// ("MCP") and docs/handoff/mcp.md. Contract used by apps/web (/api/mcp):
//   handleMcpRequest(request, ctx) -> Response   (stateless Streamable HTTP; new server per request)
//   createMcpServer(ctx) -> McpServer             (in-memory / other transports)
//   TOOL_NAMES, APPROVAL_CARD_URI

import { TOOLS } from './tools'

export { createMcpServer, toolDescriptors, callTool, SERVER_CAPABILITIES, SERVER_TITLE } from './server'
export { handleMcpRequest, MODERN_PROTOCOL_VERSIONS, LEGACY_PROTOCOL_VERSIONS, PROTOCOL_VERSIONS } from './http'
export type { McpContext } from './context'
export { SERVER_NAME, SERVER_VERSION } from './context'
export { APPROVAL_CARD_URI, APPROVAL_META_KEY, MCP_APP_MIME_TYPE } from './constants'
export { SERVER_INSTRUCTIONS } from './instructions'
export { APPROVAL_CARD_HTML } from './card/html'
export { PROMPT_NAMES } from './prompts'

/** Every tool name, in tools/list order (the last two are app-only: called by the approval card). */
export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name)
