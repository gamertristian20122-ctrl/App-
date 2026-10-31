# End-to-end run (`pnpm e2e`)

`scripts/e2e/run.ts` brings the whole product up on one machine and drives it the way a person and
an AI assistant would: a real Postgres, the built web app, the worker, a real MCP client with a
real OAuth flow, Chromium for the pages, and ffmpeg for the media. It stops everything it started,
on success, on failure and on Ctrl-C.

## Run it

```sh
pnpm e2e                         # full run, about 2 minutes (1 of them waits for the scheduled post)
pnpm e2e --skip-build            # reuse apps/web/.next instead of running `next build`
pnpm e2e --whisper               # transcribe through a local Whisper stub instead of the fake transcriber
pnpm e2e --schedule-delay=5      # schedule the post 5 s ahead instead of 60 s
pnpm e2e --no-screenshots        # skip docs/screenshots
pnpm e2e --keep                  # leave everything running after a green run (Ctrl-C stops it)
```

Needs: Node 22, `pnpm install` done, Postgres 15–17 binaries (`/usr/lib/postgresql/16/bin`, or set
`E2E_PG_BIN`), `ffmpeg`/`ffprobe` on `PATH`, and Chromium for playwright-core
(`PLAYWRIGHT_BROWSERS_PATH`, default `/opt/pw-browsers`). No network access is needed.

State and logs: Postgres in `/tmp/e2e-pg` (`E2E_PG_DIR`, wiped each run), everything else in
`/tmp/e2e-run` (`E2E_RUN_DIR`): `logs/web.log`, `logs/worker.log`, `logs/next-build.log`,
`logs/migrate.log`, the fs storage and the generated test video. On a failure the script prints the
failed check, the stack and the tail of the web and worker logs, and exits 1.

The script uses packages the workspace already has (no new dependencies):
`@modelcontextprotocol/sdk` from apps/web (mapped in `scripts/e2e/tsconfig.json`) and
`playwright-core` from apps/worker. `pnpm typecheck` also type-checks `scripts/e2e`.

## What happens

