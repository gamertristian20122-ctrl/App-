// createMcpServer(ctx): one McpServer per request (stateless) with our tools, prompts and the
// approval card resource. Tools are served by our own tools/list and tools/call handlers so we
// control the JSON Schemas (core zod schemas, io: input), the annotations and the error results:
// arguments are pre-validated here and passed raw to @app/services, which owns the rules.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { MCP_SCOPE } from '@app/core/types'
import { APPROVAL_CARD_DESCRIPTION, APPROVAL_CARD_TITLE, readApprovalCard } from './card/resource'
import { APPROVAL_CARD_URI, MCP_APP_MIME_TYPE } from './constants'
import { SERVER_NAME, SERVER_VERSION, type McpContext } from './context'
import { errorResult, invalidArguments, zodProblems } from './errors'
import { SERVER_INSTRUCTIONS } from './instructions'
import {
  pickClipsArgs,
  weeklyReviewArgs,
  writePostArgs,
  pickClipsPrompt,
  weeklyReviewPrompt,
  writePostPrompt,
} from './prompts'
import { inputJsonSchema } from './schema'
import { TOOLS, TOOLS_BY_NAME } from './tools'

export const SERVER_TITLE = 'Social posting'

/** Server capabilities (also used by server/discover for 2026-07-28 clients). */
export const SERVER_CAPABILITIES = {
  tools: {},
  prompts: {},
  resources: {},
  // prompt arguments (brand, source video) offer completions
  completions: {},
} as const

const SECURITY_SCHEMES = [{ type: 'oauth2', scopes: [MCP_SCOPE] }]

let descriptors: Tool[] | null = null

/** tools/list entries (computed once; the same for every user). */
export function toolDescriptors(): Tool[] {
  if (descriptors) return descriptors
  descriptors = TOOLS.map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: inputJsonSchema(def.input, def.describe),
    annotations: { title: def.title, ...def.annotations },
    securitySchemes: SECURITY_SCHEMES,
    _meta: { ...(def.meta ?? {}), securitySchemes: SECURITY_SCHEMES },
  })) as Tool[]
  return descriptors
}

/** Runs one tool call: validate, run, map errors. Never throws for tool-level failures. */
export async function callTool(ctx: McpContext, name: string, rawArgs: unknown): Promise<CallToolResult> {
  const def = TOOLS_BY_NAME.get(name)
  if (!def) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name.slice(0, 64)}`)
  const started = Date.now()
  const args = rawArgs ?? {}
  let result: CallToolResult
  if (typeof args !== 'object' || Array.isArray(args)) {
    result = invalidArguments(name, [{ message: 'Arguments must be a JSON object.' }])
  } else {
    const record = args as Record<string, unknown>
    const parsed = (def.parser?.(ctx) ?? def.input).safeParse(record)
    if (!parsed.success) {
      const problems = zodProblems(parsed.error)
      result = invalidArguments(name, def.explain ? def.explain(record, problems) : problems)
    } else {
      try {
        result = await def.run(ctx, record)
      } catch (error) {
        result = errorResult(error, ctx.log, { tool: name })
      }
    }
  }
  const code = result.isError ? (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code : undefined
  ctx.log?.info('mcp tool call', { tool: name, userId: ctx.userId, ms: Date.now() - started, ...(code ? { error: code } : {}) })
  return result
}

export function createMcpServer(ctx: McpContext): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE },
    { capabilities: { ...SERVER_CAPABILITIES }, instructions: SERVER_INSTRUCTIONS },
  )

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDescriptors() }))
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(ctx, request.params.name, request.params.arguments))

  mcp.registerResource(
    'approval-card',
    APPROVAL_CARD_URI,
    { title: APPROVAL_CARD_TITLE, description: APPROVAL_CARD_DESCRIPTION, mimeType: MCP_APP_MIME_TYPE },
    async () => readApprovalCard(ctx),
  )

  mcp.registerPrompt(
    'write_post',
    {
      title: 'Write a post in the brand voice',
      description: 'Loads the brand\'s voice profile, best past posts and platform rules, then guides drafting (draft first, the user approves, never publish directly).',
      argsSchema: writePostArgs(ctx),
    },
    (args) => writePostPrompt(ctx, args),
  )
  mcp.registerPrompt(
    'pick_clips',
    {
      title: 'Pick clip moments from a video',
      description: 'Loads a source video\'s transcript with rules for standalone moments with a hook in the first 3 seconds, and how to call make_clips.',
      argsSchema: pickClipsArgs(ctx),
    },
    (args) => pickClipsPrompt(ctx, args),
  )
  mcp.registerPrompt(
    'weekly_review',
    {
      title: 'Weekly review',
      description: 'Loads the last 7 days of analytics vs the previous 7 and asks for 3 concrete experiments with draft suggestions.',
      argsSchema: weeklyReviewArgs(ctx),
    },
    (args) => weeklyReviewPrompt(ctx, args),
  )

  return mcp
}
