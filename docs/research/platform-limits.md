# Platform posting limits for the validation module and scheduler caps (researched 2026-10-31)

**Labels:** **V** means I saw it in an official platform source. **V\*** means I saw it only in a secondary source: Upload-Post's docs or a third-party page. **U** means it comes from memory. Bracketed numbers point to the Sources list.

Some of these limits differ from the brief:
- **Instagram cap:** Upload-Post caps Instagram at 50 posts per day, not 100.
- **X link posts:** the $0.20 figure is X's raw price. Through Upload-Post, a link post costs about $0.38 and is limited to 50 a month.
- **Bluesky:** limits are counted in graphemes and in UTF-8 bytes at the same time.

## Table

| Platform | Text limits (unit) | Media limits | Native API publish cap | Upload-Post cap (rolling 24h) [20] |
|---|---|---|---|---|
| **TikTok** | Video caption 2,200 **UTF-16 code units** (V [5]). Photo post: title 90, description 4,000 UTF-16 (V [6]). | Video: MP4/WebM/MOV; H.264/H.265/VP8/VP9; 23–60 fps; 360–4096 px per side; ≤4 GB; API accepts up to 10 min (V [7]). The account's real maximum comes from `creator_info.max_video_post_duration_sec` (V [8]). Minimum 3 s (V\* [20]). Photo posts: up to 35 images (V [6]), WebP/JPEG, ≤20 MB, ≤1080p (V [7]). | About 15 posts per creator per day, **shared across all apps** the creator uses (V [8]). Error `spam_risk_too_many_posts`. 6 requests/min per token (V [5]). Unaudited app: private posts only (V [5]). Inbox upload: at most 5 pending shares per 24h (V [6]). | 15 |
| **YouTube** | Title 100 chars, no `<` or `>`. Description **5,000 UTF-8 bytes**. Tags 500 chars total; commas count, and tags with spaces count their added quotes (V [9]). | Shorts: ≤3 min, square or vertical (V [11]). Shorts over 1 min with a copyright claim are blocked (V [11]). Regular video: ≤15 min unless the account is verified; up to 12 h / 256 GB (V [11]). | Since 2026-06-01 `videos.insert` has its own bucket: **100 uploads/day per Google project, across all users** (V [10]). Unverified projects are no longer forced to private (V [9]). | 30 |
| **Instagram** | Caption 2,200 chars, 30 hashtags, 20 @tags (V [2]). Unit not stated (U). Carousel children cannot have captions (V [2]). | Image: JPEG only, ≤8 MB, aspect 4:5 to 1.91:1, width 320–1440 px (V [1][2]). Carousel: up to 20 items (images, videos or mixed), cropped to the first item, counts as 1 post (V [1][2]). Reels: MP4/MOV, H.264/HEVC, 23–60 fps, ≤25 Mbps, 3 s–15 min, ≤300 MB, 9:16 recommended (V [2]). Stories video: 3–60 s, ≤100 MB (V [2]). | Rolling ("moving") 24h window. Meta's docs contradict themselves: **100** in the main section, **50** in the carousel section (V [1]). Read live usage from `GET /<IG_ID>/content_publishing_limit` (V [1]). | **50** |
| **Facebook Pages** | Post text 63,206 chars (V\* [20]). Reels title 255 (V\* [20]). | Reels: MP4, 9:16, minimum 540×960, 24–60 fps, **3–90 s**, AAC 48 kHz (V [12]). Feed video: ≤4 h / 10 GB (V\* [20]). Photos ≤4 MB, ≤10 MB for Stories (V\* [20]). Page Stories video ≤60 s (V\* [20]). | Reels: **30 per Page per rolling 24h** (V [12]). Other post types have no published cap (U). | 25 |
| **Threads** | 500 chars, but **each emoji counts as its UTF-8 byte length** (V [4]). Upload-Post treats the whole limit as 500 UTF-8 bytes (V\* [20]). At most **5 unique links**; more fails at creation since 2025-12-22 (V [4]). 1 topic tag, 1–50 chars, no `.` or `&` (V [4]). Long-text option up to 10,000 chars (V\* [20]). | Image: JPEG/PNG, ≤8 MB, width 320–1440, aspect up to 10:1 (V [3]). Video: MP4/MOV, H.264/HEVC, 23–60 fps, ≤5 min, ≤1 GB, width ≤1920 (V [3]). Carousel: 2–20 items (V [3][4]). | **250 posts**, 1,000 replies and 100 deletes per rolling 24h (V [3]). Live usage from `threads_publishing_limit` (V). | **50** |
| **X** | **280 weighted chars after NFC normalization.** Emoji and CJK count 2, most other characters 1, and every URL counts 23 (t.co) (V [14]). Premium accounts: 25,000 (V\* [20]). | Up to 4 images (≤5 MB, JPG/PNG/GIF/WEBP), 1 GIF (≤15 MB) or 1 video per post. Video 0.5 s–20 min / 8 GB, or 125 min / 16 GB for Premium. Aspect 1:3 to 3:1, ≤60 fps (V [16]). | `POST /2/tweets`: 100 per 15 min per user, 10,000 per 24h per app (V [15]). Account limit about 2,400/day (U; help page returned 403). | **10 / 20 / 30** depending on Upload-Post plan (V\* [20]) |
| **LinkedIn** | Commentary 3,000 chars (V\* [20]; not stated in LinkedIn's API docs). Commentary uses the "little" format: escape `\| { } @ [ ] ( ) < > # \ * _ ~` with a backslash (V [17]). Video/document title 400 UTF-16 units; a CRLF counts as 2 (V\* [20]). | Multi-image: 2–20 images (V [17]). Images: JPG/PNG/GIF, under 36,152,320 px, GIFs ≤250 frames (V [17]). Video: MP4, 3 s–30 min, 75 KB–500 MB (V [17]). Organic carousels are not supported (V [17]). | Daily caps per app and per member, **reset at midnight UTC**. Numbers are not published; the Developer Portal shows them (V [17]). Third-party sources report 150 per member per day (U). | 150 |
| **Pinterest** | Title 100, description 800, link 2,048, alt text 500 (V [18], OpenAPI v5.28.0). Unit not stated (U). | Multi-image pin: **2–5** images (V [18]). Images ≤20 MB, 2:3 recommended (1000×1500). Video: MP4/MOV/M4V, 4 s–15 min, ≤2 GB (V\* [20]). | org_write: 100 requests/min per user per app on Standard access. Trial access: 300/day per app, 1,000/day total (V [18]). | 20 |
| **Bluesky** | **300 graphemes AND 3,000 UTF-8 bytes**, both enforced (V [19] lexicon). Up to 8 extra tags (each ≤64 graphemes / 640 bytes); up to 3 languages (V [19]). Links are not auto-detected: they must be sent as facets with **UTF-8 byte offsets** (U, well known). | Images: up to 4, `image/*`, **≤2,000,000 bytes each** (V [19]). Upload-Post says 1 MB (V\* [20]). Video: 1 MP4, ≤300,000,000 bytes (V [19]), ≤10 min (V\* [20]), up to 20 VTT caption files of ≤20 KB each (V [19]). Link card thumbnail ≤1 MB (V [19]). | 5,000 points/hour and 35,000/day; a create costs 3 points, so at most 1,666 creates/hour and 11,666/day. Logins: 300/day (V [19]). Video: 25 videos or 10 GB per day (V [19] blog). | 25 videos / 10 GB |

## X API pricing for posts with links

- **X's prices** [13] (V): a post containing a URL costs **$0.200 per request**. A plain post costs $0.015 and a summoned reply $0.010. The price is per post, not per URL.
- **Effective date:** 2026-04-20 (V\* [20], [21]).
- **Billing model:** pay-per-use has been X's default since 2026-02-06 (V\*).
- **Brief:** the brief's $0.20 matches X's raw price.

Through Upload-Post the cost and limits are different (V\* [20]):
- **URLs are removed by default.** Upload-Post strips every URL that X would make clickable from X posts, including captions, titles and first comments.
- **Link add-on:** keeping links needs the "X Links add-on" at **$19/month for 50 link posts**, which is about $0.38 per link post.
- **The 50 is shared per Upload-Post account.** The pool covers all connected X profiles. After 50, URLs are silently stripped until the next billing cycle. If we run one Upload-Post account for all our users, that is 50 link posts a month for the whole product.
- **Metering:** meter against this pool.
- **Link detection:** use twitter-text URL extraction, so bare domains like `example.com` count the same way X counts them.
- **Approval preview:** the approval card must show that links will be stripped.
- **Text over 280:** Upload-Post turns it into a thread unless `x_long_text_as_post=true`. Make that an explicit draft field.

## Units for text limits

| Unit | Where it applies |
|---|---|
| **Graphemes** | Bluesky text (300) and tags (64) |
| **UTF-8 bytes** | Bluesky text (3,000) and facet offsets; YouTube description (5,000); emoji in Threads |
| **UTF-16 code units** (JavaScript `.length`) | TikTok caption, title and description; LinkedIn titles |
| **Weighted code points after NFC** | X. The weight-1 ranges are listed in twitter-text's config v3. Use the official `twitter-text` library rather than writing our own (U). |
| **Plain characters, unit not stated** | Instagram, Facebook, LinkedIn commentary, Pinterest, YouTube title. Validate these with UTF-16 length, which over-counts emoji and so is the safe choice. |

## Rolling windows vs calendar days

**Rolling 24h:**
- Instagram and Threads ("moving period") [1][3]
- Facebook Reels [12]
- TikTok pending shares ("any 24-hour period") [6]
- All Upload-Post caps, which count only successful publishes and are re-checked when a scheduled post fires; an over-cap post returns 429 `hard_cap` [20]
- X per-user limits use 15-minute windows [15]

**Calendar day:**
- LinkedIn: resets at midnight UTC [17]
- X billing deduplication: 24h window in UTC [13]
- YouTube quota: resets at midnight Pacific time (U)

**Window not stated:** TikTok's ~15/day, Pinterest Trial's per-day limits, Bluesky's per-day points. Treat these as rolling 24h; that is the conservative choice.

## Notes for the scheduler caps table

1. **Effective cap = the lower of the native cap and Upload-Post's cap:**

   | Platform | Cap per 24h |
   |---|---|
   | Instagram | **50** |
   | TikTok | 15, shared with every other app the creator uses, so keep some headroom |
   | YouTube | 30 |
   | Facebook | 25 |
   | Threads | 50 |
   | X | 10 / 20 / 30 by Upload-Post plan |
   | LinkedIn | 150 |
   | Pinterest | 20 |
   | Bluesky | 25 videos |

   The brief's Instagram figure of 100 overstates what we can actually post.
2. **Sources that disagree:**
   - Instagram: 100 vs 50 inside Meta's own docs.
   - Bluesky images: 2 MB (lexicon) vs 1 MB (Upload-Post). Use 1 MB while we post through Upload-Post.
   - TikTok: some vendors claim 25/day. I'd treat that as unreliable.
   - Threads: the official rule (emoji counted as UTF-8 bytes) and Upload-Post's rule (whole text counted as UTF-8 bytes) differ. Validate with Upload-Post's stricter rule.
   - YouTube: an upload cost about 1,600 units before 2025-12-04, then about 100 units, and since 2026-06-01 uploads have their own 100-per-day bucket.
3. **Limits that apply to a whole developer app, not one account.** These matter when we build direct adapters later:
   - YouTube: 100 uploads/day per Google project.
   - X: 10,000 posts per 24h per app.
   - TikTok: a daily cap on active publishing users per client.
   - Pinterest: Trial access allows 300 writes/day.
4. **TikTok UX rules that also belong in validation** [8]:
   - The user picks the privacy level manually; there is no default.
   - The branded-content disclosure toggle is off by default, and branded content cannot be private.
   - The user must give explicit consent before upload. This fits our draft-and-approve rule.
5. **LinkedIn link posts:** LinkedIn does not fetch link previews. The post must carry its own title, description and thumbnail [17].

## Sources

1. https://developers.facebook.com/documentation/instagram-platform/content-publishing.md
2. https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
3. https://developers.facebook.com/documentation/threads/overview.md
4. https://developers.facebook.com/documentation/threads/posts.md
5. https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
6. https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
7. https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
8. https://developers.tiktok.com/doc/content-sharing-guidelines
9. https://developers.google.com/youtube/v3/docs/videos and https://developers.google.com/youtube/v3/docs/videos/insert
10. https://developers.google.com/youtube/v3/determine_quota_cost and https://developers.google.com/youtube/v3/revision_history
11. https://support.google.com/youtube/answer/15424877 and https://support.google.com/youtube/answer/71673
12. https://developers.facebook.com/docs/video-api/guides/reels-publishing
13. https://docs.x.com/x-api/getting-started/pricing
14. https://docs.x.com/fundamentals/counting-characters
15. https://docs.x.com/x-api/fundamentals/rate-limits
16. https://docs.x.com/x-api/media/quickstart/best-practices
17. LinkedIn (Microsoft Learn), all under https://learn.microsoft.com/en-us/linkedin/:
    - Posts API: `marketing/community-management/shares/posts-api`
    - Multi-image API: `.../shares/multiimage-post-api`
    - Videos API: `.../shares/videos-api`
    - Images API: `.../shares/images-api`
    - little text format: `.../shares/little-text-format`
    - Rate limits: `shared/api-guide/concepts/rate-limits`
18. https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.yaml and https://developers.pinterest.com/docs/reference/rate-limits/
19. Bluesky lexicons from npm `@atproto/api@0.30.0` (`dist/client/lexicons.js`); https://raw.githubusercontent.com/bluesky-social/bsky-docs/main/docs/advanced-guides/rate-limits.md; https://bsky.social/about/blog/09-11-2024-video
20. Upload-Post docs:
    - https://docs.upload-post.com/guides/limit-of-uploads
    - https://docs.upload-post.com/resources/character-limits
    - https://docs.upload-post.com/api/video-requirements
    - https://docs.upload-post.com/api/photo-requirements
    - https://docs.upload-post.com/guides/x-links-addon
    - https://docs.upload-post.com/guides/post-to-x-twitter-api
    - https://www.upload-post.com/x-api-pricing/
21. https://techcrunch.com/2026/04/22/x-makes-it-more-expensive-to-post-links-through-its-api/ (seen in search results only, not opened)

I did not change any files in the repo. Scratch downloads are in /tmp/research_lex, /tmp/research_li and /tmp/research_pin.
