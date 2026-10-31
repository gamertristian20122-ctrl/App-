// Environment configuration: one zod schema for every variable the system reads.
// loadConfig(env) validates and returns a typed, frozen object (keys keep their env names).
// Error messages name the variables but never include their values.

import { z } from 'zod'
import { CryptoError, parseKeyRing } from './crypto'
import { AppError } from './errors'
import { LOG_LEVELS } from './log'
import { WORKER_GROUPS } from './types'

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const optionalString = z.preprocess(emptyToUndefined, z.string().optional())
const optionalSecret = (min = 1) => z.preprocess(emptyToUndefined, z.string().min(min).optional())
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional())
const optionalPriceId = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^price_[A-Za-z0-9]{6,}$/, 'Must be a Stripe price id (price_…).')
    .optional(),
)
const flag = z.preprocess(
  (v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()) : Boolean(v)),
  z.boolean(),
)
const int = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def))

export const ConfigSchema = z
  .object({
    // --- runtime -------------------------------------------------------------
    NODE_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'test', 'production']).default('development')),
    /** Deployment stage. production turns on the strict checks below. */
    APP_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'test', 'preview', 'production']).default('development')),
    /** Public base URL of the web app (no trailing slash). */
    APP_URL: z.preprocess(emptyToUndefined, z.url().default('http://localhost:3000')),
    /** Canonical MCP resource URL; default APP_URL + "/api/mcp". */
    MCP_RESOURCE_URL: optionalUrl,
    LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default('info')),

    // --- database ------------------------------------------------------------
    /** Postgres connection string (Supabase pooler). Without it, local dev uses PGlite. */
    DATABASE_URL: optionalString,
    DATABASE_POOL_MAX: int(5, 1, 100),
    /** PGlite data directory for local dev ("memory" = in-memory). */
    PGLITE_DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('.data/pglite')),

    // --- auth ------------------------------------------------------------------
    SUPABASE_URL: optionalUrl,
    SUPABASE_ANON_KEY: optionalSecret(),
    /** Only for admin tasks (never sent to the browser). */
    SUPABASE_SERVICE_ROLE_KEY: optionalSecret(),
    /** Enables the local email-only login. Refused when APP_ENV=production. */
    DEV_AUTH: flag.default(false),
    /** HMAC key for signed cookies and links (≥32 chars). */
    SESSION_SECRET: optionalSecret(32),

    // --- secrets at rest ------------------------------------------------------
    /** "v2:base64key,v1:base64key", newest first; each key 32 bytes. */
    TOKEN_ENCRYPTION_KEYS: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .superRefine((spec, ctx) => {
          try {
            parseKeyRing(spec)
          } catch (e) {
            ctx.addIssue({ code: 'custom', message: e instanceof CryptoError ? e.message : 'Invalid key ring.' })
          }
        })
        .optional(),
    ),

    // --- our OAuth authorization server (for MCP clients) ---------------------
    OAUTH_ACCESS_TOKEN_TTL_SEC: int(3_600, 60, 86_400),
    OAUTH_REFRESH_TOKEN_TTL_SEC: int(30 * 86_400, 3_600, 365 * 86_400),
    OAUTH_CODE_TTL_SEC: int(300, 30, 600),
    APPROVAL_NONCE_TTL_SEC: int(7 * 86_400, 300, 30 * 86_400),

    // --- posting provider -----------------------------------------------------
    POSTING_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['upload_post', 'fake']).default('fake')),
    /**
     * Fake provider only: report every platform as connected for every brand. The fake keeps
     * state in memory, which serverless hosts (Vercel) do not share between requests, so test
     * deployments need this for connected accounts to stick.
     */
    FAKE_POSTING_CONNECT_ALL: flag.default(false),
    UPLOAD_POST_API_KEY: optionalSecret(),
    /** Override the provider API base URL (tests, proxies). The adapter has the default. */
    UPLOAD_POST_BASE_URL: optionalUrl,
    UPLOAD_POST_WEBHOOK_SECRET: optionalSecret(),
    /** Profile username prefix (default "brand_"); lets staging share the production Upload-Post account. */
    UPLOAD_POST_PROFILE_PREFIX: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_@-]{1,40}$/, 'Use 1–40 letters, digits, "_", "@" or "-".')
        .optional(),
    ),

    // --- object storage -------------------------------------------------------
    STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(['r2', 'fs', 'memory']).default('fs')),
    STORAGE_FS_DIR: z.preprocess(emptyToUndefined, z.string().default('.data/storage')),
    R2_ACCOUNT_ID: optionalString,
    R2_ACCESS_KEY_ID: optionalSecret(),
    R2_SECRET_ACCESS_KEY: optionalSecret(),
    R2_BUCKET: optionalString,
    /** Default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com */
    R2_ENDPOINT: optionalUrl,

    // --- transcription --------------------------------------------------------
    /** "chain" = Whisper first, AssemblyAI fallback. */
    TRANSCRIPTION_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(['chain', 'whisper', 'assemblyai', 'fake']).default('fake'),
    ),
    /** Base URL of a self-hosted OpenAI-compatible Whisper server (…/v1). */
    WHISPER_URL: optionalUrl,
    WHISPER_API_KEY: optionalSecret(),
    WHISPER_MODEL: z.preprocess(emptyToUndefined, z.string().default('whisper-1')),
    ASSEMBLYAI_API_KEY: optionalSecret(),
    ASSEMBLYAI_BASE_URL: optionalUrl,

    // --- billing ----------------------------------------------------------------
    STRIPE_SECRET_KEY: optionalSecret(),
    STRIPE_WEBHOOK_SECRET: optionalSecret(),
    /** Optional Stripe price ids; without them prices are found by lookup key (core plans.ts). */
    STRIPE_PRICE_STARTER: optionalPriceId,
    STRIPE_PRICE_PLUS: optionalPriceId,
    STRIPE_PRICE_PRO: optionalPriceId,
    STRIPE_PRICE_EXTRA_BRAND: optionalPriceId,
    STRIPE_PRICE_EXTRA_CLIP_HOUR: optionalPriceId,

    // --- cron ---------------------------------------------------------------------
    /** Vercel cron sends "Authorization: Bearer <CRON_SECRET>". */
    CRON_SECRET: optionalSecret(16),

    // --- worker ---------------------------------------------------------------
    /** Comma list of worker groups to run: posting, media (or "all"). */
    WORKER_TYPES: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .default('all')
        .transform((s, ctx) => {
          const parts = s
            .split(',')
            .map((p) => p.trim().toLowerCase())
            .filter(Boolean)
          if (parts.includes('all')) return [...WORKER_GROUPS]
          const bad = parts.filter((p) => !(WORKER_GROUPS as readonly string[]).includes(p))
          if (bad.length > 0 || parts.length === 0) {
            ctx.addIssue({ code: 'custom', message: `Use a comma list of ${WORKER_GROUPS.join(', ')} or "all".` })
            return z.NEVER
          }
          return [...new Set(parts)] as (typeof WORKER_GROUPS)[number][]
        }),
    ),
    WORKER_ID: optionalString,
    WORKER_CONCURRENCY: int(2, 1, 32),
    WORKER_POLL_INTERVAL_MS: int(1_000, 100, 60_000),
    /** Health-check port (Railway sets PORT). */
    PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65_535).optional()),
    FFMPEG_PATH: z.preprocess(emptyToUndefined, z.string().default('ffmpeg')),
    FFPROBE_PATH: z.preprocess(emptyToUndefined, z.string().default('ffprobe')),
    /** Chromium executable for playwright-core (renderer). */
    CHROMIUM_PATH: optionalString,
    /** Scratch directory for media work. */
    MEDIA_TMP_DIR: z.preprocess(emptyToUndefined, z.string().default('tmp/media')),
  })
  .superRefine((c, ctx) => {
    const need = (key: string, when: string) =>
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required ${when}.` })
    const prod = c.APP_ENV === 'production'

    if (c.DEV_AUTH && prod) {
      ctx.addIssue({ code: 'custom', path: ['DEV_AUTH'], message: 'DEV_AUTH must be off in production.' })
    }
    if (c.DEV_AUTH && !c.SESSION_SECRET) need('SESSION_SECRET', 'when DEV_AUTH is on')
    if (c.SUPABASE_URL && !c.SUPABASE_ANON_KEY) need('SUPABASE_ANON_KEY', 'when SUPABASE_URL is set')
    if (c.POSTING_PROVIDER === 'upload_post' && !c.UPLOAD_POST_API_KEY) {
      need('UPLOAD_POST_API_KEY', 'when POSTING_PROVIDER=upload_post')
    }
    if (c.STORAGE_DRIVER === 'r2') {
      for (const key of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const) {
        if (!c[key]) need(key, 'when STORAGE_DRIVER=r2')
      }
      if (!c.R2_ACCOUNT_ID && !c.R2_ENDPOINT) need('R2_ACCOUNT_ID', 'when STORAGE_DRIVER=r2 (or set R2_ENDPOINT)')
    }
    if ((c.TRANSCRIPTION_PROVIDER === 'whisper' || c.TRANSCRIPTION_PROVIDER === 'chain') && !c.WHISPER_URL) {
      need('WHISPER_URL', `when TRANSCRIPTION_PROVIDER=${c.TRANSCRIPTION_PROVIDER}`)
    }
    if ((c.TRANSCRIPTION_PROVIDER === 'assemblyai' || c.TRANSCRIPTION_PROVIDER === 'chain') && !c.ASSEMBLYAI_API_KEY) {
      need('ASSEMBLYAI_API_KEY', `when TRANSCRIPTION_PROVIDER=${c.TRANSCRIPTION_PROVIDER}`)
    }
    if (prod) {
      if (!c.DATABASE_URL) need('DATABASE_URL', 'in production')
      if (!c.TOKEN_ENCRYPTION_KEYS) need('TOKEN_ENCRYPTION_KEYS', 'in production')
      if (!c.SESSION_SECRET) need('SESSION_SECRET', 'in production')
      if (c.POSTING_PROVIDER === 'fake') {
        ctx.addIssue({ code: 'custom', path: ['POSTING_PROVIDER'], message: 'POSTING_PROVIDER=fake is not allowed in production.' })
      }
      if (c.STORAGE_DRIVER !== 'r2') {
        ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'STORAGE_DRIVER must be r2 in production.' })
      }
      if (c.TRANSCRIPTION_PROVIDER === 'fake') {
        ctx.addIssue({
          code: 'custom',
          path: ['TRANSCRIPTION_PROVIDER'],
          message: 'TRANSCRIPTION_PROVIDER=fake is not allowed in production.',
        })
      }
      if (!c.APP_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'APP_URL must be https in production.' })
      }
    }
  })
  .transform((c) => {
    const appUrl = c.APP_URL.replace(/\/+$/, '')
    return {
      ...c,
      APP_URL: appUrl,
      MCP_RESOURCE_URL: (c.MCP_RESOURCE_URL ?? `${appUrl}/api/mcp`).replace(/\/+$/, ''),
      R2_ENDPOINT:
        c.R2_ENDPOINT ?? (c.R2_ACCOUNT_ID ? `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined),
      WORKER_TYPES: c.WORKER_TYPES as (typeof WORKER_GROUPS)[number][],
    }
  })

