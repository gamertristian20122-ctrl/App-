# Step 1 overview: the database (owner summary)

A plain-English summary of the full plan, `01-database-schema.md`. It awaits your approval; nothing is built yet.

## 1. What step 1 builds

- **The database structure** (Supabase Postgres). Most rules run inside the database, so later code can't skip them.
- **Five small TypeScript packages:** plan limits and input checks (`@app/shared`), database access (`@app/db`), encryption (`@app/crypto`), safe logging (`@app/log`) and settings (`@app/env`).
- **Automated tests** that run on every change (CI).
- **Two dev-only scripts** that create demo customers and approve drafts, so steps 2–7 can run before the web app exists.

There are **no screens, no web routes and no MCP tools** yet. Those need the login design from step 3.

## 2. The main pieces of data

- **Accounts & billing.** Users live in Supabase Auth. `workspaces` (one per user) is the billing unit; `workspace_billing` copies Stripe facts and computed limits.
- **Brands & connected social accounts.** `brands`. `provider_profiles`: one Upload-Post profile per brand. `connected_accounts`: written only from data Upload-Post has verified. `encrypted_secrets`: empty in v1.
- **Videos, transcripts & clips.** `media_assets` records every R2 file (files stay out of the database). `source_media` holds long videos to clip, then `transcripts`, `transcript_segments` and `clips`. `jobs` tracks background work.
- **Drafts, approvals & posts.** `drafts` holds an idea; `draft_variants` one version per platform. `variant_revisions` and `revision_media` are frozen snapshots of each edit. `approvals` records who approved what. `posts` and `post_attempts` track publishing.
- **Voice profiles.** `voice_profiles`: every save is a new version; one is active per brand.
- **Analytics.** `imported_posts` (past posts, text only), `account_metric_snapshots` and `post_metric_snapshots` (figures over time), and the view `v_post_performance` (a saved query) for the weekly review.
- **Usage meters.** `usage_balances` holds what is left this period. `usage_ledger` is a permanent log of every charge and refund.
- **Housekeeping.** `platform_rules` (caps per platform), `inbound_events` (webhooks) and `audit_events` (who did what).

## 3. How the house rules are guaranteed

- **Approval before publishing.** Every edit is a frozen snapshot. The database takes a fingerprint (hash) of the text, media files, target account and Page or board. A post can only exist if it points to an approval of that exact snapshot, and one approval allows one publication. The fingerprint is rechecked just before sending; any change holds the post. In v1, approvals happen only in the web app, so an AI cannot approve its own drafts.
- **Plan limits.** Limits are defined once, in code. The brand limit is a database rule that takes one request at a time, so two simultaneous requests can't both slip through. Clipping hours are reserved before work and charged after it. Balances never go below zero. Our failures are refunded.
- **Platform caps.** Checked just before each post is sent, against the real account's posts in the last 24 hours, even after a reconnect. Instagram is 50, not 100: Upload-Post's limit.
- **Own-content-only clipping.** There is no "download from a URL" option. Drive links must be Google Drive, Dropbox or OneDrive. The database blocks YouTube addresses, and CI rejects YouTube-downloader libraries. Every source needs a rights checkbox, plus a one-time web confirmation by the customer if an AI added it.
- **Secrets.** v1 stores no social-media logins; Upload-Post holds them. Future secrets are encrypted, and internet-facing servers can lock them but never unlock them. Logs hide tokens, keys and share links. Nothing is exposed through Supabase's public API, and separate database logins limit what each server can touch.

## 4. Size and cost honesty

**Counts:** 28 tables and 2 views; 42 callable SQL functions (small programs stored in the database) plus internal helpers and automatic rules; 5 packages; 14 migrations (scripts that create or change the database); 10 database roles; about 250 numbered tests. The lean design had 15 tables, 2 packages, 1 app login and about 6 app functions.

**Hosting should stay cheap** (step 7 measures it). The real cost is upkeep: most rules are in the database's own language, every change needs a migration, and that code is harder to debug alone.

**Heavier than a minimal v1:** a 7-table approval chain (lean used 3), three usage meters with refund handling, 10 roles instead of 1, and many tables only steps 5–8 use.

**Could be deferred:**
- **Secrets table and encryption package** (to step 3). *Risk:* low; it holds nothing in v1.
- **Separate logins for video workers and billing** (to steps 5 and 8). *Risk:* if forgotten, the most exposed process gets wide access.
- **Render and storage limits** (to step 5). *Risk:* our biggest variable costs; clipping can't launch without them.
- **"Keep links on X"** (until a direct X adapter). *Risk:* X links are always removed, with a warning. Little lost; the default allowance is 0.
- **Post attempts and webhook inbox** (to step 2). *Risk:* low; they must arrive with publishing.
- **Imports and analytics tables** (to steps 6–7). *Risk:* the brief lists analytics in step 1; adding later is easy.
- **History log** (`audit_events`). *Risk:* early history is lost for good; approvers are still recorded.
- **Mid-month upgrade pricing** (to step 8; staff-granted free plans until then). *Risk:* reworking metering later, with real money involved.
- **Fewer packages:** merge encryption, logging and settings. *Risk:* very low.

Don't defer the approval chain, brand limit, clipping-hour metering, own-content checks or customer separation. One assumption is unconfirmed: that Supabase's connection pooler accepts our custom logins. A staging test checks it; the fallback is direct connections.

## 5. Decisions needed from you (recommended defaults)

1. **X posts with links:** allowance 0; "remove link" preselected, with a warning.
2. **Clipping hour:** source video length, charged once per video per brand; our failures refunded.
3. **Unused hours:** no rollover.
4. **$1 hour add-on:** monthly, recurring, prorated mid-month.
5. **Plan changes:** upgrades at once; downgrades at period end; granted hours stay.
6. **Too many brands after a downgrade:** suspend the newest, hold their posts, delete nothing.
7. **Failed payment:** approved posts still publish; new clipping and rendering blocked.
8. **Trial:** 7 days of Starter, card required, 1 clipping hour; no free tier.
9. **Accounts per platform:** one per brand.
10. **Retention:** drop a brand's Upload-Post profile 7 days after archiving (30 after cancelling); source videos after 30 days; cancelled workspaces after 90.
11. **Instagram cap:** 50 a day.
12. **Upload-Post plan:** Professional ($50 a month, 25 profiles).
13. **Upload limit:** 4 hours and 10 GB per file.
14. **Brand churn guard:** at most brand limit + 1 live profiles; limit + 2 new per period.
15. **Approval covers posting time?** No; reschedules are logged.
16. **Analytics:** account totals daily; each post at 24 h, 48 h, 7 days and 30 days.
17. **Rights:** a checkbox per video, plus a one-time web confirmation for AI-added videos.
18. **AI apps without approval cards:** approve through a web link.
19. **One approval, one post:** yes.
20. **Render allowance:** 3× clipping time; at most 3 renders at once.
21. **Media from an AI chat:** the AI gives the customer a short-lived upload link.
22. **Storage:** 50, 100 or 200 GB by plan.
23. **Approving in the chat card:** buttons open a one-click web confirmation until step 4 proves a human clicked.

## 6. What happens after approval

1. Your answers and chosen deferrals go into the plan.
2. Step 1 is built. It is done when all tests pass and a trial run against staging is clean.
3. Step 2 is planned: the Upload-Post adapter, the job queue, and the connect, list and schedule tools. You approve that plan before coding; then it is tested from Claude and ChatGPT.
