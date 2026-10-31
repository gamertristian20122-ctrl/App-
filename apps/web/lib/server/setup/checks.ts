// The owner's /setup checklist: one plain-English line per check, OK / Needs attention / Not set,
// with where to tap to fix it. Every check is independent and time-limited; one failing never hides
// the others. Nothing here returns a secret value: the report is scrubbed of every configured
// secret before it leaves this module. Server-only.

import { MIGRATION_NAMES, migrationStatus, workerHeartbeats, type HeartbeatRow } from '@app/db'
import { corsPolicyJson, corsProblems, originOf, storageErrorReason, supportsBucketAdmin, uploadCorsRule, uploadKey, withUploadCorsRule } from '@app/storage'
import { claudeCodeCommand } from '@/components/app/connect'
import { PRODUCT_NAME } from '@/lib/ui/brand'
import { agoText, countStatuses, type SetupCheck, type SetupGroup, type SetupReport } from '@/lib/ui/setup'
import type { SetupDeps } from './deps'
import { catalogCheck, portalCheck, safeMessage, stripeKeyCheck, webhookCheck } from './stripe'

const VERCEL_ENV = 'Vercel → your project → Settings → Environment Variables'
const REDEPLOY = 'then Deployments → ⋯ → Redeploy'
/** A worker that has not beaten for this long is reported as stopped. */
export const WORKER_STALE_SEC = 180
const CHECK_TIMEOUT_MS = 12_000

