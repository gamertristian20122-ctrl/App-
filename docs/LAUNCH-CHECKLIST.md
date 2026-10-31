# Launch checklist

Everything that still needs a person before (or soon after) the first paying customer, and every
product decision the build made on your behalf. The code is done and tested with fakes; what's left
is accounts, keys, legal text, money settings and your decisions. Deploy steps themselves are in
[DEPLOY.md](DEPLOY.md).

## 1. Accounts, plans and keys

- [ ] **Domain** bought and pointed at Vercel (DEPLOY step 1 and 7.3).
- [ ] **Supabase** project. Use the **Pro plan** for production: free projects are paused after a
      week without activity and have no daily backups.
- [ ] **Email sending** (Resend, Postmark, SES...) set up as Supabase's custom SMTP, with the
      sending domain verified (SPF and DKIM records), so sign-in emails don't land in spam.
- [ ] **Cloudflare R2** bucket, CORS policy and bucket-scoped API token.
- [ ] **Upload-Post** paid plan chosen and API key created. Professional ($50/mo, 25 brands,
      white-label) is the recommended launch plan; Basic ($24/mo, 5 brands, Upload-Post branding on
      the connect page) is enough for a private beta. Prices from research; check current ones.
- [ ] **Stripe** account **activated** for live payments (business details, bank account,
      identity check), products and prices created in live mode with the lookup keys, customer
      portal configured, live webhook added.
- [ ] **AssemblyAI** account with billing, API key.
- [ ] **Whisper** service on Railway (or decide to start with AssemblyAI only; DEPLOY step 6).
- [ ] **Vercel Pro** (Hobby is for non-commercial use only) and **Railway** with a payment method.
- [ ] Secrets generated with `pnpm secrets` and stored in a password manager. Keep
      `TOKEN_ENCRYPTION_KEYS` safe: losing it makes stored secrets unreadable.
- [ ] A support email address (for the site footer, Stripe, the connector listings and the
      privacy policy).
- [ ] Billing alerts or spending limits set on Vercel, Railway, Cloudflare and AssemblyAI.

## 2. Legal pages and policies

None of these pages exist in the app yet. They are short pages to add under `apps/web/app/`
(for example `privacy/page.tsx` and `terms/page.tsx`) with links in the landing page footer. Have
a lawyer or a reputable template service write the text.

- [ ] **Privacy policy** at `https://YOURDOMAIN/privacy`. Needed by Stripe, by Anthropic's and
      OpenAI's connector/app directories, and by privacy law. It should cover: what you store
      (email, brands, connected social account names, drafts and posts, uploaded videos and
      images, transcripts, analytics, billing status), how long (source videos are deleted 30 days
      after upload; the rest until the account is deleted), and your sub-processors: Supabase,
      Vercel, Railway, Cloudflare, Upload-Post, Stripe, AssemblyAI, your email provider.
- [ ] **Terms of service** at `https://YOURDOMAIN/terms`, including the **own-content rule** (users
      may only clip videos they own or have rights to; the upload form makes them confirm it),
      acceptable use, and that users are responsible for what they approve and publish.
- [ ] **Refund and cancellation policy** (Stripe asks for one): cancellation takes effect at the end
      of the paid period; refunds at your discretion.
- [ ] **Copyright / takedown contact** (for complaints about uploaded content).
- [ ] **Contact page or email** visible on the site (Stripe requires it).
- [ ] **Account deletion**: there is no self-serve "delete my account" button. Until there is, handle
      requests by email: archive the user's brands on their behalf (frees the Upload-Post profiles),
      then delete the user in Supabase → Authentication → Users (their app data is deleted with
      them). Say so in the privacy policy.
- [ ] Put the terms and privacy links into Stripe (Settings → Public details) and the customer
      portal.

## 3. Platform and directory reviews

