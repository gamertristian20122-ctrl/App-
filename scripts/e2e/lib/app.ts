// Brings the product up on this machine: Postgres 16 + Supabase stand-ins + migrations (the repo's
// migrator), generated secrets, `next build` + `next start` with DEV_AUTH=1 and the fake posting
// provider, and the worker (WORKER_TYPES=all) against the same database and file storage.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPostgresDb, type Db } from '../../../packages/db/src/index'
import { startPostgres, findPgBin } from './postgres'
import { assertServicesAlive, onStop, run, startService } from './procs'
import { assert, freePort, log, REPO, waitFor } from './util'
import { startWhisperStub, type WhisperStub } from './whisper-stub'

export interface AppOptions {
  runDir: string
  pgDir: string
  /** Reuse apps/web/.next when it exists (no `next build`). */
  skipBuild: boolean
  /** Transcribe through the local Whisper stub instead of TRANSCRIPTION_PROVIDER=fake. */
  whisper: boolean
  /** Length of the source video (for the Whisper stub's canned transcript). */
  videoSeconds: number
  /** OWNER_EMAIL: the account that may open /setup. */
  ownerEmail: string
}

export interface App {
  appUrl: string
  env: Record<string, string>
  dbUrl: string
  /** Direct database handle for assertions (the app itself never shares it). */
  db: Db
  storageDir: string
  workerHealthUrl: string
  whisper: WhisperStub | null
  logs: { web: string; worker: string; build: string; migrate: string; postgres: string }
}

const BIN = {
  tsx: join(REPO, 'node_modules/.bin/tsx'),
  next: join(REPO, 'apps/web/node_modules/.bin/next'),
}

/** Every variable the apps read (from .env.example), so nothing leaks in from the caller's shell. */
function configKeys(): string[] {
  const text = readFileSync(join(REPO, '.env.example'), 'utf8')
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string)
}

/** pnpm secrets (scripts/generate-secrets.mjs) → { TOKEN_ENCRYPTION_KEYS, SESSION_SECRET, CRON_SECRET }. */
async function generateSecrets(): Promise<Record<string, string>> {
  const r = await run(process.execPath, [join(REPO, 'scripts/generate-secrets.mjs'), 'e2e'])
  const out: Record<string, string> = {}
  for (const line of r.stdout.split('\n')) {
    const m = /^([A-Z_]+)=(.+)$/.exec(line.trim())
    if (m) out[m[1] as string] = m[2] as string
  }
  for (const key of ['TOKEN_ENCRYPTION_KEYS', 'SESSION_SECRET', 'CRON_SECRET']) assert(out[key], `generate-secrets.mjs did not print ${key}`)
  return out
}

/** process.env without what tsx sets for this script (a relative --tsconfig path would break children). */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TSX_')) out[k] = v
  return out
}

async function httpOk(url: string): Promise<Response | undefined> {
  const res = await fetch(url, { redirect: 'manual' }).catch(() => null)
  return res && res.status < 500 ? res : undefined
}

