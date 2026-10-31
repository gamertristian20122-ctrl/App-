# Go live from your phone

The real launch, done entirely by tapping in a mobile browser. About 2 hours of tapping, plus
waiting for Stripe to activate your account (start that early, step 4).

You already have a **Supabase project** (from [TEST-ON-PHONE.md](TEST-ON-PHONE.md)). Everything
else is set up in this order, because later steps need values from earlier ones:

1. Supabase: copy 4 values
2. Cloudflare R2: file storage
3. Upload-Post: posting
4. Stripe: payments (test mode first)
5. AssemblyAI: transcription
6. Resend + Supabase: sign-in emails
7. Vercel: the website (paste one block)
8. Railway: the two workers (paste one block each)
9. `/setup`: tap through the checklist
10. Try it
11. Stripe live mode

**How to use this guide.** Open a notes app. Each step says what to **tap**, what to **copy**, and
the **variable name** to paste it next to. At step 7 and 8 you paste whole blocks from your notes.
Keep the note private (a password manager is best): it holds keys.

Placeholders below:

- `YOUR-SITE` = your site address, for example `clipcast-abc.vercel.app` (you get it in step 7) or
  your own domain.

---

## 0. Make three secret values (2 minutes)

Ask Claude (any chat):

> Generate three random secrets for my app's environment variables, in this exact format, and
> nothing else:
> `SESSION_SECRET=` 43 random base64url characters
> `TOKEN_ENCRYPTION_KEYS=v1:` followed by 32 random bytes in base64
> `CRON_SECRET=` 32 random base64url characters

Paste the three lines into your note. Use **new** values, not the ones from the test version.
Never change `TOKEN_ENCRYPTION_KEYS` later: it unlocks secrets stored in the database.

---

## 1. Supabase: copy 4 values (5 minutes)

supabase.com → your project.

| Tap | Copy | Paste next to |
| --- | --- | --- |
| **Connect** (top of the page) → **Transaction pooler** | the connection string (port **6543**) | `DATABASE_URL=` |
| **Connect** → **Session pooler** | the connection string (port **5432**) | `MIGRATION_DATABASE_URL=` |
| **Project Settings → API Keys** | Project URL | `SUPABASE_URL=` |
| same page | `anon` / publishable key | `SUPABASE_ANON_KEY=` |

In both connection strings: replace `[YOUR-PASSWORD]` with your database password and add
`?sslmode=require` at the end.

Recommended before real customers: **Settings → Billing → Pro plan** (daily backups; free
projects pause after a week without use).

---

## 2. Cloudflare R2: file storage (10 minutes)

dash.cloudflare.com → sign up or in → **R2 Object Storage** (add a payment method if asked; there
is a free tier).

1. **Create bucket** → name it `clipcast-media` → Location **Automatic** → **Create**. Keep public
   access off.
   - Copy the name → `R2_BUCKET=`
2. Back on the R2 overview: copy your **Account ID** → `R2_ACCOUNT_ID=`
3. **Manage API tokens** (or **API → Manage API tokens**) → **Create API token**:
   - Permissions: **Object Read & Write**
   - Specify bucket: **only `clipcast-media`**
   - **Create**, then copy right away (shown once):
     - Access Key ID → `R2_ACCESS_KEY_ID=`
     - Secret Access Key → `R2_SECRET_ACCESS_KEY=`

The bucket's CORS setting (it lets browsers upload videos) is done later on `/setup` with one tap.

---

## 3. Upload-Post: posting (5 minutes)

upload-post's website → sign up → pick a plan: **Basic** ($24/mo, 5 brands, their branding on the
connect page) is fine for a private beta; **Professional** ($50/mo, 25 brands, your branding) for
launch. Check current prices.

1. Dashboard → **API Keys** → **Create** → copy → `UPLOAD_POST_API_KEY=`
2. Leave the **X Links** add-on off.