- **Social platform app reviews: none needed for v1.** Upload-Post owns the platform apps (TikTok,
  Meta, YouTube, LinkedIn, X, Pinterest) and their reviews; we never hold platform tokens.
  - [ ] Ask Upload-Post to confirm that their TikTok app can publish **public** posts (TikTok
        limits unaudited apps to private posts) and that white-label profiles don't change that.
  - Direct platform adapters (later) would each need their own app review.
- **Claude connector directory (optional, for discovery).** Users can add the server as a custom
  connector without any listing. To be listed: submit through Anthropic's connector directory
  form. Already done in code: OAuth, a `title` and `readOnlyHint`/`destructiveHint` on every tool.
  You provide: privacy policy, support contact, a short description, a test account with sample
  data, and screenshots (`docs/screenshots` has a set from the local run).
  - [ ] Submitted / decided to wait.
- **ChatGPT apps directory (optional).** Developer-mode connectors need no review. A public listing
  needs OpenAI's app submission (verified organization, privacy policy, test account, tool
  descriptions; the approval card already supports ChatGPT).
  - [ ] Submitted / decided to wait.

## 4. Money settings

- [ ] **Sales tax / VAT.** Stripe Tax is **not** turned on: Checkout is created without automatic
      tax. Selling software to consumers can create tax obligations (for example EU VAT applies
      from the first sale to an EU consumer, and US states have their own thresholds). Decide with
      an accountant. To collect tax with Stripe: register where required, enable Stripe Tax, set
      each price's tax behavior, and add `automatic_tax: { enabled: true }` (plus billing address
      collection) to `createCheckoutSession` in `apps/web/lib/server/stripe.ts`.
- [ ] **Failed payments**: Stripe → Settings → Billing → Revenue recovery: turn on Smart Retries
      and the failed-payment emails. While a payment is failing (`past_due`), approved posts keep
      publishing but new clipping and rendering are blocked; when Stripe gives up (`unpaid` or
      `canceled`), everything is held (nothing deleted).
- [ ] **Receipts**: Stripe → Settings → Customer emails: successful payments on.
- [ ] **Promotion codes** are allowed in Checkout (create coupons in Stripe if you want launch
      discounts).
- [ ] **Add-on changes for existing subscribers.** Stripe's portal can't change a subscription that
      holds more than one product, so a customer with an extra brand or extra hours can't switch
      plans or change add-on quantities themselves (they can still cancel and update their card).
      Until an in-app "change plan" page exists, make those changes for them in the Stripe
      dashboard (the app follows the subscription through webhooks).
- [ ] **Upload-Post profile slots for canceled customers.** Brands of canceled customers keep their
      Upload-Post profile (nothing is deleted). Every profile uses a paid slot; review canceled
      accounts monthly and archive their brands (or decide on an automatic clean-up).

## 5. Before inviting users

- [ ] All of DEPLOY step 10 (smoke test) ticked.
- [ ] DEPLOY step 12 (each build step from Claude **and** ChatGPT) ticked.
- [ ] Switched Stripe to live mode (DEPLOY "Going live with Stripe") and removed test accounts.
- [ ] Product name: still **Clipcast** (working name), set in `apps/web/lib/ui/brand.ts`. Check the
      name is free to use, then change it there if needed (also the Upload-Post connect-page
      branding and the Stripe business name).
- [ ] Uptime check (any free monitor) on `https://YOURDOMAIN/` and
      `https://YOURDOMAIN/.well-known/oauth-protected-resource`, and Railway notifications for
      crashed deploys. There is no error-alerting service wired in; watch the Vercel and Railway
      logs for the first weeks (especially Upload-Post `provider_auth` errors, which mean the
      API key or plan has a problem).
- [ ] Back up the database: Supabase Pro has daily backups; consider point-in-time recovery once
      there are paying users.

## 6. Check on first real use

These could not be tested without live accounts; watch for them in the first days.

- Upload-Post: our upload request id format is accepted; Facebook Reels title/description look
  right; what the connect page adds to the return URL; Pinterest and Bluesky on the connect page;
  whether PNG/WebP images are converted for Instagram and TikTok (carousels are JPEG already, user
  images in other formats get a warning).
