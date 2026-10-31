# Plan 02: Auto-post (an AI makes a video, Clipcast posts it)

Approved by the owner. An AI that finishes a video sends it to Clipcast; Clipcast posts it to the
brand's platforms **only when the person turned on the brand's Auto-post switch in the web app**.
Otherwise the draft waits for approval (approval card or web queue), exactly as before.

## Data model (`supabase/migrations/0004_auto_post.sql`)

| Change | Purpose |
| --- | --- |
| `actor` + `'auto_post'` | `drafts.approved_via` and `audit_log.actor` when the rule (not a person) approved a draft |
| `media_origin` + `'url_import'` | a finished video/image fetched from an https link (post media, never a clip source) |
| `brands.auto_post_enabled` (default **false**), `auto_post_platforms platform[]` (empty = every connected platform), `auto_post_daily_max` (1–25, default **3**), `auto_post_tiktok_privacy` (the person's choice; TikTok requires one), `auto_post_updated_at` | the switch and its settings |
| `drafts.auto_post_when / _requested_at / _decided_at / _outcome / _note` | what the AI asked for and what the rule decided (once per draft) |
| `posts.approved_via` | copied from the draft at insert (trigger), immutable: the "Auto-posted" badge |
| trigger `drafts_auto_post_guard` | the database refuses an `auto_post` approval unless the brand's switch is on, the brand is active and an AI/worker made the draft |
| `media_assets` host/link checks | `url_import` keeps its host (and its link until fetched, then nulled) |

The migrator runs each file in one transaction and a new enum value cannot be used in the
transaction that adds it, so 0004 never names `auto_post` / `url_import` as enum literals
(constraints list the older values, the trigger condition compares `::text`). The posts-insert
trigger from 0001 is unchanged: the rule approves through services, so a post still needs a draft
approved at its current revision.

## The rule (`packages/services/src/autopost.ts`, one function for every path)

A draft an AI or the worker just made is approved with `via: 'auto_post'` and scheduled when:

1. the brand's switch is on (only `brands.setAutoPost(..., { via: 'web' })` changes it; MCP and
   workers get `forbidden`);
2. every platform of the draft is on the brand's list (or the list is empty);
3. fewer than `auto_post_daily_max` drafts of the brand were approved by the rule in the last 24 h;
4. the draft passes the same checks as a human approval (publish-strict validation, media ready,
   accounts connected, X link rule, plan not on hold; TikTok uses the privacy chosen in the form);
5. each post fits its platform's rolling 24 h cap at its time, checked exactly like `schedule_post`.

Times: `now` = the start of the next minute; an ISO time as given (if it passed while the video was
processing: the next minute); `best` = the first default slot of the platform in the brand's time
zone, at least 5 minutes ahead and under the cap, within 7 days (`BEST_TIME_SLOTS` in
`packages/core/src/autopost.ts`: TikTok 12:00/19:00, YouTube 15:00, Instagram 11:00/19:00,
Facebook 13:00, Threads 12:00, X 09:00/17:00, LinkedIn 08:00/12:00, Pinterest 20:00, Bluesky
10:00/18:00). Otherwise the draft waits and the reason is returned and stored (`switch_off`,
`platform_not_allowed`, `daily_max`, `not_ready`, `cap_reached`, `skipped`). The rule decides once;
while the video is still processing it waits, and `media.markIngested` decides it in the same
transaction that marks the file ready.

## MCP tools (`packages/mcp/src/tools/publish.ts`)

- `upload_media` (not read-only, not destructive, open world): `{ mediaId, uploadUrl, headers,
  expiresAt, curl }` for coding AIs (single presigned PUT ≤ 5 GB; checked with `storage.head` on
  first use), or `sourceUrl` → `media.importFromUrl` (https, public hosts only, video sites refused).
- `render_code_video` (open world): self-contained HTML ≤ 300 KB, 1–60 s, 24/30 fps, 9:16 / 1:1 /
  16:9, optional audio, title, caption, `autoPublish`. Gated like `render_video` (there is no
  render-seconds meter yet; plan status gate) plus at most 3 queued/running per user.
- `publish_video` (destructive, open world): `{ brandId, mediaId, caption | overrides, platforms?,
  when? }` → draft → rule. Auto-posted: the scheduled posts. Otherwise the approval card exactly like
  `approve_draft` (nonce only in `_meta`), the web link and the reason.
- `make_clips`, `render_video`, `render_carousel` accept the same `autoPublish`; the worker applies
  the rule to the draft it makes. `list_accounts` shows the switch read-only.

## Worker (`apps/worker/src/media`)

- `code_video_render` (`code-video.ts`): playwright-core Chromium with JavaScript on, every request
  but data:/blob: aborted (plus a CSP, closed WebSockets, blocked service workers, no DNS),
  viewport from the aspect, deterministic frames (`window.seek(ms)`, else paused document
  animations + Playwright's clock for timers/rAF/Date), JPEG frames piped to ffmpeg (image2pipe →
  H.264 yuv420p + AAC, faststart), hard timeouts, crash handling, temp cleanup.
- `url_import` (`url-import.ts`): the drive downloader (`downloadToFile`: every hop re-checked, size
  cap, timeouts) with the import link policy and an HTTP client that only dials public IPs
  (`safe-fetch.ts`); video/image content types only; probe; `markIngested` (no clipping time).
- `clip_render` / `video_render` / `carousel_render`: `applyAutoPublish` after the draft is made.

## Web app

Brands page: an Auto-post section per brand (switch, platforms, daily max, TikTok privacy, and the
warning "When this is on, videos your AI sends are posted without asking you. Platform limits still
apply."); server action `autoPostAction` → `setAutoPost(..., { via: 'web' })`. Calendar and
approvals: an "Auto-posted" badge (`posts.approved_via` / `drafts.approved_via`) and, for waiting
drafts, why the rule did not post them. Connect page: the Claude Code command and the pipeline.

## Tests

db `auto-post.test.ts` (migration, defaults off, guard trigger, `posts.approved_via`, URL-import
constraints); core `autopost.test.ts` (slots, time zones, import links, public IPs, schemas);
services `auto-post.test.ts` (switch web-only, off/on, platform list, daily max, caps, X links,
TikTok privacy, waiting for media, cross-tenant, AI uploads, URL imports); mcp `publish.test.ts`
(annotations, curl/presign, nonce only in `_meta`, errors); worker `auto-post.test.ts` (code video
with `window.seek`, a CSS animation and a blocked `fetch`, URL imports, the public-IP client,
autoPublish after renders and clips); web `auto-post.test.tsx` (owner-only action, badges, Connect
page); e2e step "auto-post".