The webhook comes in step 9 (after the site is live).

---

## 4. Stripe: payments (10 minutes, then wait)

stripe.com → sign up.

1. **Start activation now** (it can take a day): **Activate payments** (or **Settings → Business**)
   → business details, bank account, identity check.
2. Meanwhile, use **test mode** (the "Test mode" / sandbox switch): **Developers → API keys** →
   **Secret key** → reveal → copy (starts with `sk_test_`) → `STRIPE_SECRET_KEY=`
3. **Settings → Public details**: business name and support email. (Add the privacy and terms
   links after step 7: `https://YOUR-SITE/privacy` and `https://YOUR-SITE/terms`.)

Do **not** create products, prices, webhooks or the customer portal by hand: `/setup` does all of
it with four taps (step 9).

---

## 5. AssemblyAI: transcription (3 minutes)

assemblyai.com → sign up → **Billing** → add a card (pay as you go).

1. Dashboard → **API Keys** → copy → `ASSEMBLYAI_API_KEY=`

We start with AssemblyAI only (`TRANSCRIPTION_PROVIDER=assemblyai`): no server to run, and you pay
per hour of audio, which is cheapest at low volume. Self-hosted Whisper can come later to cut cost
(docs/DEPLOY.md, step 6.2).

---

## 6. Resend + Supabase: sign-in emails (15 minutes + DNS wait)

Supabase's built-in email only reaches your own team. Real customers need your own sender. This
needs a domain you own (the same one you may use for the site).

**Resend** (resend.com → sign up):

1. **Domains → Add domain** → your domain → Resend shows DNS records (SPF, DKIM). Add them at your
   domain registrar (its app or website → DNS). Back in Resend → **Verify** (minutes to hours).
2. **API Keys → Create API key** → permission **Sending access** → copy it (this is the SMTP
   password; you paste it in Supabase, not in Vercel).

**Supabase** → your project → **Authentication → Emails → SMTP Settings** → turn on **custom SMTP**:

| Field | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the Resend API key from above |
| Sender email | e.g. `no-reply@yourdomain.com` |
| Sender name | your product name |

Then **Authentication → Rate Limits** → emails per hour → `100`.

---

## 7. Vercel: the website (15 minutes)

vercel.com → sign in with GitHub. Use the **Pro plan** before you charge anyone (Hobby is for
non-commercial use).

1. **Add New → Project** → import **`gamertristian20122-ctrl/App-`** (allow access if asked).
   (Already made a test project from TEST-ON-PHONE.md? Use it: **Settings → Environment
   Variables** → delete every old variable, then paste the block below.)
2. **Root Directory**: `apps/web`. Leave the build settings as they are.
3. **Environment Variables**: paste the whole block below into the first **Key** field (Vercel
   splits it into separate variables). Fill in every value from your note. Mark the keys and
   secrets **Sensitive**.

```
APP_ENV=production
DATABASE_URL=
RUN_MIGRATIONS=1
MIGRATION_DATABASE_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SESSION_SECRET=
TOKEN_ENCRYPTION_KEYS=
CRON_SECRET=
OWNER_EMAIL=
SUPPORT_EMAIL=
LEGAL_ENTITY_NAME=
LEGAL_JURISDICTION=
LEGAL_EFFECTIVE_DATE=
POSTING_PROVIDER=upload_post
UPLOAD_POST_API_KEY=
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
TRANSCRIPTION_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=
STRIPE_SECRET_KEY=
```

What the new ones mean:

| Variable | Put |
| --- | --- |
| `OWNER_EMAIL` | the email **you** sign in with. Only this account can open `/setup`. |
| `SUPPORT_EMAIL` | the address customers write to (shown on `/contact`, `/privacy`, `/terms`) |
| `LEGAL_ENTITY_NAME` | your name or your company's name |
| `LEGAL_JURISDICTION` | whose law applies, e.g. `the State of Delaware, United States` |
| `LEGAL_EFFECTIVE_DATE` | today, written `YYYY-MM-DD` |
| `RUN_MIGRATIONS=1` | every deploy creates or updates the database tables (using `MIGRATION_DATABASE_URL`) |

