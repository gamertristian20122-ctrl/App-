// zod (core validation schemas) → JSON Schema for tools/list, with per-property descriptions so
// the model knows where ids come from and which units to use.

import { z } from 'zod'

export type JsonSchema = Record<string, unknown> & { type: 'object'; properties?: Record<string, unknown> }

/**
 * Input JSON Schema of a tool (draft-07 like the SDK; `io: 'input'` so defaults/transforms show
 * what the caller may send). Descriptions are merged into the top-level properties.
 */
export function inputJsonSchema(schema: z.ZodType, descriptions: Readonly<Record<string, string>> = {}): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>
  delete json.$schema
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>
  for (const [key, description] of Object.entries(descriptions)) {
    const prop = properties[key]
    if (prop) properties[key] = { ...prop, description }
  }
  return { ...json, type: 'object', properties }
}
