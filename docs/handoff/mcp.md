# MCP handoff: `@app/mcp`

Owner: MCP agent (`packages/mcp/**`). Requests for other owners are at the end.

## Contract (for the web route `/api/mcp`)

```ts
import { handleMcpRequest, createMcpServer, TOOL_NAMES, APPROVAL_CARD_URI, type McpContext } from '@app/mcp'

// app/api/mcp/route.ts (POST, GET, DELETE → same handler; runtime 'nodejs')
const auth = await services.oauth.verifyAccessToken(req.headers.get('authorization'))   // 401 + WWW-Authenticate on error
return handleMcpRequest(req, { services, userId: auth.userId, baseUrl: config.APP_URL, log: log.child({ route: 'mcp' }) })
```

`McpContext = { services, userId, baseUrl, log?, allowedOrigins?, mediaOrigins? }`

- Pass the `Request` untouched (do not read its body first). The handler returns a complete `Response` (always JSON, never a long-lived stream), so no background work is left running.
- `allowedOrigins`: extra values accepted in the `Origin` header (DNS-rebinding protection). The origin of `baseUrl` is always accepted, and requests without `Origin` (Claude, ChatGPT and other server-side clients) are allowed. A foreign `Origin` gets 403.
- `mediaOrigins`: origins the approval card may load previews from (its CSP `resourceDomains`). By default it is the origin of `storage.presignGet` URLs (R2 endpoint, or the dev-storage origin).
- `createMcpServer(ctx)` returns an SDK `McpServer` for in-memory or other transports. It is stateless: build one per request.
- Never log request headers in the route. The handler logs only the tool name, userId, duration and error code (`mcp tool call`). It never logs arguments or tokens.

## Protocol support (docs/research/mcp.md §1)

- **Legacy clients (2024-11-05 … 2025-11-25)** use the SDK's `WebStandardStreamableHTTPServerTransport` in stateless JSON mode. `initialize` returns instructions and capabilities (`tools`, `prompts`, `resources`). There is no `Mcp-Session-Id`, and a stale one is ignored. GET and DELETE return 405 (`Allow: POST`). An Accept header that does not list both types is tolerated.
- **2026-07-28 clients** (per-request `_meta`) go through a thin layer in `src/http.ts`:
  - `server/discover` is answered directly.
  - The `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers are checked against the body (`Mcp-Name` may use the `=?base64?…?=` form); a mismatch returns 400 `-32020`.
  - An unknown version returns 400 `-32022` with `data.supported` listing every version, so dual-era clients can fall back to `initialize`.
  - Unknown methods return 404 `-32601`. `initialize`, `subscriptions/listen` and logging are not offered in this era.
  - Notifications return 202. Batches return 400.
  - Every result gets `resultType: "complete"`. The list results and `resources/read` also get `ttlMs` and `cacheScope: "public"`.
- **Not implemented:** server-to-client requests (sampling, elicitation, MRTR), the tasks extension, SSE progress streams, list-changed subscriptions.

## Tools

| Tool | Service call | readOnly / destructive / idempotent / openWorld |
| --- | --- | --- |
| connect_account | `accounts.connectLink` (redirect: `baseUrl/app/accounts`) | F / F / T / T |
| list_accounts | `brands.list` + `accounts.sync` (only brands with a provider profile; best-effort) + `accounts.list`. Returns brands with their accounts, which is how the AI learns brand ids | T / F / T / T |
| create_draft | `drafts.create` | F / F / F / F |
| list_drafts | `drafts.list` | T / F / T / F |
| approve_draft | `drafts.preview` + `approvals.issueNonce(via 'mcp')`. Opens the card | T / F / T / F |
| schedule_post | `posts.schedule` (pre-validated with the services clock) | F / T / T / T |
| post_status | `posts.status` (postId \| draftId), `clips.get` (clipId), `jobs.get` (jobId: renders and imports) | T / F / T / F |
| get_transcript | `transcripts.get`. Without `mediaId` it lists clip sources (`media.list` + `isClipSource`) | T / F / T / F |
| make_clips | `clips.requestClips` | F / F / F / F |
| import_past_posts | `imports.importPastPosts` | F / F / T / T |
| save_voice_profile | `voice.save` | F / T / F / F |
| render_carousel, render_video | `renders.requestCarousel` / `requestVideo` (described as template rendering, not AI generation) | F / F / F / F |
| get_analytics | `analytics.summary` | T / F / T / F |
| approval_decide (app-only) | `approvals.decide(via 'mcp')` | F / T / F / F |
| approval_edit_variant (app-only) | `approvals.editVariant(via 'mcp')` + `drafts.preview` (returns the next nonce) | F / T / F / F |

- **Tool metadata:**
  - Every tool has a `title`, all four hints, and `securitySchemes` (oauth2, scope `social`) both top-level and in `_meta`.
  - App-only tools have `_meta.ui.visibility: ["app"]` and `openai/visibility: "private"`.
  - `approve_draft` has `_meta.ui.resourceUri` and `openai/outputTemplate` = `ui://approval-card/v1`.