Not needed: `APP_URL` (the app uses your Vercel address automatically; set it only when you add
your own domain), `STRIPE_WEBHOOK_SECRET` (step 9 creates the webhook and stores its secret
encrypted), `DEV_AUTH` (never in production).

4. **Deploy** → wait 3–5 minutes → copy your address (`YOUR-SITE`, e.g. `clipcast-abc.vercel.app`).
5. **Settings → Build and Deployment → Node.js Version**: `22.x`.
6. Supabase → **Authentication → URL Configuration**:
   - **Site URL**: `https://YOUR-SITE`
   - **Redirect URLs**: add `https://YOUR-SITE/**`

Any time you change a variable: **Deployments → ⋯ (latest) → Redeploy**. Variables only apply to
new deployments.

**Your own domain (optional, best before customers):** Vercel → **Settings → Domains** → add it →
create the DNS record Vercel shows at your registrar. Then add `APP_URL=https://yourdomain.com`
(no slash at the end) in Vercel, update the Supabase URL Configuration, the Railway `APP_URL`, and
redeploy. On `/setup`, tap **Fix storage CORS** and **Create webhook endpoint** again. AI apps
connected to the old address must be reconnected.

---

## 8. Railway: the two workers (15 minutes)

railway.com → sign in with GitHub → add a payment method (Hobby to start).

The workers publish posts, check results, and process videos. Both run the same code from the
repo; they differ only in `WORKER_TYPES`.

**Worker 1: posting**

1. **New Project → Deploy from GitHub repo** → **`gamertristian20122-ctrl/App-`**.
2. Tap the new service → **Settings**:
   - Name: `worker-posting`
   - **Root Directory**: leave empty
   - **Config-as-code / Railway config file**: `apps/worker/railway.toml`
3. **Variables → Raw Editor** → paste this block, fill in the values (the same as in Vercel), and
   add the last three lines:

```
APP_ENV=production
APP_URL=https://YOUR-SITE
DATABASE_URL=
SESSION_SECRET=
TOKEN_ENCRYPTION_KEYS=
POSTING_PROVIDER=upload_post
UPLOAD_POST_API_KEY=
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
TRANSCRIPTION_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=
PORT=8080
```

```
WORKER_TYPES=posting
WORKER_CONCURRENCY=4
```

   Use the **Session pooler** string (port 5432, the one you called `MIGRATION_DATABASE_URL`) as
   `DATABASE_URL` here: Railway can't use the transaction pooler.

4. **Deployments → ⋯ → Redeploy** (the very first build starts before the settings exist and may
   fail; that is expected).

**Worker 2: media** (videos, clips, renders)

1. In the same project: **New → GitHub Repo** → the same repository.
2. Settings: name `worker-media`, Root Directory empty, config file `apps/worker/railway.toml`.
3. Variables → Raw Editor → the same block as above, plus:

```
WORKER_TYPES=media
WORKER_CONCURRENCY=1
```

4. **Settings → Resources**: at least **2 vCPU and 4 GB RAM**. Redeploy.

The first build takes several minutes. When a worker runs, `/setup` shows "last seen … seconds ago".

---

## 9. `/setup`: tap through the checklist (10 minutes)

1. Open `https://YOUR-SITE/login`, sign in with your `OWNER_EMAIL` (open the email link in the
   same browser).