export async function startApp(options: AppOptions): Promise<App> {
  const { runDir, pgDir } = options
  rmSync(runDir, { recursive: true, force: true })
  const storageDir = join(runDir, 'storage')
  const mediaDir = join(runDir, 'media')
  const logDir = join(runDir, 'logs')
  for (const d of [storageDir, mediaDir, logDir]) mkdirSync(d, { recursive: true })
  const logs = {
    web: join(logDir, 'web.log'),
    worker: join(logDir, 'worker.log'),
    build: join(logDir, 'next-build.log'),
    migrate: join(logDir, 'migrate.log'),
    postgres: join(pgDir, 'server.log'),
  }

  const [pgPort, webPort, healthPort, whisperPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()])

  // 1. Postgres + Supabase stand-ins + migrations (twice: the second run must apply nothing)
  const pg = await startPostgres({ dir: pgDir, port: pgPort, binDir: findPgBin(process.env.E2E_PG_BIN) })
  await pg.createDatabase('app_e2e')
  const dbUrl = pg.url('app_e2e')
  const migrateEnv = { ...inheritedEnv(), DATABASE_URL: dbUrl }
  const first = await run(BIN.tsx, ['src/cli.ts', '--local-shim'], { cwd: join(REPO, 'packages/db'), env: migrateEnv, logFile: logs.migrate })
  log(`migrations: ${first.stdout.trim().split('\n').join('; ')}`)
  assert(/applied [1-9]\d*, already applied 0/.test(first.stdout), 'the first migration run applied nothing')
  const second = await run(BIN.tsx, ['src/cli.ts', '--local-shim'], { cwd: join(REPO, 'packages/db'), env: migrateEnv, logFile: logs.migrate })
  assert(/applied 0, already applied [1-9]/.test(second.stdout), `re-running the migrator was not a no-op: ${second.stdout.trim()}`)

  const db = createPostgresDb(dbUrl, { max: 2 })
  onStop('assertion db pool', () => db.close())
  const roles = await db.query<{ rolname: string }>(`select rolname from pg_roles where rolname in ('anon','authenticated','service_role') order by 1`)
  assert(roles.length === 3, 'Supabase roles (anon, authenticated, service_role) are missing')
  const rls = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname <> 'schema_migrations'`,
  )
  assert(rls.length === 0, `tables without row level security: ${rls.map((r) => r.relname).join(', ')}`)

  // 2. Optional Whisper stub
  let whisper: WhisperStub | null = null
  if (options.whisper) {
    whisper = await startWhisperStub(whisperPort, options.videoSeconds)
    const stub = whisper
    onStop('whisper stub', () => stub.close())
    log(`whisper stub on ${whisper.url}`)
  }

  // 3. Environment shared by web and worker
  const appUrl = `http://127.0.0.1:${webPort}`
  const base: Record<string, string> = {}
  const drop = new Set(configKeys())
  for (const [k, v] of Object.entries(inheritedEnv())) if (!drop.has(k)) base[k] = v
  const env: Record<string, string> = {
    ...base,
    ...(await generateSecrets()),
    NODE_ENV: 'production',
    APP_ENV: 'development',
    APP_URL: appUrl,
    LOG_LEVEL: 'info',
    DATABASE_URL: dbUrl,
    DATABASE_POOL_MAX: '5',
    DEV_AUTH: '1',
    // explicitly empty so a developer's apps/web/.env.local cannot switch on real services
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    UPLOAD_POST_API_KEY: '',
    // the e2e user is the owner (/setup); the legal values stay unset (the pages show placeholders)
    OWNER_EMAIL: options.ownerEmail,
    POSTING_PROVIDER: 'fake',
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_DIR: storageDir,
    TRANSCRIPTION_PROVIDER: whisper ? 'whisper' : 'fake',
    WHISPER_URL: whisper ? whisper.url : '',
    MEDIA_TMP_DIR: mediaDir,
    NEXT_TELEMETRY_DISABLED: '1',
  }

  // 4. Web app: next build (unless reused) + next start
  const web = join(REPO, 'apps/web')
  if (options.skipBuild && existsSync(join(web, '.next/BUILD_ID'))) {
    log('reusing apps/web/.next (--skip-build)')
  } else {
    log('next build (apps/web) …')
    await run(BIN.next, ['build'], { cwd: web, env, logFile: logs.build, timeoutMs: 15 * 60_000 })
    const out = readFileSync(logs.build, 'utf8')
    assert(!/Failed to compile|Type error/i.test(out), `next build reported errors (see ${logs.build})`)
  }
  startService('web (next start)', BIN.next, ['start', '-H', '127.0.0.1', '-p', String(webPort)], { cwd: web, env, logFile: logs.web })
  await waitFor(
    'the web app to answer',
    async () => {
      assertServicesAlive()
      return httpOk(`${appUrl}/`)
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  )
  log(`web app on ${appUrl}`)

  // 5. Worker (all handler groups) with its health endpoint
  const workerEnv = { ...env, WORKER_TYPES: 'all', WORKER_ID: 'e2e-worker', WORKER_POLL_INTERVAL_MS: '500', WORKER_CONCURRENCY: '2', PORT: String(healthPort) }
  startService('worker', BIN.tsx, ['src/main.ts'], { cwd: join(REPO, 'apps/worker'), env: workerEnv, logFile: logs.worker })
  const workerHealthUrl = `http://127.0.0.1:${healthPort}/`
  const health = await waitFor(
    'the worker health endpoint',
    async () => {
      assertServicesAlive()
      const res = await fetch(workerHealthUrl).catch(() => null)
      if (!res?.ok) return undefined
      const body = (await res.json()) as { ok?: boolean; state?: string; types?: string[] }
      return body.ok && body.state === 'running' ? body : undefined
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  )
  log(`worker running: ${(health.types ?? []).join(', ')}`)
  for (const type of ['publish_post', 'check_post_status', 'source_ingest', 'transcribe', 'clip_render', 'carousel_render', 'video_render', 'cleanup']) {
    assert(health.types?.includes(type), `worker does not handle ${type}`)
  }

  return { appUrl, env, dbUrl, db, storageDir, workerHealthUrl, whisper, logs }
}