1. **Infrastructure.** `initdb` + `pg_ctl` (as the `postgres` user when run as root, trust auth on
   127.0.0.1, a free port). `pnpm -F @app/db migrate --local-shim` installs the Supabase stand-ins
   (roles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()`) and applies
   `supabase/migrations`; a second run must apply nothing; every public table must have RLS on.
   Secrets come from `scripts/generate-secrets.mjs`. `next build` + `next start` with `DEV_AUTH=1`,
   `POSTING_PROVIDER=fake`, `STORAGE_DRIVER=fs`, `TRANSCRIPTION_PROVIDER=fake` (or `whisper` + the
   stub), `APP_URL` = the local URL. The worker (`apps/worker/src/main.ts` via tsx,
   `WORKER_TYPES=all`) shares the database and storage directory; its health endpoint must list
   every handler.
2. **Browser.** Landing and login pages, dev sign-in (httpOnly session cookie, trial started),
   brand created through the Brands form.
3. **OAuth + MCP** with `@modelcontextprotocol/sdk` over Streamable HTTP: the first connect gets a
   401, the SDK discovers the protected-resource and authorization-server metadata, registers a
   client dynamically and starts PKCE (S256, `resource`, `scope=social`); Chromium opens the
   consent page (signed in) and clicks Allow; the code lands on a loopback callback server; the SDK
   exchanges it. Refresh: the access token is replaced with garbage, the next request gets a 401
   and the SDK refreshes (the refresh token rotates).
4. **Tools.** `tools/list`: all 17 tools (the 14 v1 tools plus `upload_media`,
   `render_code_video` and `publish_video`) and the 2 app-only ones, each with a title and a
   `readOnlyHint` or `destructiveHint`; `approve_draft` and `publish_video` point at
   `ui://approval-card/v1` (`publish_video` is destructive); the app-only tools have
   `visibility: ["app"]`; prompts and the card resource are listed.
5. **Accounts.** `connect_account` for X, LinkedIn, Instagram, TikTok (fake provider); the X link
   is opened in the browser and the Accounts page syncs it; `list_accounts` shows all four active.
6. **Draft → approval → publish.** An X variant with a link is refused with "X: Links are not
   supported in X posts … Remove the link, or put it in your profile." A text draft (X + LinkedIn)
   cannot be scheduled before approval; `approve_draft` returns the card nonce only in `_meta`
   (never in `content`/`structuredContent`); `resources/read` returns the card HTML
   (`text/html;profile=mcp-app`); a guessed nonce is refused, the card nonce approves once via
   `approval_decide`; `schedule_post` 60 s ahead; the worker publishes through the fake provider
   and `post_status` shows both posts published with URLs, not before their time.
7. **Auto-post** (docs/plans/02-auto-post.md). The person turns on Auto-post on the Brands page in
   Chromium (the warning is shown; switch on, TikTok + Instagram, daily limit 3, TikTok privacy
   "Everyone", Save): the brand row changes and the audit entry's actor is `web`; `list_accounts`
   shows the switch read-only. Then the AI side: ffmpeg makes a 6 s video, `upload_media` returns a
   presigned PUT and a `curl` command, which the script runs with `sh -c` (no proxy variables), and
   `publish_video` (TikTok + Instagram, `when: "now"`) answers that the video is still processing.
   The worker ingests it and the rule approves the draft (`approved_via = 'auto_post'`) and
   schedules both posts for the next minute; a later check (after the text post is published)
   waits until `post_status` shows both published by the fake provider with URLs and
   `approvedVia: "auto_post"`, the draft's outcome is `posted`, and the calendar shows the
   "Auto-posted" badge.
8. **Clips.** ffmpeg makes a 20 s test video (testsrc + sine). `/api/uploads` without the rights
   checkbox is refused; with it: presign → PUT → complete → ingest (probe, promoted out of
   `uploads/`) → transcription (`get_transcript`, nothing past the end of the video, `pick_clips`
   prompt) → `make_clips` with two ranges (ms and `"00:09.000"`) → `clip_render` → each clip is
   1080x1920 with an audio stream (ffprobe on the file downloaded through the card's preview URL)
   and became a **draft**, not a post. The usage ledger has exactly 20 settled clip seconds, and
   the overview shows "1 min of 1 h".
9. **Carousel.** `render_carousel` → 3 slides, 1080x1350 `image/jpeg` (JPEG magic bytes checked) →
   a draft (no posts).
10. **Voice and analytics.** `save_voice_profile`, `write_post` (loads the profile),
   `import_past_posts` (rows appear), `get_analytics`, `weekly_review`.
11. **Drive links.** A YouTube link on the Media page is refused in the browser (button disabled,
    message shown) and by the server (the form forced through; no media row created).
12. **Approval card in an MCP Apps host.** `scripts/e2e/card-harness.html` is a host page: it
    loads the card from `resources/read` in a sandboxed iframe, answers `ui/initialize`, sends
    `tool-input` and the real `approve_draft` result, resizes on `size-changed`, records
    `ui/update-model-context`, and forwards the card's `tools/call` to the real server. The card
    asks who can see the TikTok post (`approval_edit_variant`), then Approve calls
    `approval_decide`; the draft is approved via `mcp`.
13. **One-click web approval.** `/approve/<card nonce>` for a clip draft: Approve is disabled until
    the TikTok privacy is saved (which moves to a fresh nonce), then Approve → approved via `web`.
14. **Screenshots** (1440x900, plus a 390x844 landing page) with a health check on each page:
    status < 400, our stylesheet loaded, no error screen, no browser errors.
15. **Security.** `/api/mcp` without a token → 401 with
    `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"`
    (followed: `resource` and `authorization_servers` match); AS metadata has S256 and a
    registration endpoint; the consent and approval pages carry `X-Frame-Options: DENY`,
    `frame-ancestors 'none'` and `no-referrer` while `/api/mcp` is untouched; a made-up token →
    `invalid_token`; reusing a rotated refresh token → `invalid_grant` and the whole token family
    is revoked (the current access token stops working).
16. The worker reports no dead jobs and the web log has no errors.

## Screenshots (`docs/screenshots`, about 1.9 MB)

`landing`, `landing-mobile`, `login`, `oauth-consent`, `app-overview`, `app-approvals` (a pending
clip draft), `app-calendar` (full page: today's published posts, tomorrow's scheduled carousel),
`app-brands`, `app-accounts`, `app-media`, `app-clips`, `app-voice`, `app-analytics`,
`app-billing`, `app-connect`, `approve-nonce`, `approval-card` (in the host harness) and
`approval-card-approved`. Each was looked at; the fixes below came from that review and from the
run itself.

## Bugs found and fixed

1. **Drafts made from clips and renders could never be approved when the brand has TikTok.**
   TikTok requires the person to choose who can see a post (no default), and validation blocks
   approval until `privacyLevel` is set, but nothing a person can use (approval card, approvals
   queue, `/approve/[nonce]`) could set it, and the worker's drafts never have it. The quick edit
   now takes `privacyLevel` (TikTok only): `EditVariantInputSchema` and `TIKTOK_PRIVACY_LABELS` in
   `@app/core/validation`, `drafts.editVariant` / `approvals.editVariant` in services,
   `approval_edit_variant` in MCP, a "Who can see this TikTok post" select in the card
   (`packages/mcp/src/card/html.ts`), in the queue (`components/app/approvals.tsx`,
   `lib/ui/actions/drafts.ts`) and on `/approve/[nonce]` (`setTikTokPrivacy` in
   `lib/server/approve.ts`, `setPrivacyFromWeb`, which continues on the page of the next nonce).
   Tests: core `validation.test.ts`, services `drafts-approvals.test.ts`, mcp `card.test.ts` and
   `approval.test.ts`, web `ui/approvals.test.tsx` and `api/approve.test.ts`.
2. **Transcripts could run past the end of the video.** The fake transcriber ignores the file (a
   20 s upload got a 110 s transcript), and real engines pad the last segment, so `get_transcript`
   offered moments `make_clips` then refused. `transcripts.save` now clamps words and segments to
   the source duration (`clampTranscript`). Tests: services `clips-transcripts.test.ts`, worker
   `handlers.test.ts`.
3. **The approval card could grow but never shrink** (it reported
   `documentElement.scrollHeight`, which is never smaller than the iframe), so it stayed tall after
   Approve; and its status pill still said "Waiting for approval" after approving. It now reports
   its own height and the pill follows the decision. Test: mcp `card.test.ts`.
4. **Carousel and video drafts ran the heading into the body** ("…videos once One episode…"): the
   worker collapsed the line break. It keeps it now (`apps/worker/src/media/renders.ts`). Test:
   worker `renders.test.ts`.
5. **Validation messages used platform ids** ("x: Links are not supported…", "Only one x
   variant"); they use the labels now ("X: …", "YouTube: …"). Test: core `validation.test.ts`.
6. **A full set of brand slots looked like an error** (1 of 1 brands drew a red bar on the
   overview, brands and billing pages). Brand meters are red only when over the limit
   (`meterTone`, `Meter kind="slots"`). Test: web `ui/lib.test.ts`.
7. **`/approve/[nonce]` printed the raw length unit** ("32 / 2200 utf16"); it shows "characters"
   like the queue.
8. **Analytics said "1 drafts waiting"**; now "1 draft waiting for approval".
9. **The Connect page's "Copy JSON" button wrapped onto two lines.**
10. **`next build` warned that `middleware.ts` is deprecated** (Next.js 16). It is `proxy.ts` now
    (same matcher and logic in `lib/server/edge-session.ts`); the build has no warnings, and the
    e2e run checks the security headers it adds.

Not a product bug, but worth knowing: `tsx --tsconfig …` exports `TSX_TSCONFIG_PATH` (relative) to
child processes, which breaks other tsx processes started from a different directory; the script
strips `TSX_*` from the environment it passes on.

## Not covered here

Live Supabase Auth, Stripe, Upload-Post, R2, Whisper/AssemblyAI and real Claude/ChatGPT/Cursor
clients (all replaced by fakes or stubs); `render_video` and `render_code_video` (covered by the
worker's ffmpeg / Chromium tests, including a page whose `fetch` is blocked); `upload_media` with a
`sourceUrl` (the download is covered with a mocked HTTP client: the run has no network);
ChatGPT's `window.openai` card path (covered in `node:vm` by `card.test.ts`); the Docker image.
