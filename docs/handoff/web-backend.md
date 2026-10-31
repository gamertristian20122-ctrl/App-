# Web backend handoff: route handlers, OAuth AS, Stripe, uploads, webhooks (`apps/web`)

Owner: web-backend agent. Paths: `apps/web/app/api/**`, `app/.well-known/**`, `app/oauth/**`,
`app/approve/**`, `app/auth/**`, `apps/web/lib/server/**`, `apps/web/middleware.ts`,
`apps/web/vercel.json`, `apps/web/test/api/**`. Requests for other owners are at the end.

Every route is a thin shell: parse the transport, call one `@app/services` function, map
`AppError` with `toErrorBody` (OAuth endpoints: `oauthErrorResponse`). No business rule is
re-implemented here.

## Routes

| Route | What |
| --- | --- |
| `GET/POST/DELETE /api/mcp` (+ `OPTIONS`) | Bearer check with `services.oauth.verifyAccessToken` (audience = `MCP_RESOURCE_URL`, scope `social`), then `handleMcpRequest(req, { services, userId, baseUrl: APP_URL, log, allowedOrigins })` with the untouched Request. No/garbled token → 401 `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp", scope="social"`; bad/expired token → same plus `error="invalid_token"`. A verification crash (DB down) → 503, never 401 (clients would re-auth). Per-user rate limit 240/min. CORS reflected for the app origin (and MCP Inspector's `localhost:6274` outside production), `WWW-Authenticate` exposed. |
| `GET /.well-known/oauth-protected-resource` and `…/api/mcp` | RFC 9728 (`services.oauth.protectedResourceMetadata()`), CORS `*`, cached 5 min |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 (`authorizationServerMetadata()`): DCR endpoint, S256 only, auth method `none`, scopes `["social"]`, `iss` supported. `/.well-known/openid-configuration` is not served (we are not an OIDC provider; MCP clients try RFC 8414 first). |
| `POST /oauth/register` | RFC 7591, JSON only, ≤16 KB, 30/min per IP. Redirect URIs: https or http on `localhost`/`127.0.0.1`/`[::1]` (any port); then `registerClient`. 201. |
| `GET /oauth/authorize` (page) | `loadConsent`: validates first (unknown client / bad redirect URI → error page, never redirected; protocol errors → redirect to the client with `error`, `state`, `iss`), then requires sign-in (`/login?next=/oauth/authorize?…`). Shows app name, scope description, redirect host, a warning for loopback apps. Allow/Deny → server action `decideAuthorization` → `services.oauth.authorize` → redirect with `code`+`state`+`iss` or `error=access_denied`. |
| `POST /oauth/token` | form-urlencoded (JSON tolerated), `client_id` also from HTTP Basic, 300/min per IP, `Cache-Control: no-store`. `authorization_code` + PKCE, `refresh_token` rotation, reuse → family revoked, RFC 6749 error JSON. |
| `POST /oauth/revoke` | RFC 7009, 200 for any well-formed request |
| `GET /auth/callback` | Supabase magic link: `exchangeCodeForSession(code)` (PKCE) or `verifyOtp(token_hash, type)`, session cookies set, `users.ensureUser` (trial starts once), 303 to `next` (same-site paths only). Failures → `/login?error=link_invalid|link_expired|not_configured|unavailable&next=…`. |
| `POST /api/auth/magic-link` | Extra (for the login page): `{ email, next? }` → `signInWithOtp` with `emailRedirectTo = APP_URL/auth/callback?next=…`; sets the PKCE verifier cookie. Form → 303 `/login?sent=1&next=…`; JSON → `{ sent: true }`. 5/min per IP. |
| `POST /api/auth/dev-login` | Only with `DEV_AUTH=1` (else 404). `{ email, next? }` → auth user (local DB) + `users.ensureUser` + signed `dev_session` cookie. Form → 303 to `next`; JSON → `{ user, next }`. |
| `POST /api/auth/logout` | Supabase `signOut({ scope: 'local' })` (best effort) and clears `dev_session` + every `sb-*` cookie. Form → 303 `/`; JSON → `{ signedOut: true }`. |
| `POST /api/stripe/checkout` | Signed-in. `{ plan, extraBrands?, extraClipHours? }` (JSON numbers or form strings) → `billing.checkoutParams` → prices resolved by lookup key when not configured → Checkout Session (subscription mode, `client_reference_id` = user id, customer reused, `subscription_data.metadata.userId`). Form → 303 to Checkout; JSON → `{ id, url, monthlyPriceCents }`. Existing subscription → 409 `details.portal` (form: 303 `/app/billing?checkout=has_subscription`). |
| `POST /api/stripe/portal` | Signed-in. `billing.portalParams` → portal session. Form → 303; JSON → `{ url }`. No customer yet → 400. |
| `POST /api/stripe/webhook` | Raw body ≤512 KB, `Stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET` → `billing.applyStripeEvent(event, { fetchSubscription })` (fetcher only when `STRIPE_SECRET_KEY` is set). 200 processed/ignored/duplicate; **409 unmatched** (Stripe retries); 400 bad signature; 503 no secret. |
| `POST /api/uploads` | Signed-in, JSON `{ purpose?: 'post' \| 'clip_source', brandId?, filename, contentType, bytes, rightsAttested? }` → `media.createUpload(u, rest, { purpose, via: 'web' })` → 201 `{ media, upload }` (presigned PUT, or multipart parts above 5 GB). |
| `POST /api/uploads/[id]/complete` | Signed-in, JSON `{}` or `{ uploadId, parts: [{ partNumber, etag }] }` → `media.completeUpload` → `{ media, ingestQueued }`. |
| `GET/HEAD/PUT /api/dev-storage/[...key]` | `createLocalStorageHandler(runtime.storage)`. 404 when storage is R2, `STORAGE_DRIVER=r2` or `APP_ENV=production`. |
| `POST /api/webhooks/upload-post` | `parseUploadPostWebhook` (raw body, `webhookSecrets(UPLOAD_POST_WEBHOOK_SECRET)`, `now` = services clock). 401 bad/missing/stale signature, 400 malformed, 503 no secret, otherwise **always 200**. `upload_completed` published/failed → `posts.findByProviderRequest` + `posts.recordPublishStatus` (pending ignored: the worker keeps polling). `account_status` with a profile → `maintenance.applyProviderAccountStatus`. Deliveries de-duplicated per instance by `X-Upload-Post-Delivery`. |
| `GET/POST /api/cron/analytics` | `Authorization: Bearer CRON_SECRET` (constant-time) → `analytics.enqueueDailyAccountPulls(now)` → `{ enqueued }` |
| `GET/POST /api/cron/cleanup` | Same auth → `jobs.enqueue({ type: 'cleanup', payload: { task: 'all' }, idempotencyKey: 'cleanup:web-cron:<UTC hour>' })` |
| `/approve/[nonce]` (page) | Signed-in (`/login?next=/approve/<nonce>`). `approvals.verifyNonce(u, nonce, undefined, { via: 'web' })` → `drafts.preview`; per-platform cards (account, title, text, media, length vs limit, errors, problems). Approve (disabled until ready) / Reject (optional reason) → server action `decideFromWeb` → `approvals.decide(u, { draftId: <from the nonce>, nonce, decision, reason }, { via: 'web' })` → `?result=approved\|rejected\|failed`. Accepts card and link nonces; another user's nonce is "not valid"; a refused approval keeps the nonce. |

`middleware.ts`: refreshes an expiring Supabase session on navigations (cookies written to the
downstream request and the response) and sets `X-Frame-Options: DENY`,
`frame-ancestors 'none'` and `Referrer-Policy: no-referrer` on `/oauth/authorize` and
`/approve/*`. It skips `/api/mcp`, `/oauth/token|register|revoke`, `/.well-known/*`, webhooks,
crons, dev storage, `/auth/callback` and assets (matcher and code). Logic in
`lib/server/edge-session.ts` (Edge-safe: no `@app/*` imports).

`vercel.json`: crons `/api/cron/cleanup` at 04:23 UTC and `/api/cron/analytics` at 05:41 UTC,
daily (Vercel Hobby allows only daily crons; the worker runs both more often on its own).

## For the UI owner (pages under `app/(…)`, `/login`, `/app/*`)

- `/login` must honor `?next=` (pass it to `/api/auth/dev-login` or `/api/auth/magic-link` as a
  form field) and show `?error=link_invalid|link_expired|not_configured|unavailable` and `?sent=1`.
- Sign out with a `<form method="post" action="/api/auth/logout">`.
- Billing: `<form method="post" action="/api/stripe/checkout">` with `plan`, `extraBrands`,
  `extraClipHours`; `/app/billing?checkout=success|canceled|has_subscription`; portal form posts
  to `/api/stripe/portal`.
- Uploads: `POST /api/uploads` (JSON) → PUT the file to `upload.url` with `upload.headers` (exact
  size) → `POST /api/uploads/<media.id>/complete`. Multipart: PUT each part, keep each `ETag`,
  then complete with `{ uploadId, parts }`.
- Server-side code: `getRuntime()` / `authDeps()` from `lib/server/deps.ts` (same runtime as
  `lib/services.ts`; overridable in tests).

## Tests (`pnpm -F @app/web test`)

9 files, 92 tests (8 files / 83 tests in `test/api`), PGlite-backed services built with
`createServicesFromEnv(testEnv, { db: createTestDb(), clock, logger })` (fake provider, memory
storage) and installed with `setServerOverridesForTests` (`lib/server/deps.ts`; `lib/services.ts`
untouched). `@app/mcp` is `vi.mock`ed; Stripe's API is a fake (`StripeApi`), its signatures are
real (offline); Supabase Auth HTTP is a mock `fetch`. Covered: 401 + `WWW-Authenticate` (with
and without `error`), CORS, 503 on verification failure, per-user rate limit; discovery docs;
DCR (https/loopback accepted; http, `javascript:`, app schemes, fragments refused; metadata
validation; 415/413; per-IP rate limit); consent (login redirect, client/scope/host, errors
shown vs redirected, deny, approve with `state`+`iss`); full code + PKCE exchange, single-use
code, refresh rotation, **reuse → family revoked → access token rejected on /api/mcp**, wrong
verifier/client/redirect, unsupported grant, Basic client id; revocation; dev login, logout,
magic link + callback (PKCE cookie round trip, user + trial created), callback failures;
Stripe checkout (auth, CSRF, validation, lookup-key prices, customer reuse, form redirect,
existing subscription, unconfigured), portal, webhook (missing/bad/tampered signature,
processed with fetched subscription, **duplicate replay**, unmatched 409, ignored, no secret,
too large); uploads (auth, CSRF, type/size/purpose/rights validation, presign → dev-storage PUT
→ complete, ingest queued, size mismatch, other user); dev-storage signatures and 404 rules;
Upload-Post webhook (unsigned/wrong/stale, no secret, account status, delivery dedupe,
publishing → published, unknown request, ignored, malformed); crons (auth, 503, hourly/daily
idempotency); web approval (link nonce, once, reject with reason, other user, garbage, stale
after edit, refused approval keeps the nonce); middleware (skips, matcher, headers, session
refresh with rotated cookie); helpers. `pnpm -F @app/web typecheck`, `next build` and
`pnpm lint` pass.

## Decisions

1. **Redirect URIs at registration: https or loopback http only** (task), stricter than
   `services.oauth` (which also accepts native-app schemes). **Cursor registers
   `cursor://…` redirect URIs and is refused** until `ALLOW_APP_SCHEME_REDIRECTS` in
   `lib/server/oauth.ts` is set to `true` (one line; the service still refuses `javascript:` etc.).
   Product owner: decide.
2. The 401 challenge points at the **path-suffixed** PRM URL (derived from `MCP_RESOURCE_URL`), so
   the web layer builds its own header instead of `services.oauth.wwwAuthenticate()` (root form).
   Both documents are served and identical.
3. Rate limits are **in-memory per instance** (`lib/server/rate-limit.ts`, generous because Claude
   and ChatGPT share egress IPs): register 30/min/IP, token and revoke 300/min/IP, MCP 240/min/user,
   magic link 5/min/IP, dev login 30/min/IP.
4. Cookie-authenticated POST routes check `Origin` / `Sec-Fetch-Site` (CSRF); server actions rely on
   Next's own origin check.
5. Dev storage is served for both local drivers (`fs` and `memory`), never for R2 or production.
6. Stripe `unmatched` → **409** (any non-2xx makes Stripe retry). Verified-but-invalid payloads → 400.
7. Upload-Post webhook: `pending` results and account events without a profile are acknowledged
   and not applied (polling / the next `accounts.sync` cover them); processing errors still answer
   200 (the provider pauses webhooks after failures).
8. `middleware.ts` is used although Next 16 renamed the convention to `proxy.ts` (build prints a
   deprecation warning; behaviour is unchanged and it keeps the Edge runtime).
9. Added `POST /api/auth/magic-link` so the login page does not need its own Supabase client.

## Requests

1. **Root / scaffold:** add `zod` (`^4.6.7`, already in the lockfile) to `apps/web/package.json`
   dependencies. It is not a direct dependency today, so `lib/server/validate.ts` has small typed
   guards instead of zod for the few fields the web layer reads itself (everything else goes raw to
   services, which use the core zod schemas). Swap them for zod once it is added.
2. **Core config (optional):** `MCP_ALLOWED_ORIGINS` (comma list) for browser-based MCP clients in
   production; today only the app origin (and MCP Inspector outside production) is allowed.
3. **Services (optional):** a lookup for Upload-Post `account_status` events without
   `profile_username` (platform + account name → account), or a `accounts.resyncPlatform` helper.
   `oauth.wwwAuthenticate()` could take the path-suffixed metadata URL (see decision 2).
4. **DB:** `next build` warns that `findMigrationsDir()` (`packages/db/src/migrate.ts:66`) makes
   Turbopack trace the whole project into the server bundle (imported via services wiring). Consider
   a statically scoped path or `/*turbopackIgnore: true*/` so Vercel functions stay small.
5. **Whoever owns `apps/web/proxy.ts` / Next config:** rename `middleware.ts` → `proxy.ts`
   (`export { middleware as proxy }`) when convenient; note `proxy` runs on Node, not Edge.
6. **Ops:** Supabase Auth redirect allow-list: `${APP_URL}/auth/callback`. Stripe webhook events:
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
   `invoice.payment_failed`. Upload-Post webhook URL: `${APP_URL}/api/webhooks/upload-post`.
   Set `CRON_SECRET` in Vercel.

## Gaps

- Not exercised against live Supabase, Stripe, Upload-Post or a real MCP client (Claude, ChatGPT,
  MCP Inspector); a deployed URL is needed.
- The consent and approval pages are rendered only by `next build`; their logic is tested through
  `loadConsent` / `decideConsent` / `loadApproval` / `decideApproval`.
- No shared (cross-instance) rate limiter or webhook delivery dedupe.