/** Config values that must never appear on the page. */
const SECRET_KEYS = [
  'SESSION_SECRET',
  'TOKEN_ENCRYPTION_KEYS',
  'CRON_SECRET',
  'DATABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPLOAD_POST_API_KEY',
  'UPLOAD_POST_WEBHOOK_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'WHISPER_API_KEY',
  'ASSEMBLYAI_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const

function secretValues(config: SetupDeps['config']): string[] {
  const out: string[] = []
  for (const key of SECRET_KEYS) {
    const value = (config as unknown as Record<string, unknown>)[key]
    if (typeof value !== 'string' || value.length < 6) continue
    out.push(value)
    // comma lists (key rings, rotating webhook secrets) and the parts of a key ring
    for (const part of value.split(/[,]/)) {
      const p = part.trim()
      if (p.length >= 6) out.push(p, p.replace(/^v\d+:/, ''))
    }
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

/** Replaces any configured secret value in the report's text with "[hidden]" (defense in depth). */
export function scrubReport<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value
  const scrub = (s: string) => secrets.reduce((acc, secret) => (acc.includes(secret) ? acc.split(secret).join('[hidden]') : acc), s)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

async function guarded(id: string, title: string, fn: () => Promise<SetupCheck>): Promise<SetupCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<SetupCheck>((resolve) => {
    timer = setTimeout(
      () => resolve({ id, title, status: 'attention', summary: 'This check took too long. Reload the page to try again.' }),
      CHECK_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([fn(), timeout])
  } catch (error) {
    return { id, title, status: 'attention', summary: `This check failed: ${safeMessage(error, 'unexpected error')}` }
  } finally {
    clearTimeout(timer)
  }
}

// --- a. basics ----------------------------------------------------------------------------------

export function basicsChecks(deps: SetupDeps): SetupCheck[] {
  const c = deps.config
  const prod = c.APP_ENV === 'production'
  const missing = (['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEYS', 'CRON_SECRET'] as const).filter((k) => !c[k])
  const fakes = [
    c.POSTING_PROVIDER === 'fake' ? 'posting (POSTING_PROVIDER=fake)' : null,
    c.STORAGE_DRIVER !== 'r2' ? `file storage (STORAGE_DRIVER=${c.STORAGE_DRIVER})` : null,
    c.TRANSCRIPTION_PROVIDER === 'fake' ? 'transcription (TRANSCRIPTION_PROVIDER=fake)' : null,
  ].filter((x): x is string => x !== null)

  return [
    prod
      ? { id: 'basics.environment', title: 'App environment', status: 'ok', summary: 'APP_ENV is production: the strict checks are on.' }
      : {
          id: 'basics.environment',
          title: 'App environment',
          status: 'attention',
          summary: `APP_ENV is ${c.APP_ENV}: fine for testing, not for real customers.`,
          fix: `Before launch: ${VERCEL_ENV} → set APP_ENV to production → ${REDEPLOY}.`,
        },
    c.APP_URL.startsWith('https://')
      ? { id: 'basics.app_url', title: 'Site address (APP_URL)', status: 'ok', summary: c.APP_URL }
      : {
          id: 'basics.app_url',
          title: 'Site address (APP_URL)',
          status: 'attention',
          summary: `${c.APP_URL} is not https.`,
          fix: `${VERCEL_ENV} → set APP_URL to your https address with no slash at the end → ${REDEPLOY}.`,
        },
    {
      id: 'basics.secrets',
      title: 'Secret keys',
      status: missing.length > 0 ? 'unset' : c.DEV_AUTH ? 'attention' : 'ok',
      summary:
        missing.length > 0
          ? `Missing: ${missing.join(', ')}.`
          : c.DEV_AUTH
            ? 'DEV_AUTH is on: anyone can sign in with any email address.'
            : 'SESSION_SECRET, TOKEN_ENCRYPTION_KEYS and CRON_SECRET are set. Their values are never shown.',
      ...(missing.length > 0
        ? { fix: `Ask Claude for fresh random values (or run pnpm secrets on a computer), paste them in ${VERCEL_ENV}, ${REDEPLOY}.` }
        : c.DEV_AUTH
          ? { fix: `${VERCEL_ENV} → delete DEV_AUTH → ${REDEPLOY}.` }
          : {}),
    },
    fakes.length === 0
      ? { id: 'basics.services', title: 'Real services', status: 'ok', summary: 'Posting, file storage and transcription use real services.' }
      : {
          id: 'basics.services',
          title: 'Real services',
          status: 'attention',
          summary: `Test stand-ins in use: ${fakes.join(', ')}.`,
          fix: `Before launch: POSTING_PROVIDER=upload_post, STORAGE_DRIVER=r2 and TRANSCRIPTION_PROVIDER=assemblyai in ${VERCEL_ENV} and on Railway, ${REDEPLOY}.`,
          ...(prod ? { details: ['APP_ENV=production refuses these stand-ins.'] } : {}),
        },
  ]
}

// --- b. database ----------------------------------------------------------------------------------

export async function databaseChecks(deps: SetupDeps): Promise<SetupCheck[]> {
  const connection = await guarded('database.connection', 'Database connection', async () => {
    try {
      await deps.db.query('select 1 as ok')
    } catch {
      return {
        id: 'database.connection',
        title: 'Database connection',
        status: 'attention',
        summary: 'The database could not be reached.',
        fix: `Check DATABASE_URL in ${VERCEL_ENV} (Supabase → Connect → Transaction pooler string, with ?sslmode=require at the end), ${REDEPLOY}.`,
      }
    }
    return {
      id: 'database.connection',
      title: 'Database connection',
      status: deps.db.driver === 'postgres' ? 'ok' : 'attention',
      summary: deps.db.driver === 'postgres' ? 'Connected to Postgres.' : 'Using the in-process test database (data is not kept). Set DATABASE_URL for real use.',
    }
  })
  const migrations = await guarded('database.migrations', 'Database tables (migrations)', async () => {
    const status = await migrationStatus(deps.db, MIGRATION_NAMES)
    if (status.pending.length > 0) {
      return {
        id: 'database.migrations',
        title: 'Database tables (migrations)',
        status: 'attention',
        summary: `Missing ${status.pending.length} migration${status.pending.length === 1 ? '' : 's'}: ${status.pending.join(', ')}.`,
        fix: `${VERCEL_ENV} → set RUN_MIGRATIONS=1 and MIGRATION_DATABASE_URL (Supabase → Connect → Session pooler string, port 5432, with ?sslmode=require) → ${REDEPLOY}. The build applies them.`,
      }
    }
    if (status.unknown.length > 0) {
      return {
        id: 'database.migrations',
        title: 'Database tables (migrations)',
        status: 'attention',
        summary: `The database has migrations this deployment does not know (${status.unknown.join(', ')}).`,
        fix: 'Redeploy the latest code (Vercel → Deployments → ⋯ → Redeploy).',
      }
    }
    return { id: 'database.migrations', title: 'Database tables (migrations)', status: 'ok', summary: `All ${MIGRATION_NAMES.length} migrations are applied.` }
  })
  return [connection, migrations]
}

// --- c. Supabase auth -----------------------------------------------------------------------------

export async function supabaseCheck(deps: SetupDeps): Promise<SetupCheck> {
  const c = deps.config
  const base = { id: 'auth.supabase', title: 'Sign-in (Supabase)' }
  const reminders = [
    'Can’t be checked from here: custom email (SMTP). Supabase → Authentication → Emails → SMTP Settings → turn on custom SMTP with your Resend details, or sign-in emails only reach your own team.',
    `Supabase → Authentication → URL Configuration: Site URL ${c.APP_URL} and Redirect URL ${c.APP_URL}/**.`,
  ]
  if (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY) {
    return {
      ...base,
      status: 'unset',
      summary: c.DEV_AUTH ? 'Supabase is not set; only the development sign-in works.' : 'Supabase is not set, so nobody can sign in by email.',
      fix: `Supabase → Project Settings → API Keys: copy the Project URL into SUPABASE_URL and the anon (publishable) key into SUPABASE_ANON_KEY in ${VERCEL_ENV}, ${REDEPLOY}.`,
      details: reminders,
    }
  }
  let status: number | null
  try {
    const res = await deps.fetch(`${c.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: c.SUPABASE_ANON_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
      redirect: 'manual',
    })
    status = res.status
    await res.body?.cancel().catch(() => {})
  } catch {
    status = null
  }
  if (status !== null && status >= 200 && status < 300) {
    return { ...base, status: 'ok', summary: 'Supabase sign-in answered.', details: reminders }
  }
  return {
    ...base,
    status: 'attention',
    summary:
      status === null
        ? 'SUPABASE_URL could not be reached.'
        : status === 401 || status === 403
          ? 'Supabase refused SUPABASE_ANON_KEY.'
          : `Supabase sign-in answered HTTP ${status}.`,
    fix: `Supabase → Project Settings → API Keys: check the Project URL (SUPABASE_URL) and the anon key (SUPABASE_ANON_KEY) in ${VERCEL_ENV}, ${REDEPLOY}.`,
    details: reminders,
  }
}

// --- d. storage -----------------------------------------------------------------------------------

/** A key in the layout the drivers accept; used only for a HEAD that should answer "not found". */
const PROBE_KEY = uploadKey('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', 'bin')

export async function storageChecks(deps: SetupDeps): Promise<SetupCheck[]> {
  const c = deps.config
  if (c.STORAGE_DRIVER !== 'r2') {
    const where = c.STORAGE_DRIVER === 'memory' ? 'in memory (lost on every restart)' : 'on this server’s disk'
    return [
      {
        id: 'storage.bucket',
        title: 'File storage (Cloudflare R2)',
        status: 'unset',
        summary: `Test mode: files are kept ${where}.`,
        fix: `Create an R2 bucket and API token, then set STORAGE_DRIVER=r2, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in ${VERCEL_ENV} and on Railway, ${REDEPLOY}.`,
      },
      { id: 'storage.cors', title: 'Browser uploads (CORS)', status: 'unset', summary: 'Not needed until files are stored in R2.' },
    ]
  }
  const bucketName = c.R2_BUCKET ?? 'your bucket'
  const bucket = await guarded('storage.bucket', 'File storage (Cloudflare R2)', async () => {
    const base = { id: 'storage.bucket', title: 'File storage (Cloudflare R2)' }
    if (!supportsBucketAdmin(deps.storage)) return { ...base, status: 'attention', summary: 'This storage driver cannot be checked.' }
    try {
      await deps.storage.headBucket()
      return { ...base, status: 'ok', summary: `Bucket ${bucketName} is reachable.` }
    } catch (error) {
      const reason = storageErrorReason(error)
      if (reason === 'storage_auth') {
        // a bucket-scoped object token may not be allowed HeadBucket: try an object lookup instead
        try {
          await deps.storage.head(PROBE_KEY)
          return { ...base, status: 'ok', summary: `Bucket ${bucketName} is reachable (object access).` }
        } catch {
          return {
            ...base,
            status: 'attention',
            summary: `R2 refused the access key for bucket ${bucketName}.`,
            fix: 'Cloudflare → R2 → Manage API tokens → create a token with Object Read & Write on this bucket → paste its Access Key ID into R2_ACCESS_KEY_ID and Secret Access Key into R2_SECRET_ACCESS_KEY (Vercel and Railway), then Redeploy.',
          }
        }
      }
      if (reason === 'not_found') {
        return { ...base, status: 'attention', summary: `Bucket ${bucketName} was not found.`, fix: 'Check R2_BUCKET (the exact bucket name) and R2_ACCOUNT_ID (Cloudflare → R2 overview), in Vercel and Railway.' }
      }
      return { ...base, status: 'attention', summary: safeMessage(error, 'R2 could not be reached. Try again in a minute.') }
    }
  })

  const cors = await guarded('storage.cors', 'Browser uploads (CORS)', async () => {
    const base = { id: 'storage.cors', title: 'Browser uploads (CORS)' }
    const action = { id: 'fix_storage_cors' as const, label: 'Fix storage CORS', note: `Allows uploads from ${originOf(c.APP_URL)} (PUT, GET, HEAD; Content-Type; exposes ETag). Rules for other sites are kept.` }
    const manual = 'If the button is refused: Cloudflare → R2 → your bucket → Settings → CORS policy → Edit → paste the policy below → Save.'
    if (!supportsBucketAdmin(deps.storage)) return { ...base, status: 'attention', summary: 'This storage driver cannot be checked.' }
    try {
      const rules = await deps.storage.getBucketCors()
      const problems = corsProblems(rules, c.APP_URL)
      if (problems.length === 0) return { ...base, status: 'ok', summary: `Browsers may upload straight to R2 from ${originOf(c.APP_URL)}.` }
      return {
        ...base,
        status: 'attention',
        summary: problems[0] as string,
        details: [...problems.slice(1), manual],
        fix: 'Tap “Fix storage CORS”.',
        action,
        copies: [{ label: 'Copy CORS policy', value: corsPolicyJson(withUploadCorsRule(rules, c.APP_URL)) }],
      }
    } catch (error) {
      if (storageErrorReason(error) === 'storage_auth') {
        return {
          ...base,
          status: 'attention',
          summary: 'This R2 token may not read the bucket’s CORS settings (normal for an object-only token), so it can’t be checked from here.',
          fix: 'Tap “Fix storage CORS”, or paste the policy below in Cloudflare by hand.',
          details: [manual],
          action,
          copies: [{ label: 'Copy CORS policy', value: corsPolicyJson([uploadCorsRule(c.APP_URL)]) }],
        }
      }
      return { ...base, status: 'attention', summary: safeMessage(error, 'R2 could not be reached. Try again in a minute.') }
    }
  })
  return [bucket, cors]
}

// --- e. posting -----------------------------------------------------------------------------------

export async function postingChecks(deps: SetupDeps): Promise<SetupCheck[]> {
  const c = deps.config
  const keyFix = `Upload-Post dashboard → API Keys → copy the key into UPLOAD_POST_API_KEY, and set POSTING_PROVIDER=upload_post, in ${VERCEL_ENV} and on Railway, ${REDEPLOY}.`
  const provider = await guarded('posting.provider', 'Posting (Upload-Post)', async () => {
    const base = { id: 'posting.provider', title: 'Posting (Upload-Post)' }
    if (deps.provider.name === 'fake') {
      return { ...base, status: 'attention', summary: 'TEST MODE: posts are not really published (POSTING_PROVIDER=fake).', fix: keyFix }
    }
    if (typeof deps.provider.healthCheck !== 'function') return { ...base, status: 'attention', summary: 'This posting provider cannot be checked.' }
    const health = await deps.provider.healthCheck()
    return health.ok
      ? { ...base, status: 'ok', summary: health.detail ?? 'Upload-Post accepted the API key.' }
      : { ...base, status: 'attention', summary: health.detail ?? 'Upload-Post did not accept the API key.', fix: keyFix }
  })
  const hook = `${c.APP_URL}/api/webhooks/upload-post`
  const webhook: SetupCheck =
    deps.provider.name === 'fake'
      ? { id: 'posting.webhook', title: 'Upload-Post webhook', status: 'unset', summary: 'Not needed in test mode.' }
      : c.UPLOAD_POST_WEBHOOK_SECRET
        ? { id: 'posting.webhook', title: 'Upload-Post webhook', status: 'ok', summary: `UPLOAD_POST_WEBHOOK_SECRET is set for ${hook}.` }
        : {
            id: 'posting.webhook',
            title: 'Upload-Post webhook',
            status: 'unset',
            summary: 'UPLOAD_POST_WEBHOOK_SECRET is not set: post results arrive only by polling.',
            fix: `Upload-Post → Webhooks: copy (or create) the signing secret into UPLOAD_POST_WEBHOOK_SECRET in ${VERCEL_ENV}, ${REDEPLOY}; then add the webhook URL below and turn it on.`,
            copies: [{ label: 'Copy webhook URL', value: hook }],
          }
  return [provider, webhook]
}

// --- g. transcription -----------------------------------------------------------------------------

export async function transcriptionCheck(deps: SetupDeps): Promise<SetupCheck> {
  const c = deps.config
  const base = { id: 'transcription.engines', title: 'Transcription' }
  const fix = `AssemblyAI dashboard → API Keys → copy the key into ASSEMBLYAI_API_KEY and set TRANSCRIPTION_PROVIDER=assemblyai, in ${VERCEL_ENV} and on the Railway media worker, ${REDEPLOY}.`
  const note = 'This checks Vercel’s settings. The media worker on Railway (which does the transcribing) needs the same TRANSCRIPTION_PROVIDER and key.'
  if (c.TRANSCRIPTION_PROVIDER === 'fake') {
    return { ...base, status: 'attention', summary: 'TEST MODE: transcripts are made up (TRANSCRIPTION_PROVIDER=fake).', fix, details: [note] }
  }
  const results = await deps.transcriptionHealth(c)
  let privateWhisper = false
  try {
    privateWhisper = Boolean(c.WHISPER_URL && new URL(c.WHISPER_URL).hostname.endsWith('.railway.internal'))
  } catch {
    privateWhisper = false
  }
  const label = (engine: string) => (engine === 'assemblyai' ? 'AssemblyAI' : engine === 'whisper' ? 'Whisper' : engine)
  const counted = results.filter((r) => !(r.engine === 'whisper' && privateWhisper && !r.ok))
  const details = results.map((r) =>
    r.engine === 'whisper' && privateWhisper && !r.ok
      ? 'Whisper: on Railway’s private network, so it can’t be reached from Vercel. The media worker’s logs show which engine answered.'
      : `${label(r.engine)}: ${r.detail ?? (r.ok ? 'OK' : 'not OK')}`,
  )
  details.push(note)
  if (counted.length === 0) {
    return {
      ...base,
      status: 'attention',
      summary: privateWhisper ? 'Whisper can’t be checked from here (private network).' : 'No transcription engine could be checked.',
      details,
    }
  }
  const ok = counted.every((r) => r.ok)
  return {
    ...base,
    status: ok ? 'ok' : 'attention',
    summary: ok
      ? `${results.map((r) => label(r.engine)).join(' then ')} ready (TRANSCRIPTION_PROVIDER=${c.TRANSCRIPTION_PROVIDER}).`
      : (counted.find((r) => !r.ok)?.detail ?? 'A transcription engine is not ready.'),
    ...(ok ? {} : { fix }),
    details,
  }
}

// --- h. workers -----------------------------------------------------------------------------------

export async function workerChecks(deps: SetupDeps): Promise<SetupCheck[]> {
  let rows: HeartbeatRow[]
  try {
    rows = await workerHeartbeats.list(deps.db)
  } catch {
    return (['posting', 'media'] as const).map((group) => ({
      id: `workers.${group}`,
      title: group === 'posting' ? 'Posting worker' : 'Media worker',
      status: 'attention' as const,
      summary: 'Worker heartbeats can’t be read yet (the database needs migration 0005).',
      fix: 'See “Database tables (migrations)” above.',
    }))
  }
  return (['posting', 'media'] as const).map((group) => {
    const title = group === 'posting' ? 'Posting worker' : 'Media worker'
    const what = group === 'posting' ? 'publishes posts, checks their status and pulls analytics' : 'ingests videos, transcribes, cuts clips and renders'
    const latest = rows.filter((r) => r.types.includes(group)).sort((a, b) => a.ageSec - b.ageSec)[0]
    if (!latest) {
      return {
        id: `workers.${group}`,
        title,
        status: 'unset' as const,
        summary: `Not running (never seen). It ${what}.`,
        fix: `Railway → New → GitHub Repo → this repository; Settings → Config-as-code path apps/worker/railway.toml; Variables: the Railway block from the guide with WORKER_TYPES=${group}.`,
      }
    }
    const version = latest.version ? ` (version ${latest.version})` : ''
    if (latest.ageSec <= WORKER_STALE_SEC) {
      return { id: `workers.${group}`, title, status: 'ok' as const, summary: `Last seen ${agoText(latest.ageSec)}${version}.` }
    }
    return {
      id: `workers.${group}`,
      title,
      status: 'attention' as const,
      summary: `Last seen ${agoText(latest.ageSec)}: it has stopped.`,
      fix: 'Railway → the worker service → Deployments → open the latest one’s logs; Redeploy if it crashed.',
    }
  })
}

// --- i. email and legal ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function legalChecks(deps: SetupDeps): SetupCheck[] {
  const c = deps.config
  const links = [
    { href: '/privacy', label: 'Privacy policy' },
    { href: '/terms', label: 'Terms' },
    { href: '/contact', label: 'Contact' },
  ]
  const support: SetupCheck = !c.SUPPORT_EMAIL
    ? {
        id: 'legal.support_email',
        title: 'Support email',
        status: 'unset',
        summary: 'SUPPORT_EMAIL is not set: the legal and contact pages show a placeholder.',
        fix: `${VERCEL_ENV} → add SUPPORT_EMAIL (the address customers write to) → ${REDEPLOY}.`,
      }
    : EMAIL_RE.test(c.SUPPORT_EMAIL)
      ? { id: 'legal.support_email', title: 'Support email', status: 'ok', summary: c.SUPPORT_EMAIL }
      : {
          id: 'legal.support_email',
          title: 'Support email',
          status: 'attention',
          summary: `SUPPORT_EMAIL (“${c.SUPPORT_EMAIL}”) does not look like an email address.`,
          fix: `Fix it in ${VERCEL_ENV}, ${REDEPLOY}.`,
        }
  const missing = (['LEGAL_ENTITY_NAME', 'LEGAL_JURISDICTION', 'LEGAL_EFFECTIVE_DATE'] as const).filter((k) => !c[k])
  const badDate = c.LEGAL_EFFECTIVE_DATE && (!DATE_RE.test(c.LEGAL_EFFECTIVE_DATE) || Number.isNaN(Date.parse(`${c.LEGAL_EFFECTIVE_DATE}T00:00:00Z`)))
  const pages: SetupCheck =
    missing.length > 0
      ? {
          id: 'legal.pages',
          title: 'Privacy, terms and contact pages',
          status: 'unset',
          summary: `Placeholders shown for: ${missing.join(', ')}.`,
          fix: `${VERCEL_ENV} → add LEGAL_ENTITY_NAME (your name or company), LEGAL_JURISDICTION (for example: the State of Delaware, United States) and LEGAL_EFFECTIVE_DATE (today, as YYYY-MM-DD) → ${REDEPLOY}.`,
          details: ['Have a lawyer read the pages before you take real customers.'],
          links,
        }
      : badDate
        ? {
            id: 'legal.pages',
            title: 'Privacy, terms and contact pages',
            status: 'attention',
            summary: 'LEGAL_EFFECTIVE_DATE should be a date written as YYYY-MM-DD.',
            fix: `Fix it in ${VERCEL_ENV}, ${REDEPLOY}.`,
            links,
          }
        : {
            id: 'legal.pages',
            title: 'Privacy, terms and contact pages',
            status: 'ok',
            summary: `They name ${c.LEGAL_ENTITY_NAME} and ${c.LEGAL_JURISDICTION}, effective ${c.LEGAL_EFFECTIVE_DATE}.`,
            details: ['Have a lawyer read the pages before you take real customers. Put the privacy and terms links into Stripe (Settings → Public details).'],
            links,
          }
  return [support, pages]
}

// --- j. connect -----------------------------------------------------------------------------------

export function connectCheck(deps: SetupDeps): SetupCheck {
  const c = deps.config
  const mcpUrl = c.MCP_RESOURCE_URL ?? `${c.APP_URL}/api/mcp`
  const https = mcpUrl.startsWith('https://')
  return {
    id: 'connect.mcp',
    title: 'Connect your AI',
    status: https ? 'ok' : 'attention',
    summary: https ? mcpUrl : `${mcpUrl}: AI apps need a public https address.`,
    details: [
      `Claude: Settings → Connectors → Add custom connector → name it ${PRODUCT_NAME}, paste the URL → Connect → sign in → Allow.`,
      'ChatGPT: Settings → Apps & Connectors → Advanced settings → Developer mode on → Create → paste the URL, authentication OAuth → sign in → Allow.',
      'Claude Code: run the command below in a terminal, then type /mcp to sign in.',
    ],
    copies: [
      { label: 'Copy MCP URL', value: mcpUrl },
      { label: 'Copy Claude Code command', value: claudeCodeCommand(mcpUrl) },
    ],
    links: [{ href: '/app/connect', label: 'Connect page' }],
  }
}

// --- the report -----------------------------------------------------------------------------------

export async function runSetupChecks(deps: SetupDeps): Promise<SetupReport> {
  const [database, auth, storage, posting, key, catalog, webhook, portal, transcription, workers] = await Promise.all([
    databaseChecks(deps),
    guarded('auth.supabase', 'Sign-in (Supabase)', () => supabaseCheck(deps)),
    storageChecks(deps),
    postingChecks(deps),
    guarded('stripe.key', 'Stripe key', () => stripeKeyCheck(deps)),
    guarded('stripe.catalog', 'Plans and add-ons in Stripe', () => catalogCheck(deps)),
    guarded('stripe.webhook', 'Stripe webhook', () => webhookCheck(deps)),
    guarded('stripe.portal', 'Customer portal (cancel, card, invoices)', () => portalCheck(deps)),
    guarded('transcription.engines', 'Transcription', () => transcriptionCheck(deps)),
    workerChecks(deps),
  ])
  const groups: SetupGroup[] = [
    { id: 'basics', title: 'Basics', checks: basicsChecks(deps) },
    { id: 'database', title: 'Database', checks: database },
    { id: 'auth', title: 'Sign-in', checks: [auth] },
    { id: 'storage', title: 'File storage', checks: storage },
    { id: 'posting', title: 'Posting', checks: posting },
    { id: 'billing', title: 'Billing (Stripe)', checks: [key, catalog, webhook, portal] },
    { id: 'transcription', title: 'Transcription', checks: [transcription] },
    { id: 'workers', title: 'Workers (Railway)', checks: workers },
    { id: 'legal', title: 'Email and legal pages', checks: legalChecks(deps) },
    { id: 'connect', title: 'Connect your AI', checks: [connectCheck(deps)] },
  ]
  const report: SetupReport = {
    generatedAt: deps.now().toISOString(),
    testMode: deps.config.POSTING_PROVIDER === 'fake',
    appEnv: deps.config.APP_ENV,
    groups,
    counts: countStatuses(groups),
  }
  return scrubReport(report, secretValues(deps.config))
}

export { secretValues }