2. Open the **Menu** → **Setup** (or go to `https://YOUR-SITE/setup`).
3. The page checks everything and shows **OK**, **Needs attention** or **Not set**, each with how
   to fix it. Secret values are never shown. Tap these buttons, top to bottom:
   - **Fix storage CORS** (lets browsers upload to R2). If it says your token isn't allowed: tap
     **Copy CORS policy**, then Cloudflare → R2 → your bucket → **Settings → CORS policy → Edit** →
     paste → **Save**.
   - **Create missing products and prices** (Starter $8, Plus $15, Pro $25, extra brand $3, extra
     clipping hour $1; monthly, USD).
   - **Create webhook endpoint** (Stripe → your site; the signing secret is stored encrypted).
   - **Set up billing portal** (customers cancel at the end of the paid period, update their card,
     switch plans).
4. **Upload-Post webhook** (the card shows the URL to copy):
   1. Upload-Post dashboard → webhooks / notifications → copy (or create) the signing secret.
   2. Vercel → `UPLOAD_POST_WEBHOOK_SECRET=` that secret → **Redeploy**.
   3. Back in Upload-Post: webhook URL `https://YOUR-SITE/api/webhooks/upload-post`, events
      `upload_completed`, `social_account_connected`, `social_account_disconnected`,
      `social_account_reauth_required` → turn it on. (Order matters: the secret first, or the
      webhook gets paused after 5 failures.)
5. Tap **Check again**. Fix anything still marked **Needs attention** (the card says where to tap),
   redeploy if you changed a variable, check again.

Things `/setup` can't check, so do them by hand: Supabase custom SMTP (step 6), Stripe
activation, and having a lawyer read `/privacy` and `/terms`.

---

## 10. Try it (15 minutes)

- Sign up with a second email: the sign-in email arrives (via Resend), the trial starts.
- **Brands** → create one → **Accounts** → connect a test social account (LinkedIn or X are
  quickest).
- Connect Claude: the **Connect your AI** card on `/setup` has the MCP URL with a copy button and
  the steps (Claude: **Settings → Connectors → Add custom connector**).
- Ask Claude to write a post, approve it on the card, schedule it a few minutes ahead: it publishes
  (real post!) and the calendar shows it as Published.
- **Billing** → choose Starter → pay with the test card `4242 4242 4242 4242` (any future date,
  any CVC) → it shows Starter, active. **Manage billing** opens the Stripe portal.

The full checklist (also from ChatGPT) is in [DEPLOY.md](DEPLOY.md), steps 10 to 12.

---

## 11. Stripe live mode (10 minutes, after activation)

When Stripe says your account is activated:

1. Stripe → switch **Test mode off** → **Developers → API keys** → live **Secret key**
   (`sk_live_…`) → copy.
2. Vercel → `STRIPE_SECRET_KEY` → paste the live key → **Redeploy**.
3. `/setup` → the Stripe key card says **Live mode** → tap the three Stripe buttons again:
   **Create missing products and prices**, **Create webhook endpoint**, **Set up billing portal**.
   Test and live mode are separate in Stripe, so this creates the live versions; the test ones
   stay untouched.
4. Delete your test customers: archive their brands, then Supabase → **Authentication → Users** →
   delete them.

You are live. Watch Vercel → **Logs** and Railway → each service's logs for the first days, and
keep [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md) at hand (taxes, refunds, decisions).

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `/setup` shows "This page could not be found" | You are not signed in as `OWNER_EMAIL`. Sign in with that email (check the spelling in Vercel). |
| `/setup` says "Setup is locked" | Add `OWNER_EMAIL` in Vercel and redeploy. |
| Vercel build fails with "migration failed" | `MIGRATION_DATABASE_URL` is wrong: password, Session pooler string, `?sslmode=require`. |
| Vercel build or a page says "Invalid configuration" | The message names the variable that is missing or misspelled. Fix it, redeploy. |
| A Railway worker keeps restarting | Open its **Deployments → logs**: "Invalid configuration: X" names the variable. |
| "Create webhook endpoint" says https is needed | You're on a preview address; open your production address (`YOUR-SITE`). |

Send Claude a screenshot of any error or of `/setup`, and it can tell you what to change.