export type Config = Readonly<z.output<typeof ConfigSchema>>
export type ConfigKey = keyof z.input<typeof ConfigSchema>

/** Every variable name the system reads (used by .env.example and docs). */
export const CONFIG_KEYS = Object.keys(ConfigSchema.in.shape) as ConfigKey[]

export type EnvSource = Readonly<Record<string, string | undefined>>

/**
 * Fills APP_URL from Vercel's stable production domain when it is not set, so a first deploy
 * works before the owner knows the URL. An explicit APP_URL always wins.
 */
export function withHostDefaults(env: EnvSource): EnvSource {
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  if (env.APP_URL?.trim() || !vercelHost) return env
  return { ...env, APP_URL: `https://${vercelHost}` }
}

/**
 * Validates the environment. Throws AppError('internal') listing the problems by variable name
 * (values are never included in the message).
 */
export function loadConfig(env: EnvSource = process.env): Config {
  const result = ConfigSchema.safeParse(withHostDefaults(env))
  if (!result.success) {
    const problems = result.error.issues.map((i) => {
      const key = i.path.map(String).join('.') || 'env'
      return i.message.startsWith(key) ? i.message : `${key}: ${i.message}`
    })
    throw new AppError('internal', `Invalid configuration: ${problems.join('; ')}`, {
      keys: [...new Set(result.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean),
    })
  }
  return Object.freeze(result.data)
}

/** Throws when any of `keys` is missing, e.g. requireConfig(config, ['STRIPE_SECRET_KEY']) in a route. */
export function requireConfig<K extends keyof Config>(
  config: Config,
  keys: readonly K[],
): { [P in K]-?: NonNullable<Config[P]> } {
  const missing = keys.filter((k) => config[k] === undefined || config[k] === null || config[k] === '')
  if (missing.length > 0) {
    throw new AppError('unavailable', `This feature is not configured (missing ${missing.join(', ')}).`, {
      missing: missing.map(String),
    })
  }
  return config as unknown as { [P in K]-?: NonNullable<Config[P]> }
}