- TikTok: the real post link can arrive up to 24 h after publishing (the worker re-checks at 24 h).
- Cloud-drive links: real Google Drive, Dropbox and OneDrive download redirects (OneDrive shares
  may need sign-in for some accounts).
- Whisper on Railway: speed on CPU for a 1-hour video; caption fonts in the Docker image.
- Railway: the Docker build on Railway (it built and ran locally), the 120-second shutdown grace
  (`drainingSeconds`), disk space for
  10 GB sources.
- Rate limits and webhook de-duplication are per server instance; fine at launch scale.

## 7. Product decisions that were defaulted

Each of these was decided during the build so the code could be finished. Change any of them;
"where" says what to edit. Most live in `packages/core/src/plans.ts`, `packages/core/src/platforms.ts`
and `packages/services/src/config.ts`. A change marked "migration" also needs a new file in
`supabase/migrations`.

### Plans and billing

| Decision | Default chosen | Where to change it |
| --- | --- | --- |
| Trial | 7 days, Starter limits, 1 clipping hour, no card; starts at first sign-in, once per user | `TRIAL` in `packages/core/src/plans.ts`; start in `packages/services/src/users.ts` |
| Storage per plan | 50 / 100 / 200 GB (Starter / Plus / Pro) | `PLANS` in `packages/core/src/plans.ts` |
| Add-on limits | at most 20 extra brands and 200 extra clipping hours | `ADD_ONS[...].maxQuantity` in `packages/core/src/plans.ts` |
| Unused clipping hours | no rollover; period = Stripe billing period (calendar month without a subscription) | `usagePeriod` in `packages/core/src/time.ts` |
| Upgrades / downgrades | both apply immediately with proration (the Stripe portal can only delay a downgrade between prices of one product; ARCHITECTURE wanted downgrades at period end) | Stripe customer-portal settings |
| Too many brands after a downgrade | newest brands are suspended (their posts held, nothing deleted); restored automatically when there is room again | `reconcileLimit` in `packages/services/src/brands.ts` |
| Failed payment (`past_due`) | approved posts still publish; new clipping and rendering blocked | `entitlements()` in `packages/core/src/plans.ts` |
| Canceled / unpaid / trial over | everything held and read-only; nothing deleted; held posts retried every 6 h and published as soon as billing is active again | `entitlements()` in `packages/core/src/plans.ts`; `heldRetryDelayMs` in `packages/services/src/config.ts` |
| Data of canceled customers | kept indefinitely (no automatic deletion; plan suggested 90 days) | would be a new task in `packages/services/src/maintenance.ts` |
| Promotion codes in Checkout | allowed | `allowPromotionCodes` in `packages/services/src/billing.ts` |
| Sales tax | not collected (no Stripe Tax) | section 4 above |
| Price lookup | by Stripe lookup keys `starter`, `plus`, `pro`, `extra_brand`, `extra_clip_hour` | lookup keys in `PLANS`/`ADD_ONS`, or `STRIPE_PRICE_*` env vars |

### Clipping and media

