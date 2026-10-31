# Upload-Post API research for PostingProvider and DB design

**Tags:** **[V]** means I saw it in a cited source on 2026-10-31. **[U]** means it comes from memory or inference, or the docs don't settle it.

I fetched the raw markdown docs, the docs index and the OpenAPI spec. I wrote nothing to the repo; scratch copies are in `/tmp/upr`.

**Main sources:**
- docs.upload-post.com/llms.txt
- /openapi.json
- /guides/authentication
- /resources/pricing-and-limits
- /guides/rate-limits
- /api/user-profiles
- /api/connect-api
- /guides/user-profile-integration
- /api/upload-video, /api/upload-photo, /api/upload-text
- /api/upload-status, /api/upload-history, /api/schedule-posts
- /api/webhooks, /api/get-analytics, /api/instagram-media
- /guides/limit-of-uploads, /guides/x-links-addon, /guides/reached-active-user-cap-error
- www.upload-post.com/pricing

## 1. Auth, pricing and rate limits

- **Auth [V]:** base URL `https://api.upload-post.com`. Every server call sends `Authorization: Apikey <key>`. A profile JWT can be sent as `Authorization: Bearer <jwt>` to the Connect API, validate-jwt and the disconnect call. Ten failed auth attempts in a row block the IP for 5 minutes.
- **We need at least Professional [V]:** white-label profiles start on Professional.

| Plan | Monthly | Profiles | White-label |
|---|---|---|---|
| Free | $0 | 2 | No (10 uploads/mo, no TikTok) |
| Basic | $24 | 5 | No |
| Professional | $50 | 25 | Yes |
| Advanced | $147 | 75 | Yes |
| Business | $438 | 225 | Yes, plus $1/mo per extra profile |

  - Paid plans have unlimited uploads.
  - **Cost per brand [V]:** about $2/brand/mo early on, falling to about $1 at Business scale. That fits all our tiers.
  - **Extra profiles on Professional [V]:** +15 profiles for $35/mo, +25 for $55/mo.
- **Request limits [V]:**
  - Professional allows 100 requests/min and 500 per 10 min, plus 2/min per profile. The hard ceiling is 1,000/min.
  - Every response carries `X-RateLimit-Limit/Remaining/Reset` headers.
  - All our customers share one API key, so we need one global outbound limiter.
- **Daily caps per connected account, rolling 24h [V]:**
  - Instagram 50, TikTok 15 (and 6 per minute), LinkedIn 150, YouTube 30, Facebook 25, Threads 50, Pinterest 20.
  - X depends on our plan: 10 on Basic, 20 on Professional, 30 on Advanced/Business.
  - Bluesky allows 25 videos or 10 GB.
  - Going over returns `429` with a `violations[]` array. Scheduled posts are re-checked when they run.
  - `GET /api/uploadposts/instagram/publishing_limit` returns the remaining Instagram quota.
- **Duplicate check [V]:** Upload-Post also rejects duplicate or very similar content on the same account and network within 48h, and too many mentions.
- **Idempotency [V]:**
  - Send an `Idempotency-Key` header. It is scoped to the account and upload type and lasts 24h.
  - A repeat returns `idempotent_replay`. Two requests arriving at once get `409 IDEMPOTENCY_KEY_IN_USE`.
  - We can also supply our own `request_id`, so we can still poll if the HTTP response is lost.

## 2. User profiles and connecting accounts

- **One profile per brand [V]:** `POST /api/uploadposts/users {username, display_name}`.
  - `username` can't be changed later. It allows letters, numbers, `_`, `@` and `-`, and it is the `user` field on every later call. Use an opaque ID such as `brand_<ulid>`, not an email.
  - Errors: `403 PROFILE_LIMIT_REACHED`, `409` if the name exists.
  - Other calls: `GET /users`, `GET` and `PATCH /users/{username}` (only `display_name` can change), `DELETE /users`, and `DELETE /users/social {profile_username, social_platform}` to disconnect one platform.
- **A profile holds one account per platform [V].** So one brand = one profile = at most one account per platform. A brand with two Instagram accounts would need two profiles.
- **Hosted connect page [V]:** `POST /api/uploadposts/users/generate-jwt` returns `access_url` (`app.upload-post.com/connect?token=…`), valid for 48h.
  - Options: `redirect_url`, `logo_image`, `connect_title`/`connect_description`, `platforms[]`, `show_calendar`, `readonly_calendar`, `language`, `ui_labels`, `connect_theme`.
  - Custom domains aren't supported.
  - **We must send `show_calendar:false`.** It defaults to `true`, and that calendar lets the user create and edit posts, which would get around our approval step.
  - The documented `platforms[]` values leave out pinterest and bluesky **[U: unclear whether they can be filtered]**.
