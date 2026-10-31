# Deploy guide

This takes you from "code on GitHub" to "a customer can sign up, connect Claude or ChatGPT, and
publish". Do the steps **in order**: later steps need values from earlier ones. Plan on half a day
the first time, most of it waiting for accounts, DNS and builds.

**Only have a phone?** Follow [LAUNCH-ON-PHONE.md](LAUNCH-ON-PHONE.md) instead: the same launch,
in tap-by-tap order, with one copy-paste block per host. This guide is the full reference.

**The `/setup` page.** Once the site is up, sign in with the address in `OWNER_EMAIL` and open
`https://YOURDOMAIN/setup`. It checks every service below (database and migrations, Supabase sign-in,
R2 bucket and CORS, Upload-Post key, Stripe key, prices, webhook and portal, transcription, the
workers' heartbeats, the legal pages) and shows **OK / Needs attention / Not set** with the fix for
each. Four buttons do the fiddly parts for you: **Fix storage CORS**, **Create missing products and
prices**, **Create webhook endpoint** and **Set up billing portal**. Secret values are never shown.
Anyone else gets a 404 there.

What you end up with:

```
                 Claude / ChatGPT / Cursor
                           │  MCP over HTTPS + OAuth
                           ▼
   browser ──────▶  Vercel: web app + /api/mcp  ───────┐
                           │                           │
                           ▼                           ▼
                Supabase (Postgres + sign-in)    Stripe (billing)
                           ▲
                           │  job queue lives in Postgres
   Railway: worker-posting ┤  publish, status, analytics, imports, clean-up ──▶ Upload-Post ──▶ 9 platforms
   Railway: worker-media ──┘  ingest, transcribe, clip, render ──▶ AssemblyAI (later also Whisper)
                           │
                           ▼
                 Cloudflare R2 (videos and images)
```

Placeholders used below:

- `YOURDOMAIN` is the domain the app will live on, for example `app.yourbrand.com`.
- `APP_URL` is `https://YOURDOMAIN` (https, no trailing slash).

Keep a private note (a password manager is ideal) open while you go and collect every value in
it. The full list of variables, with where each one goes, is at the end:
[All environment variables](#all-environment-variables).

---

## 0. Before you start

**Accounts you will need** (create them as you reach each step):

| Service | Used for | Notes |
| --- | --- | --- |
| GitHub | the code; Vercel and Railway deploy from it | a private repository is fine |
| A domain registrar | `YOURDOMAIN` | any registrar |
| Supabase | database and email sign-in | the free plan is fine to start; Pro for backups |
| An email-sending service | the sign-in emails | Resend, Postmark, Amazon SES or similar (Supabase's built-in mailer is not for real users) |
| Cloudflare | R2 file storage | needs a payment method on file |
| Upload-Post | posting to the 9 platforms, analytics | a paid plan (step 4) |
| Stripe | subscriptions | start in test mode |
| AssemblyAI | transcription (Whisper can be added later) | pay as you go |
| Vercel | web app and MCP server | **Pro plan** before you charge customers (Hobby is for non-commercial use only) |
| Railway | the two workers (and later Whisper) | Hobby to start, Pro for more disk and RAM |

**On your computer**, in a copy of this repository:

```sh
corepack enable        # installs the right pnpm version (once)
pnpm install
pnpm secrets
```

`pnpm secrets` prints three fresh random values. Save them:

- `SESSION_SECRET`: signs cookies and links. Same value on Vercel and both workers.
- `TOKEN_ENCRYPTION_KEYS`: the encryption key for secrets stored in the database. Same value
  everywhere. **Never lose or casually change it.** To rotate it later, put a new key in front:
  `v2:<new>,v1:<old>`.
- `CRON_SECRET`: Vercel only.

**Tip: use Stripe in test mode for the first deploy.** You can then run the whole flow, including
payments with a test card, before real money is involved. Switching to live mode is covered in
[Going live with Stripe](#going-live-with-stripe).

---

## 1. Pick your domain

Decide the final domain now (buy it if needed; DNS is set up in step 7). It goes into the OAuth
settings, Supabase, R2, Stripe and Upload-Post. Changing it later means every connected AI app has
to be reconnected and every one of those settings updated.

A subdomain such as `app.yourbrand.com` is easiest: the landing page and the app are both served
by the same Vercel project, so you can also use the bare `yourbrand.com`.

---

## 2. Supabase: database and sign-in

### 2.1 Create the project

1. In Supabase, create a new project. Pick the **region** closest to where Vercel will run your
   functions (for example "East US (North Virginia)" with Vercel's `iad1` region).
2. Set a strong **database password** using only letters and digits (special characters would
   need URL-encoding in the connection strings). Save it.

### 2.2 Get the two connection strings

Click **Connect** at the top of the project dashboard and choose the **Connection string** tab.

| Name in Supabase | Port | Use it for | Variable |
| --- | --- | --- | --- |
| Transaction pooler | 6543 | Vercel | `DATABASE_URL` on Vercel |
| Session pooler | 5432 | the Railway workers and running migrations | `DATABASE_URL` on Railway |

Both look like
`postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:<port>/postgres`.
Replace `[YOUR-PASSWORD]` with your database password and **add `?sslmode=require` at the end**.

Do not use the "Direct connection" string: it only works over IPv6, which Railway and many home
networks can't reach.

### 2.3 Create the tables (migrations)

From your computer, in the repository, using the **session pooler** string:

```sh
DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require' \
  pnpm -F @app/db migrate
```

Expected output ends with `applied 5, already applied 0`. Running it again prints
`applied 0, already applied 5`; it is always safe to re-run. In **Table Editor** you should now
see 22 tables plus `schema_migrations`, each marked "RLS enabled".

**No computer?** Let Vercel apply them on every deploy instead: set `RUN_MIGRATIONS=1` and
`MIGRATION_DATABASE_URL` (the **session pooler** string) in Vercel (step 7.2). The build runs the
same migrator before `next build`; `/setup` says when a migration is missing.

Run this command again whenever a new file appears in `supabase/migrations`, **before** deploying
the code that needs it.

> **Alternative: the Supabase CLI** (`supabase link --project-ref <ref>` then `supabase db push`)
> also applies the files in `supabase/migrations`. Pick one method and stick to it: the two keep
> separate records of what has been applied, so mixing them would try to apply the same file
> twice. The repo migrator above is the tested path (it also refuses to run against a database
> that isn't Supabase, and checks that applied files were not edited).

### 2.4 Turn on email sign-in

1. **Authentication → Sign In / Providers → Email**: enabled (it is by default). Keep "Confirm
   email" on. Sign-in uses magic links (no passwords). "Allow new users to sign up" must stay on.
2. **Authentication → URL Configuration**:
   - **Site URL**: `https://YOURDOMAIN`
   - **Redirect URLs**: add `https://YOURDOMAIN/**`
3. **Custom SMTP** (required for real users): **Authentication → Emails → SMTP Settings**, turn on
   custom SMTP and enter the host, port, user name, password and sender address from your
   email-sending service. Supabase's built-in mailer only delivers to your own team's addresses
   and only a few emails an hour. After SMTP works, raise the email limit under
   **Authentication → Rate Limits** (for example 100 an hour).
4. The default email templates work as they are. People must open the sign-in link **in the same
   browser** where they asked for it (that is how the secure PKCE flow works); mention it on your
   login page or FAQ if people get "link invalid".

### 2.5 Copy the API keys

**Project Settings → API Keys** (or **Data API**):

- Project URL (`https://<ref>.supabase.co`) → `SUPABASE_URL`
- The `anon` public key (or the newer "publishable" key) → `SUPABASE_ANON_KEY`

The `service_role` / secret key is **not used** by the app. Leave `SUPABASE_SERVICE_ROLE_KEY`
empty; it never needs to leave Supabase.

---

## 3. Cloudflare R2: file storage

1. Cloudflare dashboard → **R2 Object Storage**. Subscribe to R2 if asked (there is a free tier).
2. **Create bucket**: any name (for example `clipcast-media`), location "Automatic". Leave
   public access **off**: every file is served through short-lived signed links.
   - Name → `R2_BUCKET`
3. Bucket → **Settings → CORS policy** → add this policy (it lets the browser upload straight to
   R2 from your site). Or skip this and tap **Fix storage CORS** on `/setup` after step 7 (that
   needs an R2 token allowed to change bucket settings; otherwise `/setup` shows this policy with a
   copy button so you can paste it here):

   ```json
   [
     {
       "AllowedOrigins": ["https://YOURDOMAIN"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   The origin must match `APP_URL` exactly (https, no trailing slash).
4. Bucket → **Settings → Object lifecycle rules**: keep (or add) "abort incomplete multipart
   uploads" after 1–7 days. Do **not** add a rule that deletes files: the worker deletes source
   videos itself after 30 days, and keeps the ones a draft or scheduled post still uses.
5. R2 overview → **Manage API tokens → Create API token**:
   - Permissions: **Object Read & Write**
   - Specify bucket: **only your bucket**
   - Create, then copy:
     - Access Key ID → `R2_ACCESS_KEY_ID`
     - Secret Access Key → `R2_SECRET_ACCESS_KEY` (shown only once)
   - Your **Account ID** (on the R2 overview page, and inside the S3 endpoint
     `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) → `R2_ACCOUNT_ID`
6. Only if you created the bucket in the **EU jurisdiction**: set
   `R2_ENDPOINT=https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`. Otherwise leave it empty.

---

## 4. Upload-Post: posting and analytics

1. Sign up and pick a plan. Each **brand** in the app uses one Upload-Post **profile**. At the time
   of research (check current pricing): Basic $24/mo for 5 profiles, Professional $50/mo for 25
   profiles. **Professional** is the first plan with white-label profiles (the account-connection
   page shows your branding instead of Upload-Post's), so it is the recommended launch plan; Basic
   is fine for a private beta.
2. Dashboard → **API Keys** → create a key → `UPLOAD_POST_API_KEY`.
3. Leave the **X Links** add-on off. The app refuses links in X posts by default (see
   `docs/LAUNCH-CHECKLIST.md`).
4. The webhook is set up in [step 9](#9-webhooks), after the site is live (Upload-Post pauses a
   webhook after 5 failed deliveries, so it should not point at a site that isn't up yet).

`UPLOAD_POST_PROFILE_PREFIX`: leave empty in production (profiles are named `brand_<id>`). Only a
staging copy that shares the same Upload-Post account sets it (for example `stg_`).

---

## 5. Stripe: billing

Do this in **test mode** first (the "Test mode" / sandbox switch in the dashboard). Products,
prices, portal settings, keys and webhooks are separate for test and live mode, so you repeat
this step in live mode at launch.

### 5.1 Products and prices

**Shortcut:** after step 7, the **Create missing products and prices** button on `/setup` creates
exactly these (monthly, USD, with the lookup keys and the amounts from `packages/core/src/plans.ts`)
and fixes a wrong amount by moving the lookup key to a correct price. It is safe to tap twice. By
hand:

**Product catalog → Add product**, five times. Each has **one recurring price, billed monthly, in
USD**. Under the price's advanced options, set the **lookup key** exactly as shown: the app finds
prices by lookup key, so you never copy price ids.

| Product name | Price | Lookup key |
| --- | --- | --- |
| Starter | $8.00 / month | `starter` |
| Plus | $15.00 / month | `plus` |
| Pro | $25.00 / month | `pro` |
| Extra brand | $3.00 / month per unit | `extra_brand` |
| Extra clipping hour | $1.00 / month per unit | `extra_clip_hour` |

Keep only one active price per lookup key. (If you ever prefer fixed ids, set
`STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_EXTRA_BRAND`,
`STRIPE_PRICE_EXTRA_CLIP_HOUR` to the `price_...` ids; not needed otherwise.)

There is no Stripe trial: the 7-day trial runs inside the app and needs no card.

### 5.2 Customer portal

**Shortcut:** the **Set up billing portal** button on `/setup` creates a portal configuration
(cancel at the end of the billing period, payment-method updates, invoice history, plan switching
between Starter, Plus and Pro, your `/privacy` and `/terms` links), and the app uses it for
"Manage billing". By hand:

**Settings → Billing → Customer portal**:

- **Payment methods**, **Invoice history**, **Billing information**: on.
- **Cancel subscriptions**: on, **at the end of the billing period**.
- **Switch plan** (customers can switch plans): on. Add the products **Starter, Plus and Pro**
  (not the add-ons). **Prorate subscription updates**: on, and invoice the difference
  **immediately**, so an upgrade is paid (and unlocked in the app) right away. **Manage
  downgrades**: leave **"Update immediately"** (Stripe can only delay a downgrade to the end of
  the period between prices of the same product).
- **Update quantities**: off.
- **Business information** (Settings → Public details): business name, support email, and links to
  your terms and privacy policy.

Known limit: Stripe's portal can't change a subscription that contains more than one product, so
customers who bought an add-on can update their card and cancel in the portal, but not switch
plans or change add-ons. See `docs/LAUNCH-CHECKLIST.md`.

### 5.3 API key

**Developers → API keys → Secret key** → `STRIPE_SECRET_KEY` (`sk_test_...` now, `sk_live_...` at
launch). The webhook secret comes in [step 9](#9-webhooks).

---

## 6. Transcription: AssemblyAI to start, self-hosted Whisper later

The media worker transcribes source videos before clipping.

**Recommended for launch: `TRANSCRIPTION_PROVIDER=assemblyai`** (step 6.1 only). No server to run,
and AssemblyAI charges per hour of audio, which is the cheapest option at low volume. When volume
grows, add your own Whisper server (step 6.2) and switch to `TRANSCRIPTION_PROVIDER=chain`: it tries
Whisper first and falls back to AssemblyAI automatically, so a Whisper outage never stops clipping.

### 6.1 AssemblyAI

Sign up, add billing, copy the API key from the dashboard → `ASSEMBLYAI_API_KEY`. (EU data
residency: also set `ASSEMBLYAI_BASE_URL=https://api.eu.assemblyai.com`.) The app deletes each
transcript from AssemblyAI right after it gets it back.

### 6.2 Self-hosted Whisper on Railway (later, to cut cost)

Any server that offers OpenAI's `/v1/audio/transcriptions` API with `verbose_json` and word
timestamps works. A good open-source option is **speaches** (faster-whisper behind an
OpenAI-compatible API). In your Railway project (create it now, or come back after step 8):

1. **New → Docker Image** → `ghcr.io/speaches-ai/speaches:latest-cpu`. Name the service `whisper`.
2. Variables: `API_KEY=<a long random string>` (use the same value for `WHISPER_API_KEY` on the
   media worker).
3. Resources: 2–4 vCPU and 4 GB RAM. No public domain is needed.
4. The media worker reaches it over Railway's private network:
   `WHISPER_URL=http://whisper.railway.internal:8000/v1`.
5. `WHISPER_MODEL`: the model to load, for example `Systran/faster-whisper-small` (fast on CPU) or
   `Systran/faster-distil-whisper-large-v3` (more accurate, slower). Depending on the speaches
   version, a model may have to be downloaded once before first use: follow the speaches README.

This setup is not tested here (no live services). The smoke test in step 10 checks it: the
media worker logs which engine answered. If Whisper fails, AssemblyAI takes over, so clipping keeps
working while you fix it. If the worker can't reach Whisper over the private network, check the
speaches docs for listening on IPv6 (`::`), which Railway's private network may require.

A Whisper box costs money every hour it runs, while AssemblyAI charges per hour of audio, so start
with AssemblyAI alone and switch to `chain` when volume grows. `/setup` checks the AssemblyAI key
(one free authenticated call); it can't reach a Whisper server on Railway's private network from
Vercel, so for Whisper watch the media worker's logs (they name the engine that answered).

---

## 7. Vercel: web app and MCP server

### 7.1 Create the project

1. Push this repository to GitHub.
2. Vercel → **Add New → Project** → import the repository.
3. **Root Directory**: `apps/web`. Framework: Next.js (detected). Leave the install and build
   commands on their defaults: Vercel detects the pnpm workspace, installs it and runs
   `next build` in `apps/web`. Keep "Include files outside the root directory in the
   Build Step" **enabled** (Settings → Build and Deployment).
4. **Node.js version**: 22.x (Settings → Build and Deployment).
5. Add the environment variables below **before** the first deploy (Settings → Environment
   Variables, environment **Production**; mark the secret ones as Sensitive).

### 7.2 Vercel environment variables

| Variable | Value |
| --- | --- |
| `APP_ENV` | `production` |
| `APP_URL` | `https://YOURDOMAIN` |
| `DATABASE_URL` | Supabase **transaction pooler** string (port 6543) with `?sslmode=require` |
| `SESSION_SECRET` | from `pnpm secrets` |
| `TOKEN_ENCRYPTION_KEYS` | from `pnpm secrets` |
| `CRON_SECRET` | from `pnpm secrets` (Vercel sends it to the cron routes automatically) |
| `SUPABASE_URL` | step 2.5 |
| `SUPABASE_ANON_KEY` | step 2.5 |
| `POSTING_PROVIDER` | `upload_post` |
| `UPLOAD_POST_API_KEY` | step 4 |
| `UPLOAD_POST_WEBHOOK_SECRET` | step 9 (add it then and redeploy) |
| `STORAGE_DRIVER` | `r2` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | step 3 |
| `STRIPE_SECRET_KEY` | step 5.3 |
| `STRIPE_WEBHOOK_SECRET` | optional: only if you create the webhook by hand (step 9.1). The **Create webhook endpoint** button on `/setup` stores the signing secret encrypted in the database instead; a value here always wins. |
| `TRANSCRIPTION_PROVIDER` | `assemblyai` |
| `ASSEMBLYAI_API_KEY` | step 6.1 (lets the start-up check pass and `/setup` verify the key) |
| `OWNER_EMAIL` | the email **you** sign in with: only that account can open `/setup` |
| `SUPPORT_EMAIL` | the address customers write to (shown on `/contact`, `/privacy`, `/terms`) |
| `LEGAL_ENTITY_NAME` | your name or company (the legal pages) |
| `LEGAL_JURISDICTION` | whose law governs the terms, e.g. `the State of Delaware, United States` |
| `LEGAL_EFFECTIVE_DATE` | when the terms and privacy policy took effect, `YYYY-MM-DD` |
| `RUN_MIGRATIONS`, `MIGRATION_DATABASE_URL` | optional: `1` and the Supabase **session pooler** string to apply migrations on every deploy (step 2.3) |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` (optional: builds with the exact pnpm version from `package.json`) |

Why transcription settings on the web app: the web app never transcribes, but its start-up check
refuses to run in production without a real engine configured, and `/setup` checks the key from
here. (Running Whisper with `chain`? Set `TRANSCRIPTION_PROVIDER=chain`, `WHISPER_URL` and the
AssemblyAI key here as on the media worker.)

Until the legal values are set, `/privacy`, `/terms` and `/contact` show `[set NAME]` placeholders
and `/setup` lists what is missing. Have a lawyer read the pages before real customers arrive.

Leave `NODE_ENV` unset (Vercel sets it), `DEV_AUTH` unset (it is refused in production), and
`MCP_RESOURCE_URL` unset (it defaults to `APP_URL/api/mcp`).

Only the **Production** environment gets these variables. Preview deployments (for other
branches) get none, so their sign-in and dashboard pages won't work; that is expected. Never point
previews at the production database.

### 7.3 Deploy and add the domain

1. **Deploy**. The build takes a few minutes.
2. **Settings → Domains** → add `YOURDOMAIN`. Vercel shows the DNS record to create at your
   registrar (a `CNAME` to Vercel for a subdomain, an `A` record for a bare domain). Wait until the
   domain shows as valid with a certificate.
3. **Settings → Functions**: set the function region to the one closest to your Supabase region.
4. Any time you change an environment variable: **Deployments → ⋯ → Redeploy**. Variables only
   apply to new deployments.

### 7.4 Crons

`apps/web/vercel.json` already declares two daily jobs: `/api/cron/cleanup` (04:23 UTC) and
`/api/cron/analytics` (05:41 UTC). Check that they appear under **Settings → Cron Jobs**. The
posting worker runs the same work more often on its own; the Vercel crons are a backup.

---

## 8. Railway: the two workers

Both workers run the same Docker image (`apps/worker/Dockerfile`, with ffmpeg and Chromium) and
differ only in `WORKER_TYPES`.

### 8.1 worker-posting

1. Railway → **New Project → Deploy from GitHub repo** → pick the repository. Rename the new
   service to `worker-posting`.
2. Service **Settings**:
   - **Root Directory**: empty (the repository root). The image needs the whole workspace.
   - **Config as code** (Railway config file): `apps/worker/railway.toml`. This sets the
     Dockerfile path, the `/health` check, restarts and the shutdown grace period.
   - **Networking**: no public domain needed.
   - **Draining seconds** (Deploy section): 120, if Railway did not pick it up from the file.
3. **Variables**: the shared ones from the table below, plus `WORKER_TYPES=posting`,
   `WORKER_CONCURRENCY=4`, `PORT=8080`.
4. Resources: 1 vCPU and 1 GB RAM is plenty.
5. **Redeploy** (Deployments → ⋯ → Redeploy). Railway starts a first build as soon as the
   service is created, before it knows the config file and variables; if that first attempt fails,
   that is expected.

Tip: put the variables both workers share under **Project Settings → Shared Variables** once, and
reference them in each service (`${{shared.DATABASE_URL}}` and so on), so you change them in one
place.

### 8.2 worker-media

1. In the same project: **New → GitHub Repo** → the same repository. Name it `worker-media`.
2. Same settings as above (root directory empty, config file `apps/worker/railway.toml`).
3. **Variables**: the shared ones, plus `WORKER_TYPES=media`, `WORKER_CONCURRENCY=1`, `PORT=8080`,
   and the transcription settings (`TRANSCRIPTION_PROVIDER=assemblyai` and `ASSEMBLYAI_API_KEY`;
   with your own Whisper later: `TRANSCRIPTION_PROVIDER=chain`, `WHISPER_URL`, `WHISPER_API_KEY`,
   `WHISPER_MODEL`).
4. Resources: at least **2 vCPU and 4 GB RAM** (ffmpeg and Chromium). Raise
   `WORKER_CONCURRENCY` to 2 on 4+ vCPU.
5. Disk: source videos (up to 10 GB each) are downloaded to `/tmp/worker-media` while they are
   processed. Check your Railway plan's disk limit. If large uploads fail with "no space left on
   device", attach a **Volume** mounted at `/tmp/worker-media`; the image runs as a non-root user,
   so also follow Railway's instructions for volume permissions with non-root images (a
   `RAILWAY_RUN_UID=0` variable at the time of writing).

### 8.3 Railway variables

| Variable | worker-posting | worker-media |
| --- | --- | --- |
| `APP_ENV` | `production` | `production` |
| `APP_URL` | `https://YOURDOMAIN` | `https://YOURDOMAIN` |
| `DATABASE_URL` | Supabase **session pooler** string (port 5432) with `?sslmode=require` | same |
| `SESSION_SECRET` | from `pnpm secrets` (same as Vercel) | same |
| `TOKEN_ENCRYPTION_KEYS` | from `pnpm secrets` (same as Vercel) | same |
| `POSTING_PROVIDER` | `upload_post` | `upload_post` |
| `UPLOAD_POST_API_KEY` | step 4 | step 4 |
| `STORAGE_DRIVER` | `r2` | `r2` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | step 3 | step 3 |
| `TRANSCRIPTION_PROVIDER` | `assemblyai` (start-up check only; this worker never transcribes) | `assemblyai` (or `chain` with Whisper, step 6.2) |
| `ASSEMBLYAI_API_KEY` | step 6.1 | step 6.1 |
| `WHISPER_URL`, `WHISPER_API_KEY`, `WHISPER_MODEL` | not needed | only with `chain` (step 6.2) |
| `WORKER_TYPES` | `posting` | `media` |
| `WORKER_CONCURRENCY` | `4` | `1` |
| `PORT` | `8080` | `8080` |

`NODE_ENV` is set by the image. Neither worker needs the Supabase, Stripe, cron or webhook
secrets. If you set `UPLOAD_POST_PROFILE_PREFIX` anywhere, set the same value on Vercel and both
workers.

### 8.4 Deploy

The first build downloads the Playwright base image (about 2 GB), so it takes several minutes.
When it's up, the logs show `worker started` with the job types it handles, and the service is
marked healthy (Railway calls `GET /health`). Within a few minutes the posting worker also logs its
first scheduled `cleanup` job. Each worker records a heartbeat in the database every minute, so
`/setup` shows "Posting worker / Media worker: last seen N seconds ago" (or "not running").

The image was built and started locally before handover (production settings, health check,
graceful stop, a Chromium slide render and ffmpeg with captions support all worked), but not yet
on Railway. If the Railway build fails, its log names the failing line of `apps/worker/Dockerfile`.

---

## 9. Webhooks

Now that `https://YOURDOMAIN` is live:

### 9.1 Stripe

**Shortcut:** tap **Create webhook endpoint** on `/setup`. It creates the endpoint for
`https://YOURDOMAIN/api/stripe/webhook` with exactly the five events below and stores the signing
secret encrypted (with `TOKEN_ENCRYPTION_KEYS`) in the database, so you never copy it. The webhook
route uses `STRIPE_WEBHOOK_SECRET` when it is set, otherwise the stored one, and always verifies the
signature. Test and live mode each get their own endpoint and secret. By hand:

1. **Developers → Webhooks → Add endpoint** (in newer dashboards: Workbench → Webhooks → Create
   an event destination, "Your account").
2. URL: `https://YOURDOMAIN/api/stripe/webhook`
3. API version: the newest offered (the code is built against `2026-10-28.endive`).
4. Events (exactly these five):
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
5. Copy the **signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET` on Vercel → redeploy.

### 9.2 Upload-Post

1. First generate a secret if Upload-Post lets you choose one (`openssl rand -hex 32`), or copy the
   signing secret Upload-Post shows for the webhook.
2. Put it in `UPLOAD_POST_WEBHOOK_SECRET` on Vercel and **redeploy before turning the webhook on**:
   without it the app answers 503, and Upload-Post pauses a webhook after 5 failures.
3. In the Upload-Post dashboard (webhooks / notifications settings): URL
   `https://YOURDOMAIN/api/webhooks/upload-post`, events `upload_completed`,
   `social_account_connected`, `social_account_disconnected`, `social_account_reauth_required`.
   Do not enable `comment_received` or `dm_received`.

The app verifies every delivery's signature (`X-Upload-Post-Signature`) and refuses unsigned or
stale ones. To rotate the secret later, set `UPLOAD_POST_WEBHOOK_SECRET=new,old`, redeploy, change
it in Upload-Post, then remove `,old`.

---

## 10. Smoke test after deploy

Do these in order; each one depends on the ones before. Use a test social account for anything
that publishes: posts are real.

**From a terminal:**

- [ ] `curl -s https://YOURDOMAIN/.well-known/oauth-protected-resource` returns JSON with
      `"resource":"https://YOURDOMAIN/api/mcp"`.
- [ ] `curl -s https://YOURDOMAIN/.well-known/oauth-authorization-server` returns JSON with
      `registration_endpoint` and `"code_challenge_methods_supported":["S256"]`.
- [ ] `curl -si -X POST https://YOURDOMAIN/api/mcp` answers `401` with a
      `www-authenticate` header that starts with `Bearer resource_metadata="https://YOURDOMAIN/.well-known/oauth-protected-resource/api/mcp"`.

**In the browser:**

- [ ] `/setup` (signed in as `OWNER_EMAIL`): nothing left under **Needs attention** or **Not set**
      except what you chose to leave (for example Whisper).
- [ ] `/privacy`, `/terms` and `/contact` show your details (no `[set NAME]` placeholders), and
      every page's footer links to them.
- [ ] The landing page loads and shows $8 / $15 / $25.
- [ ] `/login` → enter your email → the email arrives within a minute → open the link in the same
      browser → you land in the dashboard with a trial banner.
- [ ] Supabase **Table Editor → users** has your row (`plan` starter, `subscription_status`
      trialing).
- [ ] **Brands**: create a brand.
- [ ] **Accounts**: Connect a platform (LinkedIn or X are quickest) → the Upload-Post page opens →
      connect → you return to Accounts and the account shows Active. The Upload-Post dashboard
      lists a profile named `brand_<id>`.
- [ ] **Media**: upload a short video you own (under a minute), tick "I own this content". It turns
      Ready within a minute or two; worker-media's logs show `source_ingest` then `transcribe`
      (and which engine answered). The **Clips** page shows the transcript; the overview's clip-time
      meter went up.
- [ ] **Clips**: make a 10-second clip. It turns Ready and a draft appears under **Approvals**.
      The clip is vertical (1080×1920) with burned-in captions.
- [ ] **Approvals**: approve a text draft and schedule it 5 minutes ahead. **Calendar** shows it;
      after it runs, it shows Published with a link that opens the real post.
- [ ] **Billing**: choose Starter → Stripe Checkout (test card `4242 4242 4242 4242`, any future
      date, any CVC) → back on Billing it shows Starter, active. In Stripe, the webhook endpoint
      shows successful (2xx) deliveries. "Manage billing" opens the Stripe portal.
- [ ] Vercel **Settings → Cron Jobs** → run `/api/cron/cleanup` once → it succeeds.
- [ ] Railway: both workers healthy, no error repeating in the logs.
- [ ] Upload-Post dashboard: webhook deliveries succeed.
- [ ] **Connect your AI** page (`/app/connect`) shows `https://YOURDOMAIN/api/mcp`.

---

## 11. Connect Claude, ChatGPT and Cursor

The server URL for every app is **`https://YOURDOMAIN/api/mcp`** (also on `/app/connect` with a
copy button). Each app opens your site to sign in and shows a consent page (Allow / Deny). Nothing
the AI does publishes without your approval.

**Claude** (claude.ai on the web and desktop, then also on mobile):

1. **Settings → Connectors → Add custom connector**. (On Team and Enterprise plans an owner adds it
   first under the organization's settings.)
2. Name it (your product name) and paste the server URL. Add.
3. **Connect** → sign in on your site → **Allow**.
4. In a chat, turn it on from the tools menu (the "search and tools" button below the message box).

Claude Code (optional): `claude mcp add --transport http clipcast https://YOURDOMAIN/api/mcp`,
then run `/mcp` inside Claude Code to sign in.

**ChatGPT** (paid plans with developer mode):

1. **Settings → Apps & Connectors → Advanced settings** → turn on **Developer mode**.
2. Back in Apps & Connectors → **Create**. Name it, paste the server URL, authentication **OAuth**.
3. Sign in on your site → **Allow**.
4. In a chat, add it from the **+** menu (developer mode).

ChatGPT may not offer MCP prompts (`write_post`, `pick_clips`, `weekly_review`). Ask in plain
words instead ("write a post in my voice", "run my weekly review"): the tools carry the same
playbook.

**Cursor:**

1. Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

   ```json
   {
     "mcpServers": {
       "clipcast": { "url": "https://YOURDOMAIN/api/mcp" }
     }
   }
   ```

2. **Cursor Settings → MCP**: the server shows that it needs a login → click it → sign in in the
   browser → **Allow**.

Menu names in these apps change often; if a step doesn't match, search the app's help for "custom
connector" / "MCP". Connected apps are listed on `/app/connect`, where you can disconnect them.

---

## 12. Test each step from both Claude and ChatGPT

`CLAUDE.md` asks for every build step to be tested from both apps. All eight steps are built, so
run the whole list once in Claude and once in ChatGPT. Start a new chat with the connector turned
on. Tick both boxes before moving on.

| # | Build step | Ask the AI / do this | Pass when | Claude | ChatGPT |
| --- | --- | --- | --- | --- | --- |
| 1 | Database schema | "List my brands and connected accounts." | It lists the brand you created on the web, with its accounts (`list_accounts`). | [ ] | [ ] |
| 2 | Posting, job queue, connect / list / schedule tools | "Connect my LinkedIn account to <brand>." Open the link it gives, connect, then "List my accounts again." | The link opens the Upload-Post page; the account then shows as active. | [ ] | [ ] |
| 2b | | Before approving anything: "Schedule draft <id> for tomorrow 9am." | Refused: the draft must be approved first. | [ ] | [ ] |
| 3 | MCP server with OAuth; draft and approval tools | Adding the connector asks you to sign in and Allow. Then: "Write a LinkedIn post and an X post about our launch and save them as a draft." Then "Show my drafts." | A draft with two variants (`create_draft`), listed by `list_drafts`. | [ ] | [ ] |
| 3b | | "Add our website link to the X version." | Refused with a clear message: links are not supported in X posts. | [ ] | [ ] |
| 3c | | Disconnect the app on `/app/connect`, then ask anything. | The app loses access and asks you to reconnect. Reconnect afterwards. | [ ] | [ ] |
| 4 | Approval card | "Show me the approval card for that draft." | An interactive card with a tab per platform, character counts, Approve / Edit / Reject. Edit some text: it saves. Approve: the card shows Approved. (If no card appears, the reply contains a link to `/app/approvals?draft=...`, which works too.) | [ ] | [ ] |
| 4b | | "Approve it for me." | The AI can't: it tells you to click Approve. | [ ] | [ ] |
| 4c | | "Schedule the approved draft for 10 minutes from now", later "What's the status of my posts?" | `schedule_post` succeeds; `post_status` shows scheduled, then published with a URL. | [ ] | [ ] |
| 5 | Clip worker | Upload a video on `/app/media` (rights box ticked). "Find the 3 best clips in my latest video and make them." Later: "Are my clips ready?" | It reads the transcript (`get_transcript`), calls `make_clips`, and the clips become ready as drafts (not posts): vertical, captions burned in, clip time charged once. | [ ] | [ ] |
| 5b | | "Clip this video: https://www.youtube.com/watch?v=..." | Refused: only the user's own uploads and cloud-drive links. | [ ] | [ ] |
| 6 | Voice profile and `write_post` | "Import my past LinkedIn posts." Then "Save my voice profile: friendly, plain words, no emojis, at most 2 hashtags." Then (Claude: pick the `write_post` prompt from the connector's menu; ChatGPT: ask) "Write a post about <topic> in my voice." | Import job finishes (`post_status` on the job); the profile is saved; the new draft follows it (no emojis, ≤ 2 hashtags). | [ ] | [ ] |
| 7 | Carousels, template videos, analytics, weekly review | "Make a 4-slide carousel with these points: ..." and "Make a 20-second vertical video from these 4 lines: ..." Then "How did my posts do this week?" and (Claude: `weekly_review` prompt; ChatGPT: ask) "Run my weekly review." | Each render becomes a draft (slides 1080×1350 JPEG; MP4 video). Analytics answer (numbers appear about 24 h after a post publishes). The review proposes exactly 3 experiments and doesn't schedule anything without approval. | [ ] | [ ] |
| 8 | Web app and billing with plan limits | On Starter, try to create a second brand on `/app/brands`. Use up clip time (or check the meter), then ask the AI to make clips. In the Stripe portal, switch to Plus. | The second brand is refused at the limit; the AI gets a neutral "limit reached" message (no sales pitch); after switching to Plus, the limit goes to 2 brands / 10 hours. | [ ] | [ ] |

Cursor: run rows 1, 3 and 4 as well (Cursor has no approval card; the link to the web app is the
fallback).

---

## 13. After launch

**Deploying changes.** Pushing to the main branch redeploys Vercel and both Railway services. If
the change adds a file to `supabase/migrations`, run the migration command from step 2.3 first.

**Going live with Stripe.** Switch the dashboard to live mode, replace `STRIPE_SECRET_KEY` on
Vercel with the live key (and remove `STRIPE_WEBHOOK_SECRET` if you set one) and redeploy. Then on
`/setup` tap **Create missing products and prices**, **Create webhook endpoint** and **Set up
billing portal** again: they create the live versions (by hand: redo step 5 and step 9.1 in live
mode). Accounts you created while
testing still point at test-mode Stripe customers: archive their brands (this frees their
Upload-Post profiles), then delete those users in Supabase (**Authentication → Users**; their app
data is deleted with them).

**Logs.** Vercel → Logs (web app and MCP); Railway → each service's logs. Logs are JSON lines and
never contain tokens or keys.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `/setup` answers "page not found" | You are not signed in with the `OWNER_EMAIL` address (or it is misspelled in Vercel). Without `OWNER_EMAIL`, `/setup` only says how to set it. |
| Error page or worker crash with `Invalid configuration: X is required ...` | A variable is missing or malformed. The message names it (never its value). Fix it, then redeploy. |
| `schema "auth" not found` when migrating | The URL is not your Supabase database. (For a plain local Postgres, add `--local-shim`.) |
| Railway workers time out or log `ENETUNREACH` reaching the database | You used the direct connection string. Use the session pooler (port 5432 on `pooler.supabase.com`). |
| Sign-in link says "invalid" | It was opened in a different browser than the one that asked for it, or `https://YOURDOMAIN/**` is missing from Supabase's Redirect URLs. |
| No sign-in email | Custom SMTP not configured, or Supabase's email rate limit reached (step 2.4). |
| Browser upload fails with a CORS error | The R2 CORS `AllowedOrigins` doesn't exactly match `APP_URL`. |
| AI app can't connect or keeps asking to sign in | The URL you pasted must be exactly `APP_URL` + `/api/mcp` (https, no trailing slash). Check the three `curl` checks in step 10. |
| Stripe webhook deliveries fail with 409 | The event's customer doesn't match a user yet (Stripe retries automatically). Repeated 409s for real checkouts: check that the checkout started from the app's Billing page. |
| Posts stay "scheduled" | worker-posting is down or can't reach the database: check its logs. |
| Clips stay "processing" | worker-media is down, out of memory or disk: check its logs and resources. |

---

## All environment variables

Every variable the code reads (`packages/core/src/config.ts`). "—" means not needed there.

| Variable | Vercel | worker-posting | worker-media | Where the value comes from |
| --- | --- | --- | --- | --- |
| `APP_ENV` | `production` | `production` | `production` | fixed |
| `APP_URL` | yes | yes | yes | `https://YOURDOMAIN` |
| `MCP_RESOURCE_URL` | leave empty | — | — | defaults to `APP_URL/api/mcp` |
| `LOG_LEVEL` | optional | optional | optional | `info` (default) |
| `NODE_ENV` | — (Vercel sets it) | — (image sets it) | — (image sets it) | |
| `DATABASE_URL` | transaction pooler :6543 | session pooler :5432 | session pooler :5432 | Supabase → Connect (step 2.2), plus `?sslmode=require` |
| `DATABASE_POOL_MAX` | optional | optional | optional | default 5 connections per process |
| `SUPABASE_URL` | yes | — | — | Supabase → API Keys |
| `SUPABASE_ANON_KEY` | yes | — | — | Supabase → API Keys (anon / publishable) |
| `SUPABASE_SERVICE_ROLE_KEY` | — | — | — | not used; leave empty |
| `DEV_AUTH` | — | — | — | local development only; refused in production |
| `SESSION_SECRET` | yes | yes | yes | `pnpm secrets` (same value everywhere) |
| `TOKEN_ENCRYPTION_KEYS` | yes | yes | yes | `pnpm secrets` (same value everywhere) |
| `CRON_SECRET` | yes | — | — | `pnpm secrets` |
| `OWNER_EMAIL` | yes | — | — | your sign-in email: the only account that can open `/setup` |
| `SUPPORT_EMAIL`, `LEGAL_ENTITY_NAME`, `LEGAL_JURISDICTION`, `LEGAL_EFFECTIVE_DATE` | yes | — | — | the legal and contact pages (step 7.2) |
| `RUN_MIGRATIONS`, `MIGRATION_DATABASE_URL` | optional | — | — | apply migrations during the Vercel build (step 2.3) |
| `OAUTH_ACCESS_TOKEN_TTL_SEC`, `OAUTH_REFRESH_TOKEN_TTL_SEC`, `OAUTH_CODE_TTL_SEC`, `APPROVAL_NONCE_TTL_SEC` | optional | — | — | defaults: 1 h, 30 days, 5 min; approval links last at most 24 h |
| `POSTING_PROVIDER` | `upload_post` | `upload_post` | `upload_post` | fixed (`fake` is refused in production) |
| `UPLOAD_POST_API_KEY` | yes | yes | yes | Upload-Post dashboard (step 4) |
| `UPLOAD_POST_WEBHOOK_SECRET` | yes | — | — | Upload-Post webhook settings (step 9.2) |
| `UPLOAD_POST_BASE_URL` | — | — | — | leave empty (the adapter has the default) |
| `UPLOAD_POST_PROFILE_PREFIX` | leave empty | leave empty | leave empty | only for a staging copy sharing the account |
| `STORAGE_DRIVER` | `r2` | `r2` | `r2` | fixed (`fs`/`memory` refused in production) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | yes | yes | yes | Cloudflare R2 (step 3) |
| `R2_ENDPOINT` | EU buckets only | EU buckets only | EU buckets only | `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com` |
| `STORAGE_FS_DIR`, `PGLITE_DATA_DIR` | — | — | — | local development only |
| `TRANSCRIPTION_PROVIDER` | `assemblyai` | `assemblyai` | `assemblyai` (or `chain` with Whisper) | see steps 6 and 7.2 |
| `ASSEMBLYAI_API_KEY` | yes | yes | yes | AssemblyAI dashboard (step 6.1) |
| `WHISPER_URL` | only with `chain` | — | only with `chain` | `http://whisper.railway.internal:8000/v1` |
| `WHISPER_API_KEY` | — | — | if your server has one | the Whisper service's `API_KEY` |
| `WHISPER_MODEL` | — | — | with `chain` | e.g. `Systran/faster-whisper-small` (default `whisper-1`) |
| `ASSEMBLYAI_BASE_URL` | — | — | EU only | `https://api.eu.assemblyai.com` |
| `STRIPE_SECRET_KEY` | yes | — | — | Stripe → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | optional | — | — | Stripe webhook endpoint made by hand (step 9.1); `/setup` stores it otherwise |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_EXTRA_BRAND`, `STRIPE_PRICE_EXTRA_CLIP_HOUR` | optional | — | — | only to pin price ids; lookup keys are used otherwise |
| `WORKER_TYPES` | — | `posting` | `media` | fixed |
| `WORKER_CONCURRENCY` | — | `4` | `1` (2 on 4+ vCPU) | |
| `WORKER_POLL_INTERVAL_MS` | — | optional | optional | default 1000 |
| `WORKER_ID` | — | optional | optional | defaults to host name + process id |
| `PORT` | — | `8080` | `8080` | health check port |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `CHROMIUM_PATH` | — | — | optional | the image already has them |
| `MEDIA_TMP_DIR` | — | — | optional | the image sets `/tmp/worker-media` |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` (optional) | — | — | Vercel build setting |
