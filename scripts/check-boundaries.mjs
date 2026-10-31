#!/usr/bin/env node
// Architecture boundary checks (pnpm lint). Exits 1 when any rule is broken.
//
// 1. Only the Upload-Post adapter may talk to Upload-Post: the provider's hostnames may appear
//    only under packages/posting/src/upload-post/ (and in posting's own tests).
// 2. No package may depend on a YouTube/video-site downloader (users may only clip their own content).
//
// Skips docs/, node_modules, build output and this script.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/')

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage', 'tmp', '.data', '.vercel', '.turbo', 'docs'])
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql', '.html', '.css', '.yaml', '.yml', '.toml',
])
const EXTRA_FILES = new Set(['.env.example', 'Dockerfile'])

// Assembled so this file does not contain the literal strings it searches for.
const PROVIDER_PATTERNS = [['upload-post', 'com'].join('.'), ['api', 'upload-post'].join('.')]
const PROVIDER_ALLOWED = [/^packages\/posting\/src\/upload-post\//, /^packages\/posting\/(test|tests|__tests__)\//, /^packages\/posting\/.*\.test\.[cm]?[jt]sx?$/]
const LOCKFILES = new Set(['pnpm-lock.yaml'])

const FORBIDDEN_DEPS = [/^ytdl-core$/, /^@distube\/ytdl-core$/, /^yt-dlp/, /^youtube-dl/, /^play-dl$/, /^youtubei\.js$/, /^youtube-dl-exec$/]

/** @returns {string[]} repo-relative POSIX paths */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(ROOT, full).split(path.sep).join('/')
      if (rel === SELF || LOCKFILES.has(entry.name)) continue
      if (SOURCE_EXT.has(path.extname(entry.name)) || EXTRA_FILES.has(entry.name)) out.push(rel)
    }
  }
  return out
}

const problems = []

for (const rel of walk(ROOT)) {
  const full = path.join(ROOT, rel)
  if (statSync(full).size > 5_000_000) continue
  const text = readFileSync(full, 'utf8')
  const lower = text.toLowerCase()

  if (!PROVIDER_ALLOWED.some((re) => re.test(rel))) {
    for (const pattern of PROVIDER_PATTERNS) {
      const idx = lower.indexOf(pattern)
      if (idx !== -1) {
        const line = text.slice(0, idx).split('\n').length
        problems.push(`${rel}:${line}: "${pattern}" outside packages/posting/src/upload-post/ (all posting goes through PostingProvider)`)
      }
    }
  }

  if (path.basename(rel) === 'package.json') {
    let pkg
    try {
      pkg = JSON.parse(text)
    } catch {
      problems.push(`${rel}: invalid JSON`)
      continue
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (FORBIDDEN_DEPS.some((re) => re.test(name))) {
          problems.push(`${rel}: ${field} includes "${name}" (we never download from YouTube or other video sites)`)
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Boundary check failed (${problems.length}):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('Boundary check passed.')