| Decision | Default chosen | Where to change it |
| --- | --- | --- |
| What a clipping hour measures | seconds of **source** video, charged once per source when it is transcribed; more clips from the same video are free; failures refunded | `packages/services/src/media.ts`, `transcripts.ts` |
| Source limits | at most 4 hours and 10 GB per video | `SOURCE_LIMITS` in `packages/core/src/plans.ts` |
| Source retention | source videos deleted from R2 30 days after upload, unless a draft or scheduled post still uses them | `SOURCE_LIMITS.retentionDays` |
| Clip length and count | 3–180 seconds per clip, at most 20 clips per request, 60 active clips per source | `MIN_CLIP_MS`, `MAX_CLIP_MS`, `MAX_CLIP_RANGES` in `packages/core/src/validation.ts`; `maxClipsPerRequest`, `maxActiveClipsPerSource` in `packages/services/src/config.ts` |
| Pending drive links | at most 3 per user waiting to download | `maxPendingDriveLinks` in `packages/services/src/config.ts` |
| Allowed cloud drives | Google Drive, Dropbox, OneDrive (https only); YouTube and every other video site refused | `DRIVE_HOSTS` in `packages/core/src/links.ts` (+ migration: a database check mirrors it) |
| Rights | a "I own this content" checkbox per clip-source video, in the web app only | `apps/web/components/app/media-uploader.tsx`, `packages/services/src/media.ts` |
| Getting media from an AI | `upload_media`: a one-hour presigned PUT (and a ready `curl` command) for coding assistants, at most 5 GB; or an https link we download (public hosts only; YouTube, TikTok, Instagram, X, Facebook, Vimeo, Twitch and other video sites refused); at most 5 links waiting per user. Post media only, never clip sources | `AiUploadInputSchema`, `checkImportUrl` in `packages/core`; `maxPendingUrlImports` in `packages/services/src/config.ts` |
| Code videos (`render_code_video`) | HTML ≤ 300 KB, 1–60 s, 24 or 30 fps, every network request blocked; not metered (there is no render-seconds meter: gated like template renders, blocked when billing is on hold), at most 3 queued or rendering per user | `CODE_VIDEO_LIMITS` in `packages/core/src/validation.ts`; `maxActiveCodeRenders` in `packages/services/src/config.ts`; timeouts in `apps/worker/src/media/code-video.ts` |
| Videos without sound | can't be clipped (transcription fails and is refunded) | `apps/worker/src/media/transcribe.ts` |
| Renders (carousels, template videos) | not metered and no limit on how many run at once (plan suggested 3× clipping time, 3 at once); blocked only when billing is on hold | `packages/services/src/renders.ts` |
| Unfinished clip charges | released automatically after 48 h without a transcript | `ORPHAN_RESERVATION_AFTER_MS` in `packages/services/src/maintenance.ts` |
| Carousel format | JPEG slides (Instagram and TikTok refuse PNG); fonts "rounded" and "condensed" fall back to Noto Sans | `apps/worker/src/media/renderer.ts`; fonts in `apps/worker/Dockerfile` |
| Transcription | self-hosted Whisper first, AssemblyAI fallback; AssemblyAI transcripts deleted after use | `TRANSCRIPTION_PROVIDER` env var |

### Posting and approval

