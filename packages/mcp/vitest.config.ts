import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests build real services on PGlite with the fakes from @app/db/testing, @app/posting and
// @app/storage. Those are not runtime dependencies of @app/mcp, so tests resolve them by path
// (mirrored in tsconfig.json "paths").
const pkg = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@app\/db\/testing$/, replacement: pkg('db/src/testing.ts') },
      { find: /^@app\/db$/, replacement: pkg('db/src/index.ts') },
      { find: /^@app\/posting$/, replacement: pkg('posting/src/index.ts') },
      { find: /^@app\/storage$/, replacement: pkg('storage/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
