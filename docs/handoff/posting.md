# Posting handoff: `@app/posting`

Owner: posting agent. Covers `packages/posting/**`: the `PostingProvider` implementations (Upload-Post adapter and fake), the Upload-Post webhook verifier/parser and the factory. Requests for changes elsewhere are at the end.

## What exists

| Path | Contents |
| --- | --- |
| `src/index.ts` | `createPostingProvider({ kind: 'upload_post' \| 'fake', ... })`, `createPostingProviderFromConfig(config, deps)`, `webhookSecrets(value)`, and re-exports of everything below |
| `src/errors.ts` | `providerError`, `providerErrorReason`, `isRetryableProviderError`, `retryAfterSeconds`, `safeProviderMessage`, `PROVIDER_ERROR_REASONS`, `ERROR_CODE_BY_REASON` |
| `src/publish-input.ts` | `parsePublishInput` (zod; shared by both providers), `ProfileRefSchema`, `RequestIdSchema`, `IdempotencyKeySchema`, `RedirectUrlSchema`, `TEXT_PLATFORMS`, `PHOTO_PLATFORMS` |
| `src/upload-post/client.ts` | `UploadPostClient`: injected fetch, `Authorization: Apikey <key>`, timeout, error mapping, local X-RateLimit gate. Private to the adapter: not exported from the package root, and the provider keeps it private |
| `src/upload-post/provider.ts` | `UploadPostProvider` (every port method + `getProfile`, `createProfile`, `renameProfile`, `listDestinations` for Facebook pages / LinkedIn pages / Pinterest boards, `rateLimitState`) |
| `src/upload-post/fields.ts` | `buildPublishRequest` (variant options → multipart fields), `requestIdFor`, `platformFromRequestId` |
| `src/upload-post/status.ts` | `mapUploadStatus`, `resultToStatus` (status endpoint and webhook results → `PublishStatus`) |
| `src/upload-post/metrics.ts` | `normalizeMetrics` (provider metric spellings → our `Metrics`) |
| `src/upload-post/webhook.ts` | `verifyUploadPostSignature`, `parseUploadPostWebhook`, `parseUploadPostWebhookPayload`, `signUploadPostWebhook` (tests/dev) |
| `src/fake/provider.ts` | `FakePostingProvider` |

Tests: 7 files, 174 tests (`pnpm -F @app/posting test`), all with mocked fetch. `pnpm -F @app/posting typecheck` passes; `pnpm lint` (boundary check) passes.

## How to use it (services / worker / web)

```ts
import { createPostingProviderFromConfig, isRetryableProviderError, retryAfterSeconds, parseUploadPostWebhook, webhookSecrets } from '@app/posting'
const provider = createPostingProviderFromConfig(config, { logger, clock })   // fetch defaults to global fetch
```