- **Inputs:**
  - `inputSchema` is the core zod schema → JSON Schema (draft-07, `io: 'input'`) with descriptions added per property.
  - Arguments are pre-validated in `@app/mcp`, then passed raw to the service, which parses them again with the same schema.
  - Validation errors list each field. Text limits say how much is over (for example "That is 20 over the limit of 280").
- **Results:** concise text for the model, plus `structuredContent` built from views that omit storage keys, user ids, provider ids and hashes.
- **Errors:**
  - An `AppError` becomes `isError: true` with the service's message, the issues, and a next step. Examples: `cap_reached` gives the earliest free slot; `conflict/not_approved` says to call approve_draft; `not_found` says which list tool to use.
  - Messages are neutral, with no upsell.
  - Unknown errors return a generic message and are logged redacted.
  - An unknown tool returns JSON-RPC `-32602`.

## Approval card (`ui://approval-card/v1`, `text/html;profile=mcp-app`)

- **Nonce handling:**
  - `approve_draft` and `approval_edit_variant` results carry `_meta.approvalCard = { nonce, expiresAt, revision, webUrl, preview }`.
  - The `preview` there includes presigned media URLs. The model-visible `structuredContent` has the same preview without URLs.
  - The nonce and media URLs never appear in `content` or `structuredContent` (tested).
  - The one-click `approveUrl` link nonce is never returned. The text fallback is `baseUrl/app/approvals?draft=<id>`.
- **Document:** `src/card/html.ts` is one self-contained document: inline CSS and JS, no external URLs, `textContent` only.
- **Protocol:**
  - The card sends `ui/initialize` (protocolVersion `2026-01-26`, `appInfo`, `appCapabilities`), then `ui/notifications/initialized`.
  - It handles `ui/notifications/tool-input`, `tool-result`, `tool-cancelled` and `host-context-changed` (theme and CSS variables), plus `ui/resource-teardown` and `ping`.
  - Buttons call `tools/call` with `approval_decide` or `approval_edit_variant` and the nonce.
  - It also uses `ui/update-model-context` after a decision, `ui/open-link` for the web link, and `ui/notifications/size-changed`.
  - When `window.openai` is present (ChatGPT), it reads `toolOutput` / `toolResponseMetadata` and calls `window.openai.callTool`.
- **UI:**
  - Per-platform tabs show the account, title, text, a character counter against the limit, media thumbnails and issues.
  - Approve is disabled until the draft is ready.
  - Edit keeps the typed text if the server refuses it.
  - Reject takes an optional reason.
  - It has success and error states, light and dark themes, and an "Open in web app" link.
- **Resource `_meta`:** `ui.csp = { connectDomains: [], resourceDomains: <media origins> }`, `prefersBorder`, and `openai/widgetCSP` (with `redirect_domains: [baseUrl origin]`).

## Prompts

- `write_post(brand_id, topic, platforms?)`:
  - Loads the latest voice profile, the 8 best imported posts, and the core `PLATFORM_RULES` for the chosen platforms. Platforms default to the brand's active accounts.
  - Adds the house rules: draft first with create_draft, approve_draft, never publish or schedule on your own.
- `pick_clips(media_id, count?)`:
  - Loads the transcript segments (with ms timestamps) and the rules: standalone, a hook in the first 3 s, 20–90 s, a complete thought, no context dependency, no overlap.
  - Explains the exact `make_clips` call and how to get word timings with get_transcript.
- `weekly_review(brand_id)`:
  - Loads `analytics.weeklyReview`: totals vs the previous week with % change, per platform, followers, top and weakest posts, cadence, pipeline, voice version.
  - Asks for exactly 3 experiments plus draft suggestions, with approval before anything is scheduled.