| Decision | Default chosen | Where to change it |
| --- | --- | --- |
| Who approves | only a person: the approval card's buttons or the web app; the AI never sees the one-time approval code | `packages/services/src/approvals.ts`, `packages/mcp` |
| Approving inside the chat card | the card's Approve button approves directly (the plan suggested a web confirmation first; the one-time code is visible only to the card) | `approval_decide` in `packages/mcp` |
| AI apps without the card | they get a link to `/app/approvals?draft=...` | `packages/mcp` |
| Approval link lifetime | 24 hours | `servicesConfigFromAppConfig` in `packages/services/src/config.ts` |
| Editing an approved draft | sends it back to "draft" and cancels its scheduled posts; approve again | database triggers (migration) |
| Rescheduling an approved post | allowed without re-approval (logged) | `reschedule` in `packages/services/src/posts.ts` |
| Canceling a post | if the person cancels, the AI can't schedule that variant again until it is re-approved | `cancel` / `schedule` in `packages/services/src/posts.ts` |
| One approval, one publication | each approved platform version publishes once | database index (migration) |
| TikTok "who can see this" | no default: the person must choose before approving (for Auto-post, once in the brand's Auto-post settings) | `validateVariant` in `packages/core/src/platforms.ts` |
| Auto-post switch | **off** for every brand; only the person turns it on, on the Brands page (MCP clients and workers are refused) | `brands.setAutoPost` in `packages/services/src/brands.ts`; migration 0004 |
| Auto-post daily maximum | **3** drafts per brand in any 24 hours (the person can pick 1–25); above it, drafts wait for approval | `AUTO_POST_DAILY_MAX` in `packages/core/src/autopost.ts`; migration 0004 default |
| Auto-post platforms | all connected platforms unless the person ticks some | Brands page |
| Auto-post times | "now" = the next minute; an ISO time as asked; "best" = TikTok 12:00/19:00, YouTube 15:00, Instagram 11:00/19:00, Facebook 13:00, Threads 12:00, X 09:00/17:00, LinkedIn 08:00/12:00, Pinterest 20:00, Bluesky 10:00/18:00 in the brand's time zone (first free slot at least 5 minutes ahead, within 7 days) | `BEST_TIME_SLOTS` in `packages/core/src/autopost.ts` |
| Publish retries | up to 5 attempts on temporary provider errors, then failed with the provider's message | `recordPublishError` in `packages/services/src/posts.ts` |
| Waiting for a post to go live | status checked for about 24 h, then failed | `STATUS_POLL_BUDGET` in `apps/worker/src/context.ts` |
| One account per platform per brand | yes (Upload-Post allows one per profile) | migration + Upload-Post limit |
| Archiving a brand | deletes its Upload-Post profile right away (frees the paid slot) and disconnects its accounts; restoring needs reconnecting (plan suggested waiting 7 days) | `archive` in `packages/services/src/brands.ts` |

### Platform rules

| Decision | Default chosen | Where to change it |
| --- | --- | --- |
| X posts with links | refused with a clear message ("remove the link, or put it in your profile"): Upload-Post strips links unless you buy its X Links add-on ($19/mo for 50 link posts shared by all customers) | `X_LINK_POSTS_PER_PLAN` in `packages/core/src/plans.ts` (and buy the add-on) |
| Posts per account per 24 h | TikTok 15, YouTube 10, Instagram 50 (Upload-Post's cap, below Instagram's 100), Facebook 25, Threads 50, X 20, LinkedIn 25, Pinterest 20, Bluesky 25: the lower of the platform's and Upload-Post's | `capPer24h` in `PLATFORM_RULES`, `packages/core/src/platforms.ts` |
| Cap full when a post is due | moved 1 hour later | `capRetryDelayMs` in `packages/services/src/config.ts` |
| Analytics schedule | account totals daily; each post at 24 h, 48 h, 7 days and 30 days | `POST_METRIC_CHECKPOINTS_MS` in `packages/core/src/time.ts`; `apps/worker/src/scheduler.ts` |

### Sign-in, AI apps and operations

| Decision | Default chosen | Where to change it |
| --- | --- | --- |
| Product name | Clipcast | `apps/web/lib/ui/brand.ts` |
| Human sign-in | email magic link only (no passwords, no Google) | Supabase Auth + `apps/web/app/login` |
| AI app sign-in | OAuth 2.1 with dynamic registration; one permission scope (`social`); access tokens 1 h, refresh tokens 30 days (rotated on every use) | `OAUTH_*_TTL_SEC` env vars |
| Desktop AI apps | Cursor and VS Code callback links allowed (`cursor:`, `vscode:`, `vscode-insiders:`); other app schemes refused | `APP_REDIRECT_SCHEMES` in `apps/web/lib/server/oauth.ts` |
| Unused AI app registrations | deleted after 7 days | `packages/services/src/maintenance.ts` |
| Rate limits | per server instance: 240 MCP calls/min per user, 30 registrations and 300 token calls/min per IP, 5 sign-in emails/min per IP | `apps/web/lib/server/rate-limit.ts` |
| Background schedule | worker: clean-up hourly, account analytics daily, lost-post sweep every few minutes; Vercel crons daily as a backup (04:23 and 05:41 UTC) | `apps/worker/src/scheduler.ts`, `apps/web/vercel.json` |
| MCP tools | the 14 v1 tools plus `upload_media`, `render_code_video` and `publish_video` (docs/plans/02-auto-post.md); `get_writing_brief`, `list_media` and a merge mode for `save_voice_profile` were proposed in `docs/REVIEW.md` and wait for your approval (their content is reachable through existing tools today) | `packages/mcp` after a plan |
