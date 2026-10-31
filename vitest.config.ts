import { defineConfig } from 'vitest/config'

// Runs every package's tests from the repo root (`pnpm exec vitest run`).
// `pnpm test` runs them per package instead (pnpm -r test).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
})