- **Build-your-own connect page (Connect API) [V]:** `POST /api/uploadposts/oauth/{platform}/start`.
  - Call it with the API key and `{profile, redirect_url}`. It returns an `authorize_url` and a single-use state that expires in 15 minutes.
  - The user comes back with `?connect_status=success|cancelled|error&platform=…&error_code=…`.
  - Supported: tiktok, instagram, facebook, linkedin, youtube, x, threads, pinterest, google-business, snapchat. **Bluesky is not supported**, so it needs the hosted page. How the hosted page connects Bluesky isn't documented **[U: probably handle plus app password]**.
  - This fits `connect_account(platform)` well: the tool can return the authorize URL directly.
- **Tokens [V]:** Upload-Post runs the OAuth exchange and stores the tokens; we never see platform OAuth tokens. Our "encrypt tokens" rule therefore covers the Upload-Post API key, the webhook secret and any profile JWTs we cache. We also can't choose the OAuth scopes (Upload-Post's apps set them), so the "fewest scopes" rule is out of our hands.
- **Account rules [V]:**
  - Instagram must be a Business or Creator account.
  - Facebook can post only to Pages, chosen per upload with `facebook_page_id`; Pages are listed by `GET /uploadposts/facebook/pages`.
  - LinkedIn company pages use `target_linkedin_page_id` and are listed by `/linkedin/pages`.
  - Pinterest requires `pinterest_board_id`; boards are listed by `/pinterest/boards`.
  - When an account already linked elsewhere is connected, it moves to the new connection (`account_moved`).
- **Confirming a connection [V]:** read `GET /users/{username}` → `social_accounts.<platform>`, which has:
  - `username`: the platform's stable ID (TikTok `open_id`, Instagram user ID, YouTube channel ID). It doesn't change on reconnect.
  - `handle` and `display_name`.
  - `social_images`: the avatar URL.
  - `reauth_required`.
  - `capabilities[]` (TikTok today, e.g. `music`, `draft`, `video_privacy`, `comments`, `inbox_fallback`). Treat the list as open-ended.

**What we store [V/U]:**
- **Per brand:** `provider` and `provider_profile_ref` (unique, immutable).
- **Per connected account:**
  - `platform` and `provider_account_id` (the `username` above)
  - `handle`, `display_name`, `avatar_url`
  - `capabilities jsonb`
  - `status` (connected / reauth_required / disconnected)
  - `destination jsonb` (Facebook page_id, LinkedIn organization URN, Pinterest board_id and section)
  - `last_synced_at`
  - Unique on `(brand_id, platform)`.

## 3. Publishing endpoints [V]

All publishing calls are multipart.
- `POST /api/upload` handles video.
- `POST /api/upload_photos` handles `photos[]`, as files or public HTTPS URLs. Only Instagram and Threads accept video items in a mixed carousel.
- `POST /api/upload_text` handles text. It works on X, LinkedIn, Facebook, Threads, Bluesky, Discord, Telegram and Google Business. It does **not** work on Instagram, TikTok, YouTube or Pinterest.
- `POST /api/upload_document` posts a PDF/PPT as a native LinkedIn document carousel.

**Fields shared by all upload calls:**
- `user`, `platform[]`, and `video` (a file **or a URL**, so an R2 presigned URL works).
- `title` (required for YouTube) and `description` (LinkedIn, Facebook, YouTube, Pinterest).
- `{platform}_title` overrides per platform.
- `first_comment` and `{platform}_first_comment`. These work on Instagram, Facebook, Threads, Bluesky, X, YouTube, LinkedIn and TikTok. On TikTok this needs the `comments` capability and only produces a warning if missing.
- `scheduled_date` (ISO, at most 365 days ahead) with an optional `timezone`.
- `external_id` (our ID; it comes back in status, history and webhooks).
- `request_id`, `async_upload`, `add_to_queue`.
- `is_ai_generated` (an alias).

