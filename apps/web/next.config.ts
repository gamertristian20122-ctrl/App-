import path from 'node:path'
import type { NextConfig } from 'next'

// pnpm monorepo root (two levels up from apps/web). `next build` runs with cwd = apps/web.
const monorepoRoot = path.resolve(process.cwd(), '../..')

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript source.
  transpilePackages: [
    '@app/core',
    '@app/db',
    '@app/services',
    '@app/mcp',
    '@app/posting',
    '@app/storage',
    '@app/transcription',
  ],
  // Native/wasm-heavy or connection-pooling packages stay as runtime requires on the server.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  poweredByHeader: false,
  reactStrictMode: true,
}

export default nextConfig