- Bad arguments, or an id belonging to another user, return JSON-RPC `-32602`.

## Tests

`pnpm -F @app/mcp test`: 6 files, 42 tests on PGlite with real services, the `FakePostingProvider` and `MemoryStorage`. Nothing touches the network. `pnpm -F @app/mcp typecheck` is clean, the `src` also typechecks with the web app's compiler options (DOM lib), and `pnpm lint` (boundaries) passes.

What the tests cover:

- **tools/list:** order, titles, annotations, app-only visibility, card metadata.
- **Every tool:** the happy path, a validation error and a cross-tenant id.
- **Errors:** cap-reached suggestion, X limit "over by", X links refused, generic message on a crash (no secret in the text or the log).
- **Nonce:** approve_draft never leaks the nonce, media URLs or the link nonce.
- **approval_decide:** approves only with the card nonce, refuses a made-up nonce, the web link nonce, another user and reuse, and lets an approval that failed validation keep its nonce.
- **approval_edit_variant:** rotates the nonce.
- **Card resource:** MIME type, CSP and no external URLs.
- **Card script:** run in `node:vm` with a fake DOM: handshake, render, approve, edit (including a server refusal), reject, the `window.openai` fallback, and the no-nonce mode.
- **Prompts:** render with the voice profile and analytics, and refuse bad arguments.
- **HTTP:**
  - Legacy initialize, tools/list and tools/call over Request/Response, and the SDK `StreamableHTTPClientTransport` end to end.
  - 405, 403 origin, 415 and parse errors.
  - The 2026-07-28 behaviour: discover, cache hints, base64 `Mcp-Name`, -32020 mismatches, -32022, 404, 202, batches.
- **Package:** `src` imports only core, services, the SDK and zod.

**Test-only resolution:** the tests import `@app/db/testing`, `@app/posting` and `@app/storage` through aliases in `packages/mcp/vitest.config.ts` and `tsconfig.json` "paths". They are not runtime dependencies, so no `package.json` change and no install was needed.

## Decisions

1. **approve_draft is read-only** (task). It only opens the card. The AI can never approve, because approving needs the card nonce, which only exists in the result's UI-only `_meta`.
2. **post_status also covers clips (`clipId`) and background jobs (`jobId`).** The v1 surface has no other way to poll renders and imports.
3. **get_transcript without `mediaId` lists clip sources.** The v1 surface has no media list tool.
4. **list_accounts returns brands with their accounts.** There is no list_brands tool, and every other tool needs a brandId. It refreshes from the provider only for brands that already have a provider profile, so no provider profile is created as a side effect.
5. **Tools are served by our own tools/list and tools/call handlers** on `McpServer.server`. This gives exact JSON Schemas, raw arguments for services, and our own error results. Prompts and the resource use `registerPrompt` / `registerResource`.

## Requests

1. **Web (apps/web)**, `/api/mcp` route:
   - Verify the bearer token first; on failure return 401 with `WWW-Authenticate: services.oauth.wwwAuthenticate('invalid_token')`.
   - Then call `handleMcpRequest(req, ctx)` for POST, GET and DELETE.
   - Optional: CORS for browser-based inspectors, together with `allowedOrigins`.
   - Rate-limit per user or token.
2. **Web (apps/web)**: `/app/approvals?draft=<id>` should open or focus that draft. approve_draft and the card link there for clients without MCP Apps.
3. **Root (optional)**: if you prefer real workspace links over test aliases, add `@app/db`, `@app/posting` and `@app/storage` as devDependencies of `@app/mcp` and run `pnpm install`. Then drop the aliases from `packages/mcp/vitest.config.ts` and `tsconfig.json`.
4. **Services (optional)**: `media.listSources(userId, { brandId? })` (clip sources only) would replace the `media.list` + `isClipSource` filter in get_transcript. `jobs.get` already serves render and import status.

## Gaps

- **No real-client testing yet.** The server has not been exercised with Claude, ChatGPT or MCP Inspector; that needs a deployed URL. The 2026-07-28 layer is written from the spec pages (transports, versioning, discover, caching) and tested with synthetic requests only.
- **Card checked without a browser.** The card's script is tested in `node:vm` with a fake DOM. Visual checks in a browser (layout, dark mode, video thumbnails) are still to do.
- **No rate limiting here.** It belongs in the web route.
