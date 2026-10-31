# Scaffold handoff: monorepo + `@app/core`

Owner: scaffold agent. Covers the repo root config, `scripts/`, `.env.example`, `.gitignore`, `packages/core/**`, and the first skeletons of every other package/app. Other agents: put requests for changes in these paths in the "Requests" section at the end.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | installs everything (all dependencies are already in the lockfile) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm test` | `vitest run --passWithNoTests` in every package (or `pnpm exec vitest run` from the root, using `test.projects`) |
| `pnpm lint` | `scripts/check-boundaries.mjs` |
| `pnpm -F @app/web build` | `next build` |
| `pnpm secrets` | prints fresh `TOKEN_ENCRYPTION_KEYS`, `SESSION_SECRET` and `CRON_SECRET` values |
| `pnpm -F @app/worker start` | `tsx src/main.ts` (skeleton) |

## Installed versions

Node ≥ 22 (runtime 22.23). TypeScript 5.9.3 (`~5.9.3`; not 7.x). Vitest 5.0.5 with **vite 8.3.5 added explicitly at the root** (vitest 5 has vite as a peer dependency). `@types/node` ^22 (matches the runtime). zod 4.6.7. Next 16.4.3, React 19.3.1, Tailwind 4.3.3 (`@tailwindcss/postcss`), `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.118, Stripe 23.1, `@modelcontextprotocol/sdk` 1.32.2, `@aws-sdk/client-s3` + presigner 3.1161, `@electric-sql/pglite` 0.5.13, `playwright-core` 1.63.0 (exact; uses the Chromium under `/opt/pw-browsers` through `PLAYWRIGHT_BROWSERS_PATH`), tsx 4.23.

