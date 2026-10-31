# CLAUDE.md

## What we're building

A cheaper, better Blotato: a social media tool that any AI assistant (Claude, ChatGPT, Cursor and others) can drive through MCP.

The user's AI does the thinking. Our server does the work. We never pay for LLM calls. Our MCP server exposes tools (actions) and prompts (our playbook) so every AI produces consistent results.

What we do that Blotato doesn't: clip long videos into vertical shorts, write in the user's own voice, and run a weekly review that learns from analytics.

Price: Starter $8/mo, Plus $15/mo, Pro $25/mo. Costs per user must stay well below that, so every feature is metered by brands and clipping hours.

## Plans (enforce in code)

| Plan    | Price | Brands | Clipping hours/mo |
| ------- | ----- | ------ | ----------------- |
| Starter | $8    | 1      | 4                 |
| Plus    | $15   | 2      | 10                |
| Pro     | $25   | 4      | 20                |

Add-ons: $3 per extra brand, $1 per extra clipping hour. X posts that contain a link cost us $0.20 each, so meter them.

## Stack

- TypeScript everywhere (strict mode)
- Next.js on Vercel: small web app (calendar, approval queue, accounts, billing)
- Remote MCP server over Streamable HTTP with OAuth 2.0
- Supabase: Postgres and auth
- Cloudflare R2: video and image files
- Railway: workers (job queue, clip worker with ffmpeg, renderer with a headless browser)
- Upload-Post: posting and analytics for all 9 platforms (TikTok, YouTube, Instagram, Facebook, Threads, X, LinkedIn, Pinterest, Bluesky)
- Transcription: self-hosted Whisper first; AssemblyAI as fallback
- Stripe: billing

## House rules

- All posting goes through the `PostingProvider` interface. Upload-Post is the first implementation; direct platform APIs come later as separate adapters. Nothing outside the adapter may call Upload-Post directly.
- Nothing publishes without approval. Every post and clip is saved as a draft first.
- Every MCP tool has a `title` and a `readOnlyHint` or `destructiveHint` annotation (required by Claude's connector directory).
- Validate everything an AI sends us (timestamps, post text, platform limits) before acting on it. Never trust tool input.
- Respect platform caps in the scheduler: Instagram 100 API posts per account per 24 hours, TikTok about 15 per creator per day.
- Never log OAuth tokens or API keys. Encrypt tokens at rest. Request the fewest scopes possible.
- Users may only clip their own content: accept uploads and cloud-drive links, never download YouTube links.
- Write a test for every API route and MCP tool. Mock external HTTP calls.
- Plan before coding. For any feature, propose the data model, routes and tests first, and wait for approval.

## MCP surface (v1)

- **Tools:** `connect_account`, `list_accounts`, `create_draft`, `list_drafts`, `approve_draft`, `schedule_post`, `post_status`, `get_transcript`, `make_clips`, `import_past_posts`, `save_voice_profile`, `render_carousel`, `render_video`, `get_analytics`
- **Prompts:** `write_post` (loads the voice profile), `pick_clips` (rules for standalone moments with a hook), `weekly_review`
- **MCP App:** an approval card for `approve_draft` with a per-platform preview and Approve, Edit and Reject buttons.

## Build order

1. Database schema: users, brands, connected accounts, drafts, posts, clips, voice profiles, analytics snapshots, usage meters
2. `PostingProvider` + Upload-Post adapter, job queue, connect/list/schedule tools
3. Remote MCP server with OAuth; draft and approval tools
4. MCP App approval card
5. Clip worker: transcription, `get_transcript`, `make_clips` (ffmpeg, 9:16, burned-in captions)
6. Voice profile tools and the `write_post` prompt
7. `render_carousel`, template videos (`render_video`), `get_analytics`, `weekly_review` prompt
8. Web app and Stripe billing with plan limits

Test each step from both Claude and ChatGPT before moving on.
