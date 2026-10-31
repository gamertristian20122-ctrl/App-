// Bucket-level checks for the owner's /setup page: is the bucket reachable, and does its CORS
// policy let the browser upload straight to it from the app (presigned PUTs) and read the ETag of
// multipart parts? R2Storage talks to R2 (HeadBucket, GetBucketCors, PutBucketCors); the local
// drivers keep the policy in memory so the same checks run in tests and local development.
// Pure helpers here; no I/O.

import { z } from 'zod'
import { storageError } from './errors'

/** One CORS rule (S3 / R2 shape, camel-cased). */
export interface CorsRule {
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  exposeHeaders: string[]
  maxAgeSeconds?: number
}

export interface BucketAdmin {
  /** Resolves when the bucket exists and the credentials may use it; throws a storage AppError otherwise. */
  headBucket(): Promise<void>
  /** The bucket's CORS rules ([] when it has none). */
  getBucketCors(): Promise<CorsRule[]>
  /** Replaces the bucket's CORS rules. */
  putBucketCors(rules: CorsRule[]): Promise<void>
}

export function supportsBucketAdmin<T extends object>(storage: T): storage is T & BucketAdmin {
  const s = storage as Partial<BucketAdmin>
  return typeof s.headBucket === 'function' && typeof s.getBucketCors === 'function' && typeof s.putBucketCors === 'function'
}

/** What a presigned browser upload needs (docs/DEPLOY.md, step 3). */
export const UPLOAD_CORS = {
  methods: ['PUT', 'GET', 'HEAD'],
  /** The browser sends Content-Type with a single PUT (it is part of the signature). */
  headers: ['content-type'],
  /** Multipart uploads read each part's ETag. */
  expose: ['ETag'],
  maxAgeSeconds: 3600,
} as const

const OriginSchema = z
  .string()
  .url()
  .transform((s) => new URL(s))
  .refine((u) => u.protocol === 'https:' || u.protocol === 'http:', 'Must be an http(s) URL.')

/** "https://app.example.com/some/path" → "https://app.example.com" (CORS compares origins). */
export function originOf(appUrl: string): string {
  const parsed = OriginSchema.safeParse(appUrl)
  if (!parsed.success) throw storageError('invalid_input', 'The app URL is not a valid http(s) URL.')
  return parsed.data.origin
}

/** The rule /setup writes for the app's origin. */
export function uploadCorsRule(appUrl: string): CorsRule {
  return {
    allowedOrigins: [originOf(appUrl)],
    allowedMethods: [...UPLOAD_CORS.methods],
    allowedHeaders: [...UPLOAD_CORS.headers],
    exposeHeaders: [...UPLOAD_CORS.expose],
    maxAgeSeconds: UPLOAD_CORS.maxAgeSeconds,
  }
}

/** The policy as the Cloudflare dashboard's CORS editor expects it (for copy and paste). */
export function corsPolicyJson(rules: CorsRule[]): string {
  return JSON.stringify(
    rules.map((r) => ({
      AllowedOrigins: r.allowedOrigins,
      AllowedMethods: r.allowedMethods,
      AllowedHeaders: r.allowedHeaders,
      ExposeHeaders: r.exposeHeaders,
      ...(r.maxAgeSeconds !== undefined ? { MaxAgeSeconds: r.maxAgeSeconds } : {}),
    })),
    null,
    2,
  )
}

const lower = (list: readonly string[]) => list.map((s) => s.trim().toLowerCase())

function originMatches(pattern: string, origin: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/\/+$/, '')
  if (p === '*') return true
  if (!p.includes('*')) return p === origin
  // S3 allows one "*" wildcard, e.g. https://*.example.com
  const [head, tail] = p.split('*', 2) as [string, string]
  return origin.startsWith(head) && origin.endsWith(tail) && origin.length >= head.length + tail.length
}

/**
 * What is missing for browser uploads from `appUrl` (empty = the policy works). Messages are plain
 * English for the owner.
 */
export function corsProblems(rules: readonly CorsRule[], appUrl: string): string[] {
  const origin = originOf(appUrl).toLowerCase()
  const forOrigin = rules.filter((r) => r.allowedOrigins.some((o) => originMatches(o, origin)))
  if (forOrigin.length === 0) return [`No CORS rule allows ${origin}.`]
  const has = (pick: (r: CorsRule) => readonly string[], value: string) =>
    forOrigin.some((r) => lower(pick(r)).some((v) => v === '*' || v === value.toLowerCase()))
  const problems: string[] = []
  const methods = ['PUT', 'GET'].filter((m) => !has((r) => r.allowedMethods, m))
  if (methods.length > 0) problems.push(`The CORS rule does not allow ${methods.join(' and ')}.`)
  if (!has((r) => r.allowedHeaders, 'content-type')) problems.push('The CORS rule does not allow the Content-Type header.')
  if (!forOrigin.some((r) => lower(r.exposeHeaders).includes('etag'))) problems.push('The CORS rule does not expose the ETag header (needed for large uploads).')
  return problems
}

/** Existing rules with the app's rule added (rules for other origins are kept; ours is replaced). */
export function withUploadCorsRule(existing: readonly CorsRule[], appUrl: string): CorsRule[] {
  const ours = uploadCorsRule(appUrl)
  const origin = ours.allowedOrigins[0] as string
  const others = existing
    .map((r) => ({ ...r, allowedOrigins: r.allowedOrigins.filter((o) => o.trim().toLowerCase().replace(/\/+$/, '') !== origin.toLowerCase()) }))
    .filter((r) => r.allowedOrigins.length > 0)
  return [...others, ours]
}

const RuleSchema = z.object({
  allowedOrigins: z.array(z.string().min(1).max(500)).min(1).max(50),
  allowedMethods: z.array(z.enum(['GET', 'PUT', 'POST', 'DELETE', 'HEAD'])).min(1),
  allowedHeaders: z.array(z.string().min(1).max(200)).max(50),
  exposeHeaders: z.array(z.string().min(1).max(200)).max(50),
  maxAgeSeconds: z.number().int().min(0).max(86_400).optional(),
})

/** Validates rules before they are sent (our own code builds them; this guards the boundary). */
export function checkCorsRules(rules: unknown): CorsRule[] {
  const parsed = z.array(RuleSchema).min(1).max(100).safeParse(rules)
  if (!parsed.success) throw storageError('invalid_input', 'Invalid CORS rules.')
  return parsed.data
}