- **Brand created:** `ensureProfile({ brandId, profileRef: brand.provider_profile_ref, displayName: brand.name })` → store `profileRef` in `brands.provider_profile_ref`. Idempotent: the username is `brand_<brandId>` (prefix configurable) and a 409 counts as success, so a lost response is safe to retry. With an existing `profileRef` it GETs it, PATCHes the display name if it changed, or recreates it if missing.
- **connect_account:** `createConnectLink({ profileRef, platforms: [platform], redirectUrl })` → hosted page URL (48 h). After the user returns (or on an `account_status` webhook), call `listAccounts(profileRef)` and upsert `connected_accounts` from `{ platform, externalId, handle, displayName, status }`.
- **Brand archived/deleted / churn:** `deleteProfile(profileRef)` frees the provider slot (404 = already gone). `disconnect({ profileRef, platform })` is idempotent too.
- **publish_post job:** `publish({ profileRef, platform, kind, text, title, mediaUrls, options, idempotencyKey })` with `kind = contentKindFor(media)`, `options` = the variant's validated camelCase options, `mediaUrls` = presigned R2 GET URLs (give them ≥ 1 h TTL: the provider downloads asynchronously), `idempotencyKey` stable per post (suggest `post:<postId>`). Store the returned `requestId` in `posts.provider_request_id`, then enqueue `check_post_status`. Retrying `publish` with the same key returns the same upload (Idempotency-Key header + deterministic `request_id`).
- **check_post_status job:** `getStatus(requestId)` → `pending` (poll again in ≥ 10 s; the provider caches 2–5 s), `published` (`postId`, `url` when known) or `failed` (`error` is end-user safe). A `not_found` error means the upload never registered: republishing with the same idempotency key is safe.
- **Errors:** every provider error is an `AppError` with `details.reason` (table below). Worker rule: `isRetryableProviderError(err)` → retry after `retryAfterSeconds(err) ?? backoffMs(attempt)`; otherwise mark the post failed with `err.message` (safe to show). `validation` errors (our own checks) are never retryable.
- **Webhook route `/api/webhooks/upload-post`:** `parseUploadPostWebhook({ rawBody: await req.text(), headers: req.headers, secrets: webhookSecrets(config.UPLOAD_POST_WEBHOOK_SECRET) })`. Answer 401 on `unauthorized`, 400 on `bad_request`, 503 on `unavailable` (no secret configured), and **200 quickly** otherwise (the provider never retries and pauses a webhook after 5 failures). Events: `upload_completed` (match the post by `externalId` = our idempotency key, or `requestId`; apply `status` or just enqueue `check_post_status`), `account_status` (`profileRef` may be null on `reauth_required`; then match by platform + `accountName`, or resync all brands' accounts for that platform), `ignored`. Dedupe by `deliveryId`.
- **Analytics:** `getPostMetrics({ requestId, platform, profileRef })` at the 24h/48h/7d/30d checkpoints (falls back to `platformPostId`); `getAccountMetrics({ profileRef, platforms })` daily. Both return `{}` per platform when the provider has nothing. At the 24 h checkpoint also call `getStatus` again for TikTok posts: TikTok's real post id/URL can arrive up to 24 h late and no webhook fires for it.
- **import_past_posts:** page `listPastPosts({ profileRef, platform, cursor, limit })` until `nextCursor` is undefined. Captions and metadata only (never media URLs).

## Error reasons

| `details.reason` | `AppError.code` | When |
| --- | --- | --- |
| `provider_auth` | `unavailable` (503) | 401/403 from the provider, incl. `PROFILE_LIMIT_REACHED` / `PROFILE_BLOCKED`. It is our credential/plan problem, so it must not become a 401 (MCP clients would re-run OAuth). Alert on it. |
| `rate_limited` | `rate_limited` (429) | 429 without violations, or our local gate (X-RateLimit-Remaining hit 0). `details.retryAfterSec` from Retry-After / `retry_after` / X-RateLimit-Reset / 60 s. |
| `cap_reached` | `cap_reached` (429) | 429 with a `hard_cap` violation (rolling-24h account cap). `retryAfterSec` defaults to 3600 (scheduler re-checks +1 h). |
| `provider_rejected` | `bad_request` (400) | Any other 4xx, a 2xx with `success:false`, a synchronous per-platform failure, a 429 with non-cap violations (duplicate content). Message = cleaned provider reason. |
| `provider_unavailable` | `unavailable` (503) | 5xx (details never echoed), network errors, timeouts (30 s), unreadable or schema-invalid responses (`providerCode: invalid_response`). |
| `not_found` | `not_found` (404) | Unknown profile (listAccounts, connect link) or upload (getStatus). |
| `conflict` | `conflict` (409) | 409; `IDEMPOTENCY_KEY_IN_USE` carries `retryAfterSec: 5`. |

`details` holds only `provider`, `reason`, `status`, `providerCode` (identifier-shaped codes only) and `retryAfterSec`. Messages strip URLs (presigned signatures), secret-looking strings, the API key verbatim, and provider dashboard directions/brand names (white-label). The key is sent only in the `Authorization` header; the client lets no caller override it; logs carry method, path, status and duration only.

## Decisions (where ARCHITECTURE / research were silent)

1. **One platform per upload request.** Posts are per variant, so each `publish` sends one `platform[]`. Generic `title`/`description` are then unambiguous.
2. **Text/title mapping** (core: `text` = caption/commentary, `title` = platform title):

   | Platform | video | photos | text |
   | --- | --- | --- | --- |
   | tiktok | `title`=text | `title`=title, `tiktok_description`=text | n/a |
   | youtube | `title`=title (required), `description`=text | n/a | n/a |
   | instagram, threads, x, bluesky | `title`=text | `title`=text | `title`=text (not instagram) |
   | facebook | `title`=title, `description`=text | `title`=text | `title`=text |
   | linkedin | `title`=title, `description`=text | same | `title`=text |
   | pinterest | `title`=title, `description`=text | same | n/a |
3. **Options → fields:** tiktok `privacy_level`, `disable_comment`, `disable_duet`/`disable_stitch`/`cover_timestamp`/`is_aigc` (video only), `brand_content_toggle`, `brand_organic_toggle`, always `post_mode=DIRECT_POST` and `disable_inbox_fallback=true`; youtube `tags[]` (repeated), `categoryId`, `privacyStatus`, `selfDeclaredMadeForKids`, `containsSyntheticMedia`, `youtube_playlist_id`; instagram `media_type` (video REELS/STORIES; photos only STORIES), `share_to_feed` (not for stories), `thumb_offset`, `collaborators` (comma list, no `@`), `location_id`; facebook `facebook_page_id`, `facebook_media_type` (video; photos only STORIES); threads `threads_topic_tag`, `threads_reply_control`; x `x_long_text_as_post=true` for `single_post`, `reply_settings` unless `everyone`; linkedin `visibility`, `target_linkedin_page_id`; pinterest `pinterest_board_id` (required, enforced), `pinterest_link`, `pinterest_alt_text`; bluesky `bluesky_alt_text`, `bluesky_langs` (comma list). `firstComment` → `first_comment` everywhere except Pinterest.
4. **Always `async_upload=true`**, our own `request_id = upr_<platform>_<32 hex of sha256(platform, key)>` (deterministic, carries the platform for `getStatus`), `external_id = idempotencyKey`, header `Idempotency-Key: idempotencyKey`. If the provider returns a different `request_id`, that one is returned.
5. **Status mapping:** per-platform `status` wins (completed → published; failed/skipped → failed; queued/processing/retryable → pending). Without `status`: `success:false` → failed; `success:true` → published only with a post id, a URL or a `completed` request (a "Queued" result stays pending). `fallback_to_inbox` (TikTok inbox draft) → **failed** with a clear message (not live; should not happen since we disable it). `reached_active_user_cap` → failed. A top-level `failed` (e.g. "no activity for over 1 hour") → failed. `completed` with no result → failed. Non-URL `post_url` prose is dropped.
6. **Connect page:** always `show_calendar:false` (the hosted calendar can create/edit posts and bypass approval). `platforms` is sent only if every requested platform is in the documented filter list (tiktok, instagram, linkedin, youtube, facebook, x, threads); for pinterest/bluesky the page shows all platforms instead of hiding the requested one. `expiresAt` = now + `duration` (default 48 h). Optional white-label branding via `connectPage` (logo, title, description, button text, language). Redirect URLs must be https (http only for localhost).
7. **Accounts:** `social_accounts.<platform>.username` is the stable `externalId` (fallback: handle, then display name); `reauth_required` → `needs_reauth`; empty string/null → not connected; a non-empty string value counts as connected; `twitter` key → `x`; platforms we do not support are ignored.
8. **Analytics:** Facebook profile analytics require `page_id`; when `facebookPageId` is not given the adapter looks up the first Page (`GET /uploadposts/facebook/pages`) and gives Facebook `{}` if there is none (the other platforms still return). LinkedIn analytics cover company pages only (`linkedinPageId` → `page_urn`). Post metrics by platform post id are not available for Bluesky (returns `{}` without a call). Metric aliases: views/plays/video_views, likes/like_count, comments/replies, shares/reposts/retweets, saves/bookmarks, followers/followers_count/subscribers, reach, impressions; everything else dropped.
9. **Past posts:** page size default 25, capped per platform (TikTok 20, YouTube 50, others 100). LinkedIn has no cursor: a cursor for LinkedIn returns `{ posts: [] }` without calling. Timestamps such as `+0000` are normalised to ISO. Media URLs are never returned.
10. **Local rate-limit gate:** after a response with `X-RateLimit-Remaining: 0`, the client refuses requests (`rate_limited`) until `X-RateLimit-Reset` (ignored if more than 15 min away). Per process only; a shared limiter across workers would need the DB (not built).
11. **Profile prefix:** `profilePrefix` (default `brand_`) lets staging and production share one Upload-Post account without colliding.
12. **Webhooks:** signature is documented, so no URL token is needed: `sha256=hex(HMAC_SHA256(secret, "<X-Upload-Post-Timestamp>.<raw body>"))`, timestamp within ±300 s, constant-time compare, several secrets accepted (`UPLOAD_POST_WEBHOOK_SECRET="current,previous"` while rotating). Unsigned deliveries are always rejected. Bodies over 1 MB are refused. Dotted event names (`social_account.connected`, seen in the OpenAPI spec) are accepted too. `user_email` is dropped.
13. **Fake provider:** in-memory and deterministic. `ensureProfile` → `fake_brand_<brandId>`; unknown profiles act as empty profiles (survives Next dev reloads); `createConnectLink` auto-connects the requested platforms by default and redirects to `redirectUrl?connect_status=success&platform=…&fake=1`; `publish` validates exactly like the real adapter (but accepts http media URLs for local storage), is idempotent per key and returns `fake_<platform>_<24 hex>`; the next `getStatus` returns published with `https://fake-posting.invalid/<platform>/posts/<id>`. Fake request ids it never saw (another process) resolve as published. Scripting: `failNext(method, err?)`, `failNextPublish(err?)`, `failNextUpload(msg)`, `failUpload(id, msg)`, `delayStatus(n, id?)`, `connectAccount`, `setAccountStatus`, `setPostMetrics`, `setAccountMetrics`, `setPastPosts`, `calls`, `uploads`, `reset()`. Options: `statusDelay`, `autoConnect`, `strictAccounts` (reject unconnected platforms), `pastPostsPerPlatform`, `baseUrl`.

## Verified against the live docs (2026-10-31)

- `docs.upload-post.com/api/upload-status`: top-level statuses (pending, queued, processing, in_progress, completed, failed, not_found/404); per-platform statuses (queued, processing, completed, failed, retryable, skipped); result fields (platform, success, message, status, skipped, skip_reason, fallback_to_inbox, post_url, platform_post_id, warnings, post_id_resolved_late).
- `/api/user-profiles`: create (201; 400/401/403 `PROFILE_LIMIT_REACHED`/409), delete (`DELETE /api/uploadposts/users {username}`), disconnect (`DELETE /api/uploadposts/users/social {profile_username, social_platform}`), generate-jwt (`platforms` values tiktok, instagram, linkedin, youtube, facebook, x, threads, google_business; `show_calendar` defaults to true; `access_url`, `duration: "48h"`; 403 `PROFILE_BLOCKED`, 404 `PROFILE_NOT_FOUND`).
- `/api/get-analytics`: `page_id` is required for Facebook; `days`, `page_urn`; post analytics by `request_id` (`?platform=`) and by `platform_post_id` + `platform` + `user` (platforms: youtube, tiktok, instagram, facebook, linkedin, x, threads, pinterest, reddit).
- `/api/webhooks`: header names, signature formula (hex, `sha256=` prefix), ~5 minute window, no retries, underscore event names.
- From the research agent's same-day snapshot of the docs and `openapi.json` (re-read for this work): multipart field names per endpoint and platform, `Idempotency-Key` / `request_id` / `external_id`, error body shapes (`message` / `error` / `error_code`), 429 `violations[]`, `X-RateLimit-*` headers, media listing pagination (`pagination.next_cursor`, `has_more`, per-platform limits), `social_accounts` shape, `photos[]` accepting HTTPS URLs, `tags[]` repeated fields (curl example).

## Not verified (assumptions; check on first real use)

- Whether our `request_id` format (`upr_<platform>_<hex>`) is accepted as-is (the docs set no format; if rejected, publish fails with `provider_rejected` and the fix is in `requestIdFor`).
- Facebook video: whether `title` + `description` render as intended for Reels (we send `description`=text and `title` only when the variant has one).
- What the hosted connect page appends to `redirect_url` on return (web should simply resync accounts).
- Exact shape of per-platform analytics errors (treated as "no numbers").
- Whether every status result carries `status` (handled either way) and X/Threads metric key names (aliases cover the likely spellings).
- Whether pinterest/bluesky can be passed to the connect-page `platforms` filter (we omit the filter for them).
- Whether `bluesky_alt_text` applies to all images when given once (we send one string).

## Requests for other owners

1. **Root / scaffold (lockfile):** I added `"zod": "^4.6.7"` to `packages/posting/package.json` (the task requires zod validation; the same version is already locked for core and mcp) and linked it locally in `packages/posting/node_modules`. Please run `pnpm install` once so `pnpm-lock.yaml` records zod under `packages/posting` (a frozen-lockfile install fails until then). No new package is downloaded.
2. **Core (optional):** `ERROR_CODES` has no `provider_*` codes, so provider errors use existing codes with `details.reason` (table above). If core adds `provider_auth` / `provider_rejected` / `provider_unavailable`, only `ERROR_CODE_BY_REASON` in `src/errors.ts` needs to change.
3. **Core ports (optional):** `UploadPostProvider.getAccountMetrics` also accepts `facebookPageId` and `linkedinPageId`; add them as optional fields to the port if services want to pass the brand's chosen destination.
4. **Core config (optional):** an `UPLOAD_POST_PROFILE_PREFIX` env var (pass as `deps.profilePrefix`) if staging shares the production Upload-Post account; and `UPLOAD_POST_WEBHOOK_SECRET` may hold `current,previous` (use `webhookSecrets()`).
5. **Ops / web:** configure the webhook once (dashboard → Notifications, or `POST /api/uploadposts/users/notifications`) with URL `${APP_URL}/api/webhooks/upload-post` and events `upload_completed`, `social_account_connected`, `social_account_disconnected`, `social_account_reauth_required`; put the signing secret in `UPLOAD_POST_WEBHOOK_SECRET`. Do not enable `comment_received` / `dm_received`.
6. **Worker:** presigned media URLs passed to `publish` should live ≥ 1 h (async download); poll status no faster than every 10 s; re-check TikTok posts at 24 h for the late post id.
