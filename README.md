# Clipcast (working name)

A cheaper, better Blotato: a social media tool that any AI assistant (Claude, ChatGPT, Cursor and
others) can drive through MCP.

The user's AI does the thinking. This server does the work. We never pay for LLM calls: the MCP
server exposes **tools** (actions) and **prompts** (our playbook), so every AI produces consistent
results, and nothing is published until a person approves it.

What we do that Blotato doesn't:

- **Clip long videos into vertical shorts** (9:16, burned-in captions) from the user's own uploads
  or cloud-drive links. YouTube links are refused on purpose.
- **Write in the user's own voice** (a saved voice profile plus their best past posts).
- **Run a weekly review** that learns from analytics and proposes three experiments.

Posting and analytics for 9 platforms (TikTok, YouTube, Instagram, Facebook, Threads, X, LinkedIn,
Pinterest, Bluesky) go through Upload-Post.

The product name lives in one place: `apps/web/lib/ui/brand.ts` (`PRODUCT_NAME`).

## Plans

| Plan | Price | Brands | Clipping hours / month | Storage |
| --- | --- | --- | --- | --- |
| Starter | $8 / mo | 1 | 4 | 50 GB |
| Plus | $15 / mo | 2 | 10 | 100 GB |
| Pro | $25 / mo | 4 | 20 | 200 GB |

Add-ons: $3 / month per extra brand, $1 / month per extra clipping hour. New users get a 7-day
Starter trial with 1 clipping hour (no card). Limits are enforced in code
(`packages/core/src/plans.ts` is the single source of truth).

## What's built

Everything in the v1 plan (`CLAUDE.md`, build order steps 1–8) is written and tested:

- **Database:** 22 tables in Supabase Postgres (`supabase/migrations`), row-level security on every
  table, approval rules enforced by the database itself.
- **MCP server** at `/api/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration):
  17 tools (`connect_account`, `list_accounts`, `create_draft`, `list_drafts`, `approve_draft`,
  `schedule_post`, `post_status`, `get_transcript`, `make_clips`, `import_past_posts`,
  `save_voice_profile`, `render_carousel`, `render_video`, `get_analytics`, `upload_media`,
  `render_code_video`, `publish_video`), 3 prompts (`write_post`, `pick_clips`, `weekly_review`)
  and the approval card (an MCP App with Approve / Edit / Reject that also works in ChatGPT). The AI
  can never approve on its own.
- **Auto-post** ([docs/plans/02-auto-post.md](docs/plans/02-auto-post.md)): an AI that finishes a
  video sends it (`upload_media` + its `curl` command, a link, or an HTML animation for
  `render_code_video`) and calls `publish_video`. If the person turned on the brand's Auto-post
  switch on the Brands page, the brand's rule approves and schedules it (platform list, daily
  limit, platform rules and caps still apply); otherwise it waits for approval as always. Only the
  person can turn it on, in the web app.
- **Web app** (Next.js): landing page with pricing, magic-link sign-in, dashboard (overview,
  approvals, calendar, brands, accounts, media, clips, voice, analytics, billing, connect your AI),
  OAuth consent page, one-click web approval, Stripe Checkout and customer portal, webhooks,
  daily crons, and the legal pages (`/privacy`, `/terms` with subscriptions, cancellation and
  refunds, `/contact`) linked from every footer.
- **Launch setup** at `/setup` (only for `OWNER_EMAIL`; everyone else gets a 404): a phone-friendly
  checklist of every service (database and migrations, Supabase sign-in, R2 bucket and CORS,
  Upload-Post key, Stripe key, prices, webhook and portal, transcription, worker heartbeats, legal
  pages, the MCP URL) with OK / Needs attention / Not set and where to tap to fix it, plus one-tap
  fixes: **Fix storage CORS**, **Create missing products and prices**, **Create webhook endpoint**
  (the signing secret is stored encrypted) and **Set up billing portal**. Secret values are never
  shown.
- **Worker** (Railway): publishing, status checks, analytics, imports, clean-up, and the media
  jobs (ingest, URL imports, transcription, clip rendering with ffmpeg, carousel, template-video
  and HTML code-video rendering with Chromium).
- **Tests:** 1,457 unit and integration tests, a real-Postgres suite, and an end-to-end run
  (`pnpm e2e`) that drives the whole product with a real MCP client and a real browser.

**Not done yet:** nothing has run against the live services (Supabase, Stripe, Upload-Post,
Cloudflare R2, Whisper/AssemblyAI) or a real Claude / ChatGPT / Cursor account, and the worker's
Docker image has been built and started locally but not yet on Railway. Those need your accounts
and keys: follow [docs/LAUNCH-ON-PHONE.md](docs/LAUNCH-ON-PHONE.md) (phone only, tap by tap) or
[docs/DEPLOY.md](docs/DEPLOY.md) (the full reference), then open `/setup` and
[docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md).

## Repo map

```
apps/
  web/                 Next.js app for Vercel: pages, /api/mcp, OAuth server, Stripe, uploads, webhooks, crons
  worker/              Railway worker: job runner + handlers; Dockerfile and railway.toml live here