**Per-platform fields:**
- **TikTok:**
  - `privacy_level`: the allowed values differ per account; get them from `/tiktok/settings`.
  - `disable_comment`/`disable_duet`/`disable_stitch`.
  - `post_mode` (`DIRECT_POST` or `MEDIA_UPLOAD`, which goes to TikTok's drafts).
  - `cover_timestamp`, `brand_content_toggle`/`brand_organic_toggle`, `is_aigc`, `disable_inbox_fallback`.
  - Caption up to 2,200 characters; video 3–600 s.
- **Instagram:** `media_type` (REELS or STORIES), `share_to_feed`, `share_mode` (trial reels), `collaborators`, `cover_url`, `thumb_offset`, `user_tags`, `location_id`.
- **YouTube:** `tags`, `categoryId`, `privacyStatus` (public/unlisted/private), `selfDeclaredMadeForKids`, `containsSyntheticMedia`, `thumbnail` (not for Shorts), `youtube_playlist_id`, subtitles.
- **Facebook:** `facebook_page_id`, `facebook_media_type` (REELS, STORIES or VIDEO).
- **LinkedIn:** `visibility`, `target_linkedin_page_id`.
- **X:**
  - `x_long_text_as_post`: long text is split into a thread automatically unless this is set.
  - `reply_settings`.
- **Threads:** `threads_topic_tag`, `threads_reply_control`.
- **Pinterest:** `pinterest_board_id` (required), `pinterest_link`.
- **Bluesky:** `bluesky_alt_text`, `bluesky_langs`.
- **Link previews:** `link_url` works for LinkedIn, Facebook and Bluesky text posts.
- **Carousel limits:**
  - Instagram 10 items.
  - X 4 images per tweet; more becomes a thread.
  - Bluesky 4 images, or 20 with `bluesky_gallery`.
  - Pinterest 2–5.
  - Threads 20.

**Responses:**
- A synchronous call returns `200` with `results.{platform}` (success, url, post_id, error).
- An async call returns `200 {request_id}`.
- A scheduled call returns `202 {job_id}`.
- `warnings[]` lists fields that were ignored.
- Platforms the profile has no account for come back as `skipped`.
- Requests longer than 59 s switch to async automatically. **Always send `async_upload=true` from a Railway worker, never from a Vercel function.**

**Scheduling, status and webhooks:**
- **Native scheduling [V]:**
  - `GET /uploadposts/schedule` lists jobs.
  - `GET`, `PATCH` (text, date and fields only; the media can't be replaced) and `DELETE` work on `/schedule/{job_id}`.
  - There is also a slot queue: `add_to_queue` plus `/queue/settings`.
- **Status [V]:** `GET /uploadposts/status?request_id=` or `?job_id=`.
  - Overall status: pending, queued, processing, in_progress, completed, failed (after more than 1h with no activity), not_found.
  - Per platform: queued, processing, completed, failed, retryable, skipped.
  - Poll no faster than every 5 s.
  - Failed posts can be retried with `/posts/retry`.
- **TikTok quirks [V]:**
  - When TikTok's daily user cap is hit, a post silently goes to the account's TikTok inbox: `success:true, fallback_to_inbox:true`, it is **not live**, and the caption is lost. Send `disable_inbox_fallback=true` and reschedule ourselves instead.
  - TikTok's real post ID can arrive up to 24h late, and **no webhook fires** for it, so we need a follow-up poll.
- **Webhooks [V]:**
  - Set the account webhook with `POST /api/uploadposts/users/notifications`, or a per-profile one with `/users/profile-webhook`.
  - Events: `upload_completed` (once per platform; carries request_id, job_id, external_id, profile_username, platform, and result.{success, url, post_id, error}), `social_account_connected`, `social_account_disconnected`, `social_account_reauth_required`. `comment_received` and `dm_received` are opt-in.
  - Signature: `X-Upload-Post-Signature: sha256=HMAC(secret, "<ts>.<rawBody>")` plus `X-Upload-Post-Timestamp`. Reject anything older than 5 minutes.
  - `X-Upload-Post-Delivery` is a unique delivery ID for deduplication.
  - The doc's sample `reauth_required` event has no `profile_username`.
  - How often failed webhooks are retried isn't documented **[U]**.

## 4. Analytics and past posts [V]

- **Profile totals:** `GET /api/analytics/{profile}?platforms=…` returns followers, reach, views/impressions, profileViews, likes, comments, shares and saves.
  - It also returns a 30-day daily `reach_timeseries` (one metric) and `metric_type`, which says which metric that series is so we don't double-count.
  - Instagram also returns follower demographics. YouTube adds watch time. Facebook accepts `days` (1–365) and `page_id`.
  - **LinkedIn covers company pages only.** Bluesky reports engagement only. Discord and Telegram have no analytics.
- **Date ranges:** `GET /uploadposts/total-impressions/{profile}?start_date&end_date|period&breakdown=true&metrics=…` returns per-platform and per-day values from daily snapshots. Facebook snapshots are rolling 30-day totals, so summing them overstates the real figure.
  - Whether snapshots are taken for every profile without us asking **[U]**.
- **Per post:**
  - `GET /uploadposts/post-analytics/{request_id}` returns live metrics per platform, plus profile snapshots at the post date and the latest.
  - `GET /uploadposts/post-analytics?platform_post_id&platform&user` also works for posts made outside Upload-Post.
  - Both are limited to **100 requests per 5 minutes**; it's unclear whether that is per account or per profile **[U]**. Results are cached for 5 minutes. X allows 5,000 posts per day.
  - `GET /post-analytics/cached` returns up to 200 rows per page at no rate-limit cost, but only for posts we already fetched live. Nothing refreshes it in the background.
- **Past posts for `import_past_posts`:** `GET /api/uploadposts/media?platform&user&limit&cursor`.
  - Each item has `id`, `caption`, `media_type`, `media_url`, `permalink`, `timestamp`, `thumbnail_url` and, for carousels, `children`.
  - Covers Instagram, TikTok (20 per page), YouTube (50 per page), Facebook, X, Threads, Pinterest, Bluesky and Reddit.
  - **LinkedIn returns company-page posts only**, with no cursor.
  - Import captions and metadata only, never media, to stay within the "own content / no YouTube download" rule.
  - `GET /uploadposts/history` covers only posts made through Upload-Post.

## 5. What this means for our design

1. **Conflicts with CLAUDE.md:**
   - **Instagram:** Upload-Post caps at 50 posts/24h, below our rule's 100, so the scheduler should enforce min(our cap, provider cap).
   - **X links:** Upload-Post **strips every URL from X posts by default** (captions and first comments). Keeping links needs the X Links add-on: $19/mo for **50 link-posts/mo shared across all our customers**. Paying $0.20 per post as CLAUDE.md assumes isn't possible through Upload-Post. We need a product decision: strip links and warn the user, meter a single shared pool, or build a direct X adapter later.
   - **X posts per day:** X allows 10–30 posts per account per day depending on our plan.
2. **PostingProvider methods (draft):**
   - `ensureProfile` / `deleteProfile`
   - `getConnectLink({platform?, redirectUrl})`, which returns `{url, expiresAt, mode}`
   - `listAccounts` (normalized, including capabilities and destinations)
   - `disconnect`
   - `publish({kind: video|photos|text|document, mediaUrls, targets[{platform, overrides}], scheduledAt?, idempotencyKey, externalId, clientRequestId})`
   - `getStatus`, `cancelScheduled`, `editScheduled`
   - `verifyAndParseWebhook(rawBody, headers)`
   - `getAccountAnalytics`, `getPostAnalytics`, `listPastPosts(cursor)`
   - `getCaps` / `getQuota`
   - A static capabilities table per platform (text support, carousel maximum, first comment, edit and delete support).
3. **Scheduling:** keep scheduling and approval in our own queue and call `publish` immediately at send time. Direct-API adapters added later won't have native scheduling. Expose native scheduling only as an optional capability.
4. **Errors and statuses:** normalize the inconsistent error shapes (`message`, `error` and `error_code` all appear). Our statuses should be: queued, processing, published, failed, retryable, skipped, in_tiktok_inbox, rate_limited, cap_reached, reauth_required, provider_unavailable (Reddit returns 503 today).
5. **Tables:**
   - `post_targets`: `provider_request_id`, `provider_job_id`, `idempotency_key`, `platform_post_id`, `post_url`, `status`, `error_code`, `warnings jsonb`, `fallback_to_inbox`, `contains_link`, `link_stripped`.
   - `webhook_events`: unique `delivery_id`.
   - `analytics_snapshots`: brand, platform, date, metrics jsonb.
   - `post_metrics`: post target, captured_at, metrics jsonb.
   - No platform-token tables.
6. **Operations:** a global token bucket that honors `X-RateLimit-*`; an alert on `PROFILE_LIMIT_REACHED`; delete the profile when a brand is deleted or the customer churns, to free the slot.
7. **Media:** presigned R2 URLs need to live only until Upload-Post fetches them. Scheduled jobs store a copy of the media, as the schedule API returns stored `media_urls` **[V]**.
8. **Tests:** `openapi.json` can drive TypeScript types and mocks (msw or nock). Upload-Post also ships its own npm SDK (`upload-post`) and its own MCP server **[V]**, so our differentiators matter. A thin typed fetch client inside the adapter is easier to mock than the SDK **[U: recommendation]**.