Deviations, with reasons:
- **postgres ^3.4.9, not 4.0.0.** 4.0.0 is a new major published 2026-10-29 (two days ago). 3.4.x is the proven line; upgrade later on purpose.
- **`@app/web` also depends on `@electric-sql/pglite` and `postgres`.** They are in `serverExternalPackages`, and Next can only externalise packages it can resolve from the app directory (pnpm does not hoist).
- `pnpm-workspace.yaml` allows only esbuild's postinstall (`onlyBuiltDependencies`).
- `vitest.workspace.ts` (in ARCHITECTURE's layout) is replaced by the root `vitest.config.ts` with `test.projects`: Vitest 4+ dropped workspace files.

## Layout and package conventions

- Every package: `"type": "module"`, `"exports": {".": "./src/index.ts"}`, `tsconfig.json` extending `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, ES2022, ESNext/Bundler, `isolatedModules`, `types: ["node"]`), `vitest.config.ts` (node env; tests in `src/**/*.test.ts` or `test/**/*.test.ts`).
- Relative imports have **no file extension** (Bundler resolution; works in tsc, Vitest, Next and tsx).
- Workspace deps follow ARCHITECTURE: services → core+db; posting/storage/transcription → core; mcp → core+services; web → core+db+services+mcp+posting+storage; worker → core+db+services+posting+storage+transcription.
- Skeleton `src/index.ts` files export only a `*_PACKAGE` constant. Replace them freely.

## `@app/core` contents

Subpath exports: `@app/core/{types,ports,plans,platforms,validation,links,crypto,log,hash,errors,config,time,testing}`. **Browser-safe:** `types`, `plans`, `platforms`, `validation`, `links`, `time`, `errors`, `log`. **Server-only:** `crypto`, `hash`, `config` and the root `@app/core` (they use `node:crypto`). Client components must import a browser-safe subpath, never `@app/core`.

| Module | Main exports |
| --- | --- |
| `types` | `PLATFORMS`, `PLATFORM_LABELS`, all DB enum arrays (`PLAN_TIERS`, `SUBSCRIPTION_STATUSES`, `BRAND_STATUSES`, `ACCOUNT_STATUSES`, `MEDIA_*`, `CLIP_STATUSES`, `DRAFT_STATUSES`, `POST_STATUSES`, `JOB_STATUSES`, `USAGE_METERS`, `USAGE_KINDS`, `ACTORS`) + zod enums (`PlatformSchema`, ...), `LIVE_ACCOUNT_STATUSES`, `ACTIVE_POST_STATUSES`, `PROVIDER_NAMES`, `TRANSCRIPT_ENGINES`, `VOICE_PROFILE_SOURCES`, `JOB_TYPES` + `JOB_GROUP` (posting/media), `JobRow`, `METRIC_KEYS`/`Metrics`/`pickMetrics`, `TimedText`, `MCP_SCOPE = 'social'` |
| `ports` | `PostingProvider`, `ProviderAccount`, `PublishInput`, `PublishStatus`, `PastPostInput`, `ObjectStorage`, `Transcriber`, `TranscriptResult`, `Clock`: exactly as ARCHITECTURE |
| `plans` | `PLANS`, `ADD_ONS`, `STRIPE_LOOKUP_KEYS`, `planFromLookupKey`, `TRIAL`, `X_LINK_POSTS_PER_PLAN = 0`, `SOURCE_LIMITS` (4 h, 10 GB, 30-day retention), `entitlements(plan, addOns, status)`, `monthlyPriceCents`, `formatCents` |
| `platforms` | `graphemeCount`, `utf8Bytes`, `utf16Units`, `xWeightedLength`, `PLATFORM_RULES`, `CAPS_PER_24H`, `validateVariant(platform, variant, { media?, forPublish? })`, `countInBusiestWindow`, `wouldExceedCap`, `contentKindFor` |
| `validation` | `IdSchema`, `DraftInputSchema`, `VariantInputSchema`, `PlatformOptionsSchemas`, `UpsertVariantInputSchema`, `EditVariantInputSchema`, `ListDraftsInputSchema`, `RejectDraftInputSchema`, `ScheduleInputSchema` / `createScheduleInputSchema(clock)`, `PostStatusInputSchema`, `ClipRangeSchema`, `ClipRequestSchema`, `validateClipRanges`, `GetTranscriptInputSchema`, `TranscriptResultSchema`, `ALLOWED_MIME`, `UploadRequestSchema`, `DriveLinkInputSchema`, `VoiceProfileSchema`, `SaveVoiceProfileInputSchema`, `RenderCarouselInputSchema`, `RenderVideoInputSchema`, `RENDER_LIMITS`, `RENDER_SIZES`, `BrandInputSchema`, `ConnectAccountInputSchema`, `ImportPastPostsInputSchema`, `GetAnalyticsInputSchema` |
| `links` | `extractUrls`, `hasLink`, `countUniqueLinks`, `DRIVE_HOSTS`, `DRIVE_DOWNLOAD_HOSTS`, `checkSourceUrl`, `isAllowedDownloadHop`, `isVideoSiteHost`, `redactUrl`, `MAX_REDIRECT_HOPS` |
| `crypto` | `parseKeyRing`, `encrypt`/`decrypt`/`decryptString` (string form), `encryptBytes`/`decryptBytes` (bytea form), `needsReencrypt`, `reencrypt`, `sha256Hex`, `hmacSha256(Hex)`, `randomToken`, `safeEqual`, `uuidV5` |
| `log` | `createLogger`, `redact`, `scrubString`, `REDACT_KEY_PATTERN`, `silentLogger` |
| `hash` | `stableStringify`, `contentHash` |
| `errors` | `AppError(code, message, details?)`, `ERROR_CODES`, `HTTP_STATUS_BY_CODE`, `fromZodError`, `parseOrThrow`, `toErrorBody`, `notFound`, `ensure` |
| `config` | `ConfigSchema`, `loadConfig(env)`, `requireConfig(config, keys)`, `CONFIG_KEYS` |
| `time` | `systemClock`, `fixedClock`, `manualClock`, `calendarMonthPeriod`, `usagePeriod`, `rollingWindow`, `capQueryRange`, `parseTimestampToMs`, `formatMs`, `backoffMs`, `POST_METRIC_CHECKPOINTS_MS` |
| `testing` | `testConfig()`, `testKeyRing()`, `TEST_TOKEN_ENCRYPTION_KEYS`, `TEST_SESSION_SECRET`, `memoryLogger()`, clocks |

## Decisions (where ARCHITECTURE was silent or in tension)

1. **Platform caps = the lower of ARCHITECTURE's number and Upload-Post's cap**, the rule ARCHITECTURE applies to Instagram. Result: tiktok 15, youtube 10, instagram 50, facebook 25, **threads 50** (ARCHITECTURE: 250; Upload-Post: 50), x 20, linkedin 25, **pinterest 20** (Upload-Post: 20), bluesky 25. Scheduler check: load active posts in `capQueryRange(at)`, then `wouldExceedCap(platform, times, at)` (checks every 24 h window containing `at`).
2. **Trial** = Starter limits (1 brand, 1 clip hour) whatever plan was chosen; add-ons ignored during the trial. **past_due**: plan limits, `canPublish`/`canCreate` true, `canProcessMedia` false. **canceled/unpaid/none, or no plan**: every limit 0 and every flag false (read-only; nothing deleted). Add-on quantities are clamped (≤20 brands, ≤200 hours).
3. Storage GB = 10^9 bytes.
4. **IDs:** `IdSchema` accepts any 8-4-4-4-12 hex string (not only RFC version/variant bits) and lower-cases it, so fixtures like `1111…` work.
5. **Variant shape** (shared by MCP and web): `{ platform, text, title?, mediaIds[], connectedAccountId?, options }`, discriminated by platform. Strict objects: unknown keys fail. Options are camelCase per platform (adapter maps them to provider fields):
   - tiktok: `privacyLevel` (PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY), `disableComment/Duet/Stitch`, `brandContent`, `brandOrganic`, `isAiGenerated`, `coverTimestampMs`, `firstComment`
   - youtube: `privacyStatus`, `tags` (≤500 chars total), `categoryId`, `madeForKids`, `containsSyntheticMedia`, `playlistId`, `firstComment`
   - instagram: `mediaType` (REELS | STORIES), `shareToFeed`, `collaborators` (≤3), `thumbOffsetMs`, `locationId`, `firstComment`
   - facebook: `mediaType` (REELS | STORIES | VIDEO), `pageId`, `firstComment`
   - threads: `topicTag`, `replyControl`, `firstComment`
   - x: `longTextMode` (thread | single_post; required for text over 280), `replySettings`, `firstComment`
   - linkedin: `visibility`, `pageId`, `firstComment`
   - pinterest: `boardId`, `link` (https), `altText` (no first comment)
   - bluesky: `altText`, `langs` (≤3), `firstComment`
6. **`validateVariant` severities:** `error` = invalid now (too long, links on X, bad title, too many media...). `warning` = incomplete for publishing (media missing on a media-only platform, TikTok `privacyLevel` unset, Pinterest `boardId` unset) or ignored input (a title where none exists). With `{ forPublish: true }` the incompleteness warnings become errors: use that in `approve`/`schedule`. `DraftInputSchema` adds only `error` issues to zod. Pass `media` facts (kind, bytes, durationMs) to also check durations and sizes.
7. **X links:** `X_LINK_POSTS_PER_PLAN = 0` makes `PLATFORM_RULES.x.linksAllowed` false, so any URL (twitter-text style detection, including bare domains like `example.com`) in X text or first comment is a validation error with a clear message. Raising the constant enables links; metering then uses `hasLink()`.
8. **Text units:** X weighted (NFC, URL = 23, emoji = 2, weight-1 ranges from twitter-text v3); Bluesky 300 graphemes and 3,000 UTF-8 bytes; Threads 500 UTF-8 bytes (Upload-Post's stricter rule); YouTube description 5,000 UTF-8 bytes; everything else UTF-16. Bare-domain detection uses the TLD list in `packages/core/src/tlds.ts` (PSL snapshot 2025-12-28).
9. **Scheduling input:** `at` is an ISO 8601 timestamp **with offset** or the literal `"now"`; it must not be in the past and must be at most 120 days ahead; the output is a normalised UTC ISO string. `platforms` is optional (default: all approved variants).
10. **Clips:** ranges of 3–180 s, at most 30 per request, timestamps as ms numbers or strings (`"1:02:03.5"`, `"02:03"`, `"12.5s"`). `captionStyle`: bold (default) | minimal | karaoke | none. `validateClipRanges(ranges, durationMs)` checks against the source once its duration is known.
11. **Voice profile JSON** keeps ARCHITECTURE's snake_case keys: `tone`, `audience`, `vocabulary[]`, `do[]`, `dont[]`, `emoji_policy` (none | sparing | moderate | heavy), `hashtag_policy` (none | few | moderate | many), `sample_posts[{platform?, text}]` (≤30).
12. **Renders** take media only by asset id (never URLs). Carousel: 1–20 slides, templates minimal | bold | quote | list | photo, aspect 4:5 (default, 1080×1350) | 1:1 | 9:16. Video: 1–35 slides of 1–15 s (default 5 s), total ≤ 180 s, templates text_slides | quote | captioned_images, aspect 9:16 (default) | 1:1 | 16:9. Theme: three hex colours + font preset (sans | serif | mono | rounded | condensed); the renderer maps presets to installed fonts.
13. **Uploads:** allowed MIME types per kind in `ALLOWED_MIME` (never SVG); size caps in `MAX_UPLOAD_BYTES` (video 10 GB). Drive links need `rightsAttested: true`; `checkSourceUrl()` accepts only https links on drive.google.com, docs.google.com, dropbox.com, www.dropbox.com, dl.dropboxusercontent.com, onedrive.live.com, 1drv.ms, with no credentials, port or IP. YouTube and other video/social sites get `video_site_forbidden` with a neutral message. Download redirects are checked with `isAllowedDownloadHop()`.
14. **Encryption format:** string `"<version>:<iv>:<ciphertext>:<tag>"` (base64url) or bytes `[0x01][len][version][iv 12][tag 16][ciphertext]` for `bytea` columns. Pass an AAD such as `"connected_accounts:encrypted_credentials:<row id>"`; decrypt needs the same AAD. Rotation: prepend a new key to `TOKEN_ENCRYPTION_KEYS`, re-encrypt rows where `needsReencrypt()`.
15. **Logger:** JSON lines. The redaction key pattern is ARCHITECTURE's plus `passwd`, `credential`, `private_key`, `signature`, `session_secret`. Strings are scrubbed of Bearer/Apikey/Basic credentials, JWTs, Stripe secret keys and secret query parameters.
16. **Config** keeps env-var names as keys (`config.UPLOAD_POST_API_KEY`), coerces numbers and flags, treats empty strings as unset, and derives `MCP_RESOURCE_URL` (default `APP_URL/api/mcp`) and `R2_ENDPOINT`. `WORKER_TYPES` becomes an array of `posting`/`media`. Driver choices make their variables required. `APP_ENV=production` additionally requires `DATABASE_URL`, `TOKEN_ENCRYPTION_KEYS`, `SESSION_SECRET`, https `APP_URL`, and non-fake posting/storage/transcription, and refuses `DEV_AUTH`. Error messages name variables, never values. Use `requireConfig(config, ['STRIPE_SECRET_KEY'])` in routes that need optional keys. The Upload-Post default base URL lives only in the posting adapter (the boundary check forbids it elsewhere).
17. `JobRow` lives in `@app/core` (camelCase fields, `Date` for timestamptz) so the DB layer and worker share it.
18. `next-env.d.ts` is git-ignored: Next regenerates it, and it imports `.next/types/*`, which do not exist on a fresh clone.

## Skeletons

- `apps/web`: Next 16 App Router + Tailwind v4 (`app/globals.css`, `postcss.config.mjs`), `next.config.ts` (`transpilePackages` for every `@app/*` package, `serverExternalPackages: ['@electric-sql/pglite', 'postgres']`, `turbopack.root` and `outputFileTracingRoot` = repo root), `app/layout.tsx`, placeholder `app/page.tsx`, `@/*` path alias.
  - `lib/auth.ts`: `getCurrentUser()`, `requireUser()` (redirects to `/login`), `getUserFromRequest(req)`, `createDevSessionCookie(email)`, `signDevSession`/`verifyDevSession`, `devUserId(email)` (UUID v5 of the normalised email), `DEV_SESSION_COOKIE = 'dev_session'` (30 days). Supabase via `@supabase/ssr` when `SUPABASE_URL` is set; the dev cookie is checked first when `DEV_AUTH=1`. All functions accept `{ env, fetch, now }` for tests. Tested in `test/auth.test.ts`, including the Supabase path with mocked HTTP.
  - `next build` passes. A throwaway route importing `@app/core` and `lib/auth` built and served correctly (then removed).
- `apps/worker`: `src/types.ts` (`Handler`, `WorkerContext` placeholder: `workerId`, `logger`, `clock`, `signal?`; `JobRow` re-exported), `src/media/index.ts` (`mediaHandlers = {}`), `src/index.ts`, `src/main.ts` (loads config, logs, exits).
- `packages/{db,services,posting,storage,transcription,mcp}`: stub `src/index.ts` only.

## Boundary check (`pnpm lint`)

Fails when `upload-post.com` or `api.upload-post` appears in any source/config file outside `packages/posting/src/upload-post/` (posting's own tests are exempt; `docs/`, `node_modules`, build output and the lockfile are skipped), or when any `package.json` depends on a YouTube downloader (`ytdl-core`, `@distube/ytdl-core`, `yt-dlp*`, `youtube-dl*`, `play-dl`, `youtubei.js`).

## Test counts

`@app/core`: 13 files, 263 tests. `@app/web`: 1 file, 9 tests. The other packages have no tests yet (`--passWithNoTests`).

## Notes for other agents

- **DB:** enum arrays in `types.ts` must match the SQL enums in order. `CAPS_PER_24H` / `PLATFORM_RULES` are the source for any SQL copy of the caps. Draft `content_hash` is computed in SQL by the trigger (ARCHITECTURE); `contentHash()` in core is a generic helper and does not need to match it.
- **MCP:** every input schema in `validation.ts` converts with `z.toJSONSchema(schema, { io: 'input' })` (tested); the SDK uses `io: 'input'` for tool inputs. Object schemas with refinements are still `ZodObject`s in zod 4, so `.shape` works if you need a raw shape. Error messages are neutral (no upsell), as OpenAI's store requires.
- **Posting:** map the camelCase options above to Upload-Post fields inside the adapter. Use `disable_inbox_fallback=true` for TikTok and `show_calendar:false` for connect links (see research). The default base URL goes in the adapter.
- **Worker:** `config.WORKER_TYPES` is already an array; `JOB_GROUP[type]` says which group runs a job. Use `backoffMs(attempt)` for retries and `POST_METRIC_CHECKPOINTS_MS` for analytics pulls.
- **Web:** use `@app/core/validation` (browser-safe) in client components.

## Gaps

- The X weighted counter and URL detection reimplement twitter-text (no new dependency allowed). Bare internationalised domains (e.g. `例え.jp`) are not detected; this over-counts length, which errs on the safe side.
- Image MIME rules per platform (e.g. Instagram JPEG-only) are not enforced in `validateVariant`; Upload-Post's conversion behaviour is unverified.

## Requests

(none yet)
