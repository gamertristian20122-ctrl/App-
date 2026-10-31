# MCP research brief for a remote MCP server on Vercel (as of 2026-10-31)

Legend: **(V)** means I saw it in the cited source, **(U)** means it comes from memory or a secondary source, or I inferred it. No repo files were modified. All network research worked; the scratch downloads are in `/tmp/mcpresearch` and `/tmp/sbauth_raw`, outside the repo.

## 1. Spec version and Streamable HTTP

- **Current spec is `2026-07-28`** (V, [versioning](https://modelcontextprotocol.io/specification/versioning), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). It is the biggest revision so far:
  - **No protocol sessions.** The `Mcp-Session-Id` header, the `initialize` handshake, the GET stream endpoint, DELETE and `Last-Event-ID` resumability are all removed (V).
  - **Per-request metadata.** Every request carries `_meta` with `io.modelcontextprotocol/protocolVersion`, `clientCapabilities` and `clientInfo`. Servers **MUST** implement `server/discover` (V).
  - **Required headers** on every POST: `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` (for tools/call, resources/read and prompts/get). The server **MUST** reject a header/body mismatch with 400 and error `-32020 HeaderMismatch` (V, [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
  - **Responses.** Each POST gets either JSON or an SSE stream scoped to that one request. Closing the stream cancels the request. Change notifications go through `subscriptions/listen`. The server **MUST** validate `Origin` and return 403 if it is invalid (V).
  - **Server-to-client input** (elicitation and similar) now uses Multi Round-Trip Requests: the server returns `InputRequiredResult` and the client retries the call (V).
  - **Every result has `resultType`.** List and read results also need `ttlMs` and `cacheScope` (V).
  - **`tools/list`** **MUST NOT** vary per connection, **MAY** vary by the caller's authorization or scopes, and **SHOULD** return tools in a fixed order (V, [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
  - **Cross-call state** should be explicit handles passed as tool arguments, with authorization re-checked on every call (V). This fits our draft, job and clip IDs.
  - **Deprecated:** Sampling, Roots, Logging and Dynamic Client Registration (DCR) (V). Since we never pay for LLM calls, nothing should be designed around Sampling.
  - **Tasks** moved out of the core into the `io.modelcontextprotocol/tasks` extension (V). How many clients support it is unknown (U). Use job handles plus `post_status` either way.
- **We must support both eras on one endpoint.** The compatibility table says a legacy (`2025-11-25`) client talking to a modern-only server **fails** (V, [versioning/compat](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
  - Claude's support for 2026-07-28 is "rolling out" (U, secondary: [aicatchup](https://aicatchup.com/news/claude-mcp-2026-07-28-stateless-core)).
  - I found no confirmation that ChatGPT supports 2026-07-28 (U).
  - The server has to answer `initialize` as well. Under 2025-11-25, a session ID is optional ("**MAY** assign"), and GET can return 405 (V, [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)). So legacy clients can also be served statelessly on Vercel.
- **SDKs (npm, V):** `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0 (2026-10-23), `@modelcontextprotocol/sdk` 1.32.2, `@modelcontextprotocol/ext-apps` 2.0.4 (2026-10-27). Whether server 2.x handles both eras automatically is not confirmed; test it (U). Cloudflare says its handler accepts both (V, [Cloudflare blog](https://blog.cloudflare.com/mcp-v2/)).

## 2. Authorization (spec 2026-07-28)

- **The MCP server is an OAuth 2.1 resource server.** It **MUST** serve Protected Resource Metadata (RFC 9728) containing `authorization_servers`. It finds it via `WWW-Authenticate: Bearer resource_metadata=…` on a 401, or at `/.well-known/oauth-protected-resource[/mcp-path]` (V, [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [AS discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)).
  - Use the `scope` parameter on the 401 for least privilege.
  - Insufficient scope returns 403 with `error="insufficient_scope"`. Put every scope the operation needs into that one challenge (V).
- **Authorization server metadata:** RFC 8414 or OIDC discovery. Clients check that `issuer` matches exactly (V).
- **PKCE:** clients **MUST** use S256. If `code_challenge_methods_supported` is missing, clients refuse to proceed (V, [security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)).
- **RFC 9207 `iss`:** the AS **SHOULD** return `iss` and advertise `authorization_response_iss_parameter_supported` (V). Changing this to MUST is expected.
- **Client registration** (V, [client-registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)):
  - Client priority order: pre-registered client, then Client ID Metadata Documents (CIMD, if the AS advertises `client_id_metadata_document_supported: true`), then DCR as a fallback.
  - DCR is **deprecated**. Cloudflare reports it is slated for removal after summer 2027 (U).
  - With CIMD, the AS **MUST** fetch the client_id URL, check that its `client_id` matches, and validate redirect URIs against it. It **SHOULD** cache the document per HTTP headers and guard against SSRF. It **MUST** clearly show the redirect host, with extra warnings for localhost-only redirects.
- **Resource indicators (RFC 8707):** clients **MUST** send `resource` (the canonical MCP URL) on both the authorize and token requests (V). Servers **MUST** accept only tokens whose audience is themselves. Token passthrough is forbidden (V).
- **Refresh tokens:** for public clients the AS **MUST** rotate refresh tokens. Short-lived access tokens are a **SHOULD**. Exact redirect-URI match is a **MUST** (V).

**What we must persist if we run our own AS** (U, my design, drawn from the requirements above). Hash codes and tokens and never log them, per house rules.

1. `oauth_clients`:
   - `client_id` (a UUID, or a URL for CIMD), `kind` (cimd, dcr or pre-registered), `client_name`
   - `redirect_uris`, `grant_types`, `token_endpoint_auth_method`, `application_type`
   - `secret_hash` (confidential clients only), the CIMD document cache (etag and expiry), `disabled`
2. `oauth_auth_codes`: `code_hash`, client, user, `redirect_uri`, `code_challenge`, `scope`, `resource`, `brand_ids`, `expires_at` (60s to 10 min), `consumed_at` (reuse revokes the whole grant).
3. `oauth_grants` (consents): user, client, scopes, `brand_ids`, resource, `created_at`, `revoked_at`. This drives the "Connected apps" page.
4. `oauth_refresh_tokens`: `token_hash`, `grant_id`, `family_id`, `parent_id`, scope, resource, `expires_at`, `rotated_at`, `revoked_at`. Reuse detection revokes the whole family.
5. Signing keys: `kid`, encrypted private key, public JWK, status (for rotation).
6. Optional: pending authorization requests (a signed cookie works instead), a DCR rate limit, and an auth audit log.

Access tokens can be short-lived ES256 JWTs with `aud` set to the MCP URL, so they need no storage.

## 3. Supabase Auth as the authorization server

- **Status:** still **Public Beta**. Public beta went live 2025-11-26. The Q4-2025 GA target was not met, and I found no GA announcement (V, [changelog](https://supabase.com/changelog/38022-oauth-2-1-server-capabilities-for-supabase-auth), [discussion #38022](https://github.com/orgs/supabase/discussions/38022)).
- **How it works** (V, [docs](https://supabase.com/docs/guides/auth/oauth-server), [MCP guide](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication), [flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)):
  - Metadata lives at `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1`.
  - Supabase hosts `/oauth/authorize`, `/oauth/token`, the JWKS, userinfo and, optionally, DCR at `/oauth/clients/register`.
  - We build the consent page using `getAuthorizationDetails`, `approveAuthorization` and `denyAuthorization`. Users list and revoke access with `getUserGrants` and `revokeGrant`.
  - Codes last 10 minutes; access tokens last 1 hour.
- **What it stores:** an `oauth_authorizations` table (requests and codes, including PKCE and `resource`) and an `oauth_consents` table (user, client, scopes). Sessions and refresh tokens are tagged with the OAuth client (V: [supabase/auth PR #2107](https://github.com/supabase/auth/issues/2107) and source code). The `oauth_clients` table name is not confirmed (U).
- **Limitations I confirmed in the current `supabase/auth` master source** (V: `jwks.go`, `oauthserver/authorize.go`, `oauthserver/handlers.go`, `tokens/service.go`):
  - The metadata has **no `client_id_metadata_document_supported`** and **no `iss` support flag**. That means DCR only, and Claude registers a new client on every fresh connection (V, [Claude auth docs](https://claude.com/docs/connectors/building/authentication)).
  - The **`resource` value is checked but never put into the token**. Access-token `aud` is the user's aud (`"authenticated"`; the Makerkit write-up says this too). That breaks the MCP requirement that the server MUST check the audience.
  - `code_challenge_methods_supported` is `["S256","plain"]`.
  - Scopes are only `openid`, `email`, `profile`, `phone`. Custom scopes have no ETA (V, discussion, 2026-03-08).
  - Tokens are full-privilege user JWTs that also work directly against our Supabase Data API (subject to RLS).
  - Returning users are auto-approved when an existing consent covers the requested scopes.
  - Open reports in the discussion: custom domains missing from metadata, a SITE_URL coupling, and a revoke quirk (V).
- **Recommendation: build our own AS tables (`oauth` schema) and keep Supabase Auth only as the login identity.**
  - Our `/oauth/authorize` reads the user's Supabase web session, shows consent with a **brand picker and scopes**, and issues our own ES256 JWT with `aud` set to `https://<mcp-host>/mcp`.
  - Support CIMD and S256 only, plus DCR as a fallback.
  - Use custom scopes, for example `drafts:write`, `posts:publish`, `clips:write`, `analytics:read`.
  - This meets the audience rule, gives grants scoped per brand (matching our metering), avoids DCR client sprawl, and keeps the Data API separate from MCP tokens.
  - We can revisit Supabase's AS once it ships CIMD and audience binding (U).

## 4. Tool annotations and prompts

- **`ToolAnnotations`** (V, [schema.ts](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)):

  | Field | Default |
  | --- | --- |
  | `title` | none |
  | `readOnlyHint` | false |
  | `destructiveHint` | **true** (only meaningful when readOnly is false) |
  | `idempotentHint` | false |
  | `openWorldHint` | **true** |

  - Clients **MUST** treat annotations as untrusted. Tool names **SHOULD** be 1–128 characters from `[A-Za-z0-9_.-]`.
  - Input-validation failures should come back as `isError: true` results so the model can fix and retry. Servers **MUST** validate inputs and rate-limit (V).
- **Set all five annotations explicitly on every tool.** Claude's directory needs `title` plus readOnly/destructive. ChatGPT wants readOnly, destructive and openWorld each set to an explicit true or false (V, sources in §6). Proposed values (U):

  | Group | Tools | Annotations |
  | --- | --- | --- |
  | Read-only | list_accounts, list_drafts, post_status, get_transcript, get_analytics | `readOnlyHint: true` |
  | Writes only to our own data | create_draft, make_clips, import_past_posts, render_carousel, render_video, connect_account | readOnly false, destructive false |
  | Overwrites | save_voice_profile | destructive true |
  | Publishes | approve_draft, schedule_post | `destructiveHint: true`, `openWorldHint: true` |

  The publishing tools are irreversible public sends, and OpenAI says being undoable does not justify `destructiveHint: false`.
- **Prompts** are meant for the user to pick (often shown as slash commands). They have `name`, `title`, `description`, `arguments[{name, required}]` and `icons`. `prompts/get` returns messages (text, image, audio, resource link or embedded resource) and may return `InputRequiredResult`. Arguments are strings only. Errors use `-32602`. Inputs and outputs must be validated (V, [prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)). `write_post` can embed the voice profile as a resource (U).

## 5. MCP Apps (the approval card)

- **Status:** extension `io.modelcontextprotocol/ui`. Spec `2026-01-26` is **Stable**, and a draft is in progress (V, [ext-apps README](https://github.com/modelcontextprotocol/ext-apps)). The README lists ChatGPT, Claude, VS Code, Goose, Postman and others as hosts (V).
- **How it works** (V, [apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)):
  - The card is a `ui://…` resource with MIME type `text/html;profile=mcp-app`, served through `resources/read`.
  - Resource `_meta.ui` can set `csp` (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`), `permissions`, `domain` and `prefersBorder`.
  - The tool links to the card with `_meta.ui.resourceUri`. The flat `_meta["ui/resourceUri"]` form is deprecated.
  - `_meta.ui.visibility` defaults to `["model","app"]`. A tool marked `["app"]` is hidden from the model and callable only from the card.
  - The host sends the card `ui/notifications/tool-input`, then `tool-result`.
  - The card calls tools back with JSON-RPC `tools/call` over `postMessage`. The host may require the user to approve. The card can also use `ui/message`, `ui/update-model-context`, `ui/open-link` and `ui/request-display-mode` (inline, fullscreen or pip).
  - Clients advertise support under `capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes`. Always return a text fallback.
- **Claude** (V, [getting started](https://claude.com/docs/connectors/building/mcp-apps/getting-started)):
  - Use `registerAppTool` and `registerAppResource`; `App.connect()` detects the host automatically.
  - Claude's `ui.domain` is the first 32 hex characters of `sha256(serverUrl)` followed by `.claudemcpcontent.com`.
  - Users are asked for permission before an app is displayed.
- **ChatGPT** (V, [ChatGPT UI](https://developers.openai.com/apps-sdk/build/chatgpt-ui)): MCP Apps is the **preferred** path. `openai/outputTemplate` and `window.openai.callTool` are kept for compatibility. Give the UI resource URI a version and treat it as a cache key. Only render tools should carry `resourceUri`. Treat `structuredContent` as untrusted.
- **Design implication (U):** to keep "nothing publishes without approval" a human decision, make the actual approve, edit and reject actions **app-only tools** (`visibility: ["app"]`) called from the card's buttons. The model-visible `approve_draft` then only opens the card. Clients without UI support get a link to the web approval queue instead. Those app-only tools still need annotations.

## 6. Directory and store requirements that affect our design

**Anthropic** ([submission](https://claude.com/docs/connectors/building/submission), [review criteria](https://claude.com/docs/connectors/building/review-criteria), [auth](https://claude.com/docs/connectors/building/authentication)), all (V):
- Every tool needs `title` plus readOnly or destructive. Read-only tools run without asking; destructive tools always prompt.
- Tool names must be 64 characters or fewer. Keep read and write tools separate.
- Descriptions must contain no prompt-injection or promotional text.
- Error messages must be actionable; generic 500s fail review. Collect no conversation data beyond what a tool needs.
- **AI-generated image, video or audio connectors are not accepted.** Our `render_*` tools and clipping must be described as template or ffmpeg rendering, not AI generation.
- APIs must be our own or "legitimately proxied". Upload-Post has to be declared in the Data-handling step.
- **OAuth:**
  - A 401 with `resource_metadata` is required; Claude ignores `WWW-Authenticate` on a 200.
  - Claude uses only the first `authorization_servers` entry. The `resource` value must exactly equal the URL the user enters.
  - Claude uses CIMD only if the AS advertises both `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`; otherwise it falls back to DCR.
  - Redirect URI: `https://claude.ai/api/mcp/auth_callback`. Claude Code also needs port-agnostic `http://localhost/callback` and `http://127.0.0.1/callback`.
  - The token endpoint must accept form-urlencoded bodies, rotate refresh tokens and return `invalid_grant` when one is dead. Limits are 10s (30s for refresh).
  - Claude appends `offline_access` if the AS lists it.
  - Traffic comes from `160.79.104.0/21`.
- **Listing:** documentation URL, privacy policy URL, support contact, icon, and a fully populated test account. For an MCP App, 3–5 PNG screenshots at least 1000px wide. Seven compliance acknowledgments. Submissions go through claude.ai/directory/manage.

**OpenAI** ([submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines), [auth](https://developers.openai.com/apps-sdk/build/auth), [MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)), all (V):
- **OAuth:**
  - The AS metadata must list S256.
  - ChatGPT prefers CIMD: `client_id` is `https://chatgpt.com/oauth/client.json` if the AS supports `iss`, otherwise `https://chatgpt.com/oauth/{callback_id}/client.json`. It falls back to DCR.
  - Redirect URI is `https://chatgpt.com/connector_platform_oauth_redirect` with `iss` support, otherwise `https://chatgpt.com/connector/oauth/{callback_id}`.
  - ChatGPT sends `resource`, and it should be copied into `aud`.
  - Declare per-tool `securitySchemes`. A tool result with `_meta["mcp/www_authenticate"]` triggers re-auth.
  - No `client_credentials` grant.
- **Policy:**
  - Verified organization, privacy policy, demo account, data minimization.
  - **Never ask for API keys or passwords in chat**, so `connect_account` must hand off to an OAuth or link flow.
  - **No showing plans, no upgrade prompts, no checkout links.** Our plan-limit errors must be neutral, with no upsell.
  - Don't return request or trace IDs unless needed. Tools should be safe to retry or say when they are not. Any iframes must be declared in `frameDomains` with a justification.
