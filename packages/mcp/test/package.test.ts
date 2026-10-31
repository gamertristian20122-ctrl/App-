// @app/mcp depends only on @app/core, @app/services, the MCP SDK and zod at runtime: the web app
// resolves this package's imports from packages/mcp, so src must not import other workspace
// packages (tests may, through the aliases in vitest.config.ts / tsconfig.json).

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as mcp from '../src'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const ALLOWED = [/^@app\/core(\/|$)/, /^@app\/services$/, /^@modelcontextprotocol\/sdk\//, /^zod$/, /^node:/, /^\./]

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

describe('@app/mcp package', () => {
  it('src imports only its declared dependencies', () => {
    for (const file of files(SRC).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
        const spec = m[1] as string
        expect(ALLOWED.some((re) => re.test(spec)), `${path.relative(SRC, file)} imports ${spec}`).toBe(true)
      }
    }
  })

  it('exports the contract the web app codes against', () => {
    expect(typeof mcp.handleMcpRequest).toBe('function')
    expect(typeof mcp.createMcpServer).toBe('function')
    expect(mcp.APPROVAL_CARD_URI).toBe('ui://approval-card/v1')
    expect(mcp.TOOL_NAMES).toHaveLength(16)
    expect(new Set(mcp.TOOL_NAMES).size).toBe(16)
  })
})