packages/
  core/                plans and limits, platform rules, input validation, config, crypto, logger (no I/O)
  db/                  database access (Postgres and in-process PGlite), migrator, repositories
  services/            every business rule (drafts, approvals, scheduling, metering, billing, OAuth, ...)
  mcp/                 MCP tools, prompts and the approval card
  posting/             PostingProvider: Upload-Post adapter (the only code that calls Upload-Post) + fake
  storage/             file storage: Cloudflare R2 + local folder / in-memory fakes
  transcription/       Whisper (self-hosted) and AssemblyAI adapters, fallback chain, fake
supabase/migrations/   SQL migrations (the schema's source of truth)
scripts/               boundary lint, secret generator, real-Postgres test runner, end-to-end run (e2e/)
docs/                  architecture, deploy guide, launch checklist, handoff notes, research, screenshots
.github/workflows/     CI (typecheck, lint, tests, real-Postgres tests, web build)
```

Every external system (posting, storage, transcription, clock) sits behind an interface with a
fake, so the whole product runs on a laptop with no accounts at all.

## Local development

### What you need

- **Node.js 22** or newer.
- **pnpm 10**: run `corepack enable` once (it reads the exact version from `package.json`).
- **ffmpeg** (only for the worker's media jobs and their tests): `brew install ffmpeg` on a Mac,
  `sudo apt-get install ffmpeg` on Ubuntu.
- **Postgres 16** (only to run the web app and the worker together, the real-Postgres tests, or
  `pnpm e2e`).

### 1. Install

```sh
corepack enable
pnpm install
```

### 2. Run the web app on its own (fastest)

This uses an in-process database (PGlite, stored in `apps/web/.data/`), the fake posting provider,
local file storage and a fake transcriber. No accounts or keys needed.

```sh
cp .env.example apps/web/.env.local
pnpm secrets            # prints SESSION_SECRET, TOKEN_ENCRYPTION_KEYS and CRON_SECRET
```

Open `apps/web/.env.local`, paste the three printed values over the empty lines with the same
names, and change `DEV_AUTH=0` to `DEV_AUTH=1` (an email-only sign-in for local use; it is
refused in production). Then:

```sh
pnpm -F @app/web dev
```

Open http://localhost:3000/login and use **Development sign-in** with any email. You can create brands, connect
(fake) accounts, write and approve drafts, and schedule posts. Scheduled posts are published by
the worker, so they wait until you run it (next step). To see the launch checklist, also set
`OWNER_EMAIL` to the email you sign in with and open http://localhost:3000/setup (it shows the
fake services as TEST MODE).

### 3. Run the web app and the worker together

The web app and the worker must share one database and one storage folder, so this needs a local
Postgres. Start one (for example `brew install postgresql@16 && brew services start postgresql@16`
on a Mac, or `docker run -d --name clipcast-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`),
then create the tables:

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm -F @app/db migrate --local-shim
```

It prints `applied 5, already applied 0` (and `applied 0, ...` on later runs). `--local-shim`
adds the few Supabase pieces a plain Postgres lacks (the `auth` schema and roles). Never use it
against Supabase. Use your own user name and password in the URL if they differ.

In `apps/web/.env.local`, set these (absolute paths, so both processes use the same folders):

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
STORAGE_FS_DIR=/full/path/to/this/repo/.data/storage
MEDIA_TMP_DIR=/full/path/to/this/repo/tmp/media
```

Then run each in its own terminal, from the repository root:

```sh
# terminal 1: the web app
pnpm -F @app/web dev

# terminal 2: the worker, reading the same settings file
cd apps/worker
node --env-file=../web/.env.local --import tsx src/main.ts
```

The worker logs `worker started` with the job types it handles, and a minute later its first
`cleanup` job. Stop either one with Ctrl-C. Carousel and template-video renders also need Chromium
for playwright-core: `pnpm -F @app/worker exec playwright-core install chromium` (or set
`CHROMIUM_PATH` to a Chrome/Chromium executable).

### 4. Or watch the whole product run in one command

```sh
pnpm e2e --no-screenshots
```

This starts its own Postgres, builds and starts the web app, starts the worker, then drives
everything the way a person and an AI would (OAuth, MCP tools, approval card, publishing, clips,
carousel) and stops it all again. About 2 minutes. Add `--keep` to leave it running afterwards
and click around (it prints the URLs; Ctrl-C stops it). It needs the Postgres 16 server binaries
(`/usr/lib/postgresql/16/bin`; elsewhere set `E2E_PG_BIN`, e.g.
`E2E_PG_BIN=$(brew --prefix postgresql@16)/bin` on a Mac), ffmpeg and Chromium. Details:
[docs/E2E.md](docs/E2E.md).

## Tests and checks

```sh
pnpm typecheck                 # TypeScript in every package
pnpm lint                      # architecture boundaries (only the adapter may call Upload-Post; no YouTube downloaders)
pnpm test                      # every package's tests (in-process Postgres; external HTTP is always mocked)
pnpm -F @app/web build         # production build of the web app
TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test:pg   # db + services suites on a real Postgres
pnpm e2e --no-screenshots      # the end-to-end run above
```

`pnpm test:pg` creates and drops its own throwaway databases on that server: point it at a local
or CI Postgres, never at Supabase. One package at a time: `pnpm -F @app/services test`.

CI (`.github/workflows/ci.yml`) runs install, typecheck, lint, test, the real-Postgres tests and
the web build on every push and pull request.

## Docs

| Doc | What's in it |
| --- | --- |
| [docs/LAUNCH-ON-PHONE.md](docs/LAUNCH-ON-PHONE.md) | Go live from a phone: each service in order, what to tap and copy, one paste block for Vercel and one for Railway, then `/setup` and Stripe live mode |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Step-by-step deploy: Supabase, R2, Upload-Post, Stripe, AssemblyAI (Whisper later), Vercel, Railway, domain, `/setup`, connecting Claude / ChatGPT / Cursor, smoke tests |
| [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) | What still needs a human (accounts, legal pages, tax) and every product decision that was defaulted |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The v1 build contract: data model, plans, platform rules, interfaces, MCP surface |
| [docs/E2E.md](docs/E2E.md) | The end-to-end run and the bugs it found |
| [docs/REVIEW.md](docs/REVIEW.md) | Security, money and MCP review findings and fixes |
| [docs/handoff/](docs/handoff/) | Per-package notes from the build (start with `integration.md`) |
| [docs/research/](docs/research/) | Research on Upload-Post, platform limits, MCP and infrastructure, with sources |
| [CLAUDE.md](CLAUDE.md) | Product brief and house rules |
