import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import type { McpContext } from '../context'
import type { Problem } from '../errors'

export interface ToolAnnotationsFull {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface ToolDef {
  name: string
  title: string
  description: string
  /** The schema advertised in tools/list and used to pre-validate arguments. */
  input: z.ZodType
  /** Per-property descriptions merged into the advertised JSON Schema. */
  describe?: Readonly<Record<string, string>>
  /** Validation schema when it depends on the request (e.g. the services clock). Defaults to `input`. */
  parser?: (ctx: McpContext) => z.ZodType
  annotations: ToolAnnotationsFull
  /** Tool descriptor _meta (MCP Apps / ChatGPT keys). */
  meta?: Record<string, unknown>
  /** Adds detail to validation problems (e.g. "N over the limit"). */
  explain?: (args: Record<string, unknown>, problems: Problem[]) => Problem[]
  /**
   * Runs the tool. `args` are the raw arguments (already pre-validated with the schema): services
   * parse them again with the same core schemas, so business rules stay in one place.
   */
  run: (ctx: McpContext, args: Record<string, unknown>) => Promise<CallToolResult>
}

export const READ_ONLY: ToolAnnotationsFull = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
