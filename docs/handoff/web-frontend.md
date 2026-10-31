# Web frontend handoff: marketing, login and the dashboard (`apps/web`)

Owner: web-frontend agent. Paths: `app/layout.tsx`, `app/page.tsx`, `app/globals.css`,
`app/login/**`, `app/app/**`, `components/**`, `lib/ui/**`, `public/**`, `test/ui/**`.
(`app/(marketing)/**` is reserved but unused: the landing page is `app/page.tsx`.) Requests for
other owners are at the end.

Product name: `PRODUCT_NAME = 'Clipcast'` in `lib/ui/brand.ts` (also `PRODUCT_SLUG`, used as the
Cursor `mcp.json` key). Rename it there.

## Pages

| Route | What |
| --- | --- |
| `/` | Landing: hero, “works with Claude / ChatGPT / Cursor”, features (MCP, clips, voice, weekly review, approvals, 9 platforms), how it works, platform list, pricing table generated from `@app/core/plans` (plans, add-ons, trial), FAQ (`<details>`), CTA → `/login`. Static, no external assets. |
| `/login` | Magic link form → `POST /api/auth/magic-link`; with `DEV_AUTH=1` an email-only form → `POST /api/auth/dev-login`. Honors `?next=` (same-site only), `?sent=1`, `?error=link_invalid|link_expired|not_configured|unavailable`. Signed-in users are redirected to `next`. |
| `/app` layout | Header (email, sign-out form → `POST /api/auth/logout`), brand switcher (cookie `ui_brand`, server action, verified against the user's brands), nav with the approval count, trial / billing banner, toast region. Signed out: renders the page, which redirects to `/login?next=<its own path + query>` (keeps `?draft=` deep links). |
| `/app` | Usage meters (clip hours used/limit from `usage.balance`, active brands / limit), setup checklist, drafts awaiting approval, posts in the next 14 days. |
| `/app/approvals` | Queue (`?tab=pending|approved|rejected`, `?brand=`, `?cursor=`, page size 10). `?draft=<id>` puts that draft first, outlined, scrolled into view (not found / another user's → notice). Per platform: account, title, text, length vs limit in the platform's unit, media (presigned GET), errors / warnings. Approve (disabled until ready) / Edit text+title (live counter with core `measureText`) / Reject (optional reason). Approved tab: schedule (datetime in the browser's zone; platforms optional), posts with cancel, withdraw approval. Rejected tab: back to queue, archive. |
| `/app/calendar` | Week or month (`?view=`, `?date=YYYY-MM-DD`, `?brand=<id>|all`, `?canceled=1`), grouped by day in the brand's time zone (the account's for “all”), reschedule / cancel. |
| `/app/brands` | Limit meter, create (disabled at the limit), rename / time zone, archive (copy says accounts are disconnected and must be reconnected on restore), restore. |
| `/app/accounts` | Nine platform slots for the selected brand (`?brand=` overrides): Connect / Reconnect (→ `accounts.connectLink` with `redirectUrl = APP_URL/app/accounts?brand=…&connected=<platform>` → browser redirected to the hosted page), Refresh (`accounts.sync`), Disconnect. Returning with `?connected=` runs `accounts.sync` and shows the result. |
| `/app/media` | Upload (purpose: clip source / post media, optional brand, “I own this content” checkbox required for clip sources, progress bar), cloud-drive link form (live `checkSourceUrl` check, allowed hosts from `DRIVE_HOSTS`, the YouTube refusal message), list with status, duration, size, delete. |
| `/app/clips` | Clip sources → transcript (segments, search `?q=`), “make a clip” form (start/end/title/caption style → `clips.requestClips`), clips with status and draft links. |
| `/app/voice` | Structured form (tone, audience, vocabulary/do/don't one per line, emoji/hashtag policy, sample posts separated by `---`, optional `[platform]` tag) and a raw JSON editor; both save a new version via `voice.save`. Versions and imported-post counts. |
| `/app/analytics` | `analytics.weeklyReview` per brand (selected, or `?brand=all`): totals with % change vs the previous 7 days, per platform, followers, top posts. |
| `/app/billing` | Plan, status, price, trial end, period, add-ons, usage meters. No subscription → plan picker posting to `/api/stripe/checkout` (`plan`, `extraBrands`, `extraClipHours`, live total from `monthlyPriceCents`). Subscription → `/api/stripe/portal`. `?checkout=success|canceled|has_subscription` notices (fixed text, nothing reflected). |
| `/app/connect` | The MCP URL (`config.MCP_RESOURCE_URL`, default `APP_URL/api/mcp`) with copy buttons; steps for Claude (custom connector), ChatGPT (developer mode connector) and Cursor (`mcp.json` snippet); example prompts; connected AI apps (`oauth.listConnections`) with Disconnect (`oauth.revokeConnection`). |

## How it is built

- **`lib/ui/runtime.ts`**: the seam. `getUiRuntime()` = `{ services, appUrl, mcpUrl, now, log }` from `getServicesRuntime()` (`lib/services.ts`); `currentUser()` / `requireSignedIn(path)` wrap `getCurrentUser()` (`lib/auth.ts`). `setUiOverridesForTests({ runtime, user })` for tests.
- **`lib/ui/data.ts`**: one loader per page (`loadShell`, `loadOverview`, `loadApprovals`, `loadCalendar`, `loadBrands`, `loadAccounts`, `loadMedia`, `loadClips`, `loadVoice`, `loadAnalytics`, `loadBilling`, `loadConnections`, plus `pickBrand`, `billingBanner`). Pages are thin: `pageContext(path)` → loader → synchronous view component.
- **`lib/ui/actions/{drafts,settings}.ts`**: the logic of every server action: read the form (`lib/ui/form.ts`: ids/platforms/time zones through the core zod schemas, everything else passed raw to services, which validate with the core schemas), call one service function, return `{ ok, message, issues? }`. `app/app/actions.ts` (`'use server'`) wraps each in `runAction` (`lib/ui/server.ts`: session check, unexpected errors → generic message, logged by name only, `revalidatePath('/app', 'layout')`).
- **Approvals**: `loadApprovals` calls `approvals.issueNonce(user, draftId, { via: 'web' })` for every decidable draft it renders and puts the card nonce in hidden form fields; Approve / Reject call `approvals.decide(user, { draftId, nonce, decision, reason? }, { via: 'web' })`, Edit calls `approvals.editVariant(..., { via: 'web' })`. No approval path exists without that nonce. Scheduling: `posts.schedule(..., { via: 'web' })`; times come from `<input type="datetime-local">` plus a hidden `tz` (the brand's zone in the server render, the browser's after hydration), converted with `lib/ui/time.ts` (Intl only).
- **Uploads** (`lib/ui/upload.ts`, `components/app/media-uploader.tsx`): `POST /api/uploads` → PUT (XHR, progress; multipart parts with ETags) → `POST /api/uploads/<id>/complete`. Accepts the route's real response `{ media, upload }` and the older `{ mediaId, uploadUrl, headers }` contract.
- **Components**: `components/ui` (styles, primitives: Card, Badge/StatusPill, Notice, EmptyState, Meter (`<meter>` + bar), Stat, TabLinks; ActionForm/SubmitButton (`useActionState`, `useFormStatus`), Toaster, CopyButton, Logo), `components/platform` (PlatformMark/Badge monograms, per-platform PreviewCard + LengthMeter), `components/marketing`, `components/app/*` (one view per page + client fields).
- No external fonts, CDNs or images; system font stack; dark mode via `prefers-color-scheme`; skip link; reduced-motion respected.

## Tests (`pnpm -F @app/web test`)

`test/ui`: 5 files, 62 tests (web total 14 files / 154 tests). PGlite-backed services from
`createServicesFromEnv` (fake provider, memory storage, manual clock at 2026-11-02T15:00Z) via
`test/ui/harness.ts`; components rendered with `react-dom/server`. Covered: pricing table equals
`PLANS`/`ADD_ONS`/`TRIAL` ($8/$15/$25, brands, hours, storage, $3/$1 add-ons), landing (9 platforms,
FAQ, AI apps, no external URLs), login variants; approvals queue (web nonce verifies for `web`,
deep link focus / missing / other user, previews with `used / max` per platform, media presigned
URL, hidden nonce, Approve disabled with problems); approve once, refused without / with wrong /
foreign / reused nonce, not-ready refusal with issues, edit (revision 2, old nonce dead), over-limit
edit refused, reject with reason / reopen / archive, schedule in a time zone, reschedule, past time
refused, cancel; brands within/over the limit, rename, restore needs a slot, cross-user refusals;
connect link + redirect target, sync, disconnect; drive links (YouTube and other hosts refused with
core's messages, rights required, link never echoed), thumbnails; clips (transcript search, range
refused past the end, queued clip); voice form → profile, JSON save + validation, versions; AI
connection revoke refusal; shell (approval count, trial banner), every billing banner; `runAction`
(signed out, error mapping without leaking, revalidation, redirects pass through); format, time
(DST, ranges), safe paths and external URLs, form readers, upload flow (both contracts, multipart,
errors) with mocked fetch/PUT.

Also checked by hand (not in the suite): `next build` passes with every page; a headless-browser
run (`next dev`, PGlite, `DEV_AUTH=1`) of sign-in with a `?draft=` deep link, create brand, connect
(fake provider round trip), voice save, drive link, billing total, edit → approve → schedule (2
posts) → cancel from the calendar → reject, mobile nav. No console errors other than Playwright's
own screenshot style.

## Decisions

1. **Toasts are raised when an action resolves** (client wrapper inside `ActionForm`), not from an
   effect: a successful approve/reject re-renders the page without that form, and the message would
   be lost. Consequence: dashboard forms need JavaScript (plain links, GET search, login, logout and
   Stripe forms do not).
2. **Service errors are recognised structurally** (`lib/ui/errors.ts`: `name === 'AppError'` + a
   known code), not with core's `isAppError` (`instanceof`). Observed in `next dev`: the services
   instance cached on `globalThis` was built by a route handler bundle, so its `AppError` class is
   not the page bundle's and `instanceof` is false (a missing draft became a 500). See requests.
3. The approval queue issues nonces at render time for at most 10 drafts per page (each issue writes
   two nonce rows and an audit row).
4. The calendar groups by `scheduledFor` in the brand's zone; posts list times show the zone name.
5. The brand selection is a preference cookie (`ui_brand`, httpOnly, 1 year); every read is checked
   against the user's brands.
6. Accounts are synced on GET only when returning from the connect page (`?connected=<platform>`).
7. Provider permalinks are rendered as links only when they are http(s).

## Requests

1. **Core (`packages/core/src/errors.ts`)**: make `isAppError` work across bundles, e.g. brand
   instances with `Symbol.for('app.AppError')` and check that (or `name` + `code`). Today
   `toErrorBody` and every `isAppError` caller outside services can misclassify a normal service
   error as a crash when the cached services instance came from another Next.js bundle.
2. **Web backend (`lib/server/**`)**: same issue in `lib/server/approve.ts` (`decideApproval`
   rethrows a refused approval) and `lib/server/http.ts` (`errorResponse` → 500 `internal`). Use a
   structural check (like `lib/ui/errors.ts`) until core changes. Optional: give `/approve/[nonce]`
   and `/oauth/authorize` `<main id="main">` so the root layout's skip link works there.
3. **Root**: add `zod` to `apps/web` dependencies (also asked by web-backend); `lib/ui/form.ts` uses
   the core schemas meanwhile.
4. **Ops**: R2 bucket CORS must allow `PUT` from `APP_URL` with `Content-Type`, and expose `ETag`
   (multipart uploads over 5 GB read it).
5. **Product / web backend**: `/app/connect` documents Cursor, but `/oauth/register` refuses
   `cursor://` redirect URIs until `ALLOW_APP_SCHEME_REDIRECTS` is enabled (web-backend decision 1).
6. **Services (optional)**: `drafts.counts(userId)` for tab counts; a way to reuse an unexpired web
   card nonce (or skip the audit row) so rendering the queue does not write per view;
   `media.listSources` for the clips page.

## Gaps

- Not exercised against live Supabase, Stripe, Upload-Post or R2 (magic link, Checkout/Portal
  redirects, hosted connect page and real presigned uploads are untested end to end).
- Connector steps for Claude / ChatGPT / Cursor are written from current product menus without a
  deployed URL to try them.
- No pagination on the calendar beyond one month; the media list pages by 30.
