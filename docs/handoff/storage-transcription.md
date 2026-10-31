# Storage + transcription handoff: `@app/storage`, `@app/transcription`

Owner: storage-transcription agent. Covers `packages/storage/**` and `packages/transcription/**`. Requests for changes elsewhere are in the "Requests" section at the end.

Both packages are server-only (they use `node:fs` / `node:crypto`) and export TypeScript source from `src/index.ts`.

## `@app/storage`

| File | What |
| --- | --- |
| `src/keys.ts` | `sourceKey`, `uploadKey`, `clipKey`, `renderKey`, `userPrefix`, `parseKey`, `isKeyOwnedBy`, `keyOwner`, `assertValidKey`, `normalizeExt`, `extForMime`, `mimeForExt`, `KEY_AREAS` |
| `src/r2.ts` | `R2Storage` (ObjectStorage + multipart), `createR2Client`, `r2Endpoint`, `mapS3Error` |
| `src/local/fs.ts` | `FsStorage` (local directory) |
| `src/local/memory.ts` | `MemoryStorage` (tests; test helpers `getBytes`, `has`, `keys`, `openUploads`, `clear`) |
| `src/local/handler.ts` | `createLocalStorageHandler(storage)` → `(Request) => Promise<Response>` for the dev-storage route; `parseRange` |
| `src/local/signing.ts` | `LocalUrlSigner` (HMAC-signed local URLs) |
| `src/multipart.ts` | `MultipartStorage` interface, `supportsMultipart`, `planParts`, `CompletedPartsSchema` (zod), limits |
| `src/factory.ts` | `createStorageFromConfig(config, { logger?, clock?, s3Client? })`, `isLocalStorage`, `DEV_STORAGE_PATH`, `devStorageBaseUrl`, `AppStorage` type |
| `src/errors.ts` | `storageError`, `storageErrorReason`, `STORAGE_ERROR_REASONS` |
| `src/validate.ts` | `MAX_SINGLE_PUT_BYTES` (5 GB), `MAX_PRESIGN_TTL_SEC` (7 days), `DEFAULT_PUT_TTL_SEC` (1 h), `ContentTypeSchema` |

### Keys (every driver enforces this layout)

```
users/{userId}/uploads/{mediaId}.{ext}   browser uploads through a presigned PUT (any media kind)
users/{userId}/sources/{mediaId}.{ext}   clip sources the worker ingests from cloud-drive links
users/{userId}/clips/{clipId}.{ext}      rendered clips (clipKey default ext: mp4)
users/{userId}/renders/{mediaId}.{ext}   carousel slides (png) and template videos (mp4)
```

IDs must be UUIDs (lower-cased by the helpers); extensions 1–8 `[a-z0-9]` (`extForMime(mime)` covers every type in `ALLOWED_MIME`). Every driver method rejects any key that is not `users/{uuid}/` + segments of `[A-Za-z0-9._-]` not starting with a dot (`AppError('validation')`, `details.reason = 'invalid_key'`). Use `isKeyOwnedBy(key, userId)` before serving a key that came from a request. Store the key in `media_assets.storage_key`.

### Contract details callers must know

- **`presignPut(key, contentType, maxBytes)` signs an exact size.** S3/R2 presigned PUTs cannot express "at most N bytes" (R2 has no POST policy), so R2Storage signs `Content-Type` **and** `Content-Length`; pass the **declared file size** (`UploadRequestSchema.bytes`) as `maxBytes`, not the plan maximum. The browser must send exactly that many bytes with the returned `headers` (`{ 'Content-Type' }`; the browser sets Content-Length itself from the body). Wrong type or size → R2 answers 403 SignatureDoesNotMatch. The local drivers enforce the same rule (403 wrong type/declared length, 400 body of another length), so this shows up in dev. Still `head()` the object in `completeUpload` and compare `bytes`.
- Single PUTs are limited to 5 GB (`MAX_SINGLE_PUT_BYTES`; R2's limit is ~4.995 GiB). Larger browser uploads (sources go up to 10 GB) must use multipart (below). `presignPut` above the limit throws `details.reason = 'too_large'`.
- `presignGet(key, ttlSec)`: 1 s … 7 days. Give Upload-Post ≥ 1 h (it downloads asynchronously).
- `putFile` streams from disk and switches to multipart above 100 MiB automatically (32 MiB parts, 4 in parallel, aborts the upload on failure). `getToFile` writes to `<path>.part-xxxx` and renames, creating parent directories; a broken download leaves no file.
- `head` → `null` when missing; `delete` is idempotent; `getToFile` on a missing key → `AppError('not_found')`.
- Errors: `AppError` with `details.reason` ∈ `invalid_key | invalid_input | not_found | too_large` (code `validation`/`not_found`) or `storage_auth | storage_unavailable` (code `unavailable`, retryable). SDK errors are never attached (they carry raw responses); credentials never appear in messages, logs or URLs.

### Multipart (browser uploads over 5 GB)

All three drivers implement `MultipartStorage` (`supportsMultipart(storage)` is true for each):

1. `createMultipartUpload(key, contentType)` → `{ uploadId }` (store it on the media row).
2. `planParts(totalBytes)` → uniform parts (R2 requires every part but the last to be the same size, ≥ 5 MiB; default 32 MiB, grown to stay ≤ 10,000 parts).
3. Per part: `presignUploadPart(key, uploadId, partNumber, bytes, ttlSec?)` → `{ url, headers: {} }`; the browser PUTs exactly `bytes` and keeps the `ETag` response header (R2 CORS must expose `ETag`, see Ops).
4. `completeMultipartUpload(key, uploadId, [{ partNumber, etag }])` — the list is zod-validated (ascending, unique, sane ETags; quotes optional). Then `head()` as usual.
5. On cancel/failure: `abortMultipartUpload(key, uploadId)` (idempotent).

### Local dev storage: URL contract for `/api/dev-storage`

`FsStorage` (STORAGE_DRIVER=fs, default in dev) and `MemoryStorage` (STORAGE_DRIVER=memory, `testConfig()`) presign URLs on `devStorageBaseUrl(APP_URL)` = `{APP_URL}/api/dev-storage`:

```
{base}/{key}?op=get&exp={unixSec}&sig={hex}                                      GET, HEAD (Range: bytes=a-b → 206)
{base}/{key}?op=put&exp={unixSec}&ct={contentType}&len={bytes}&sig={hex}          PUT (Content-Type must equal ct; body exactly len)
{base}/{key}?op=part&exp={unixSec}&uid={uploadId}&pn={partNumber}&len={bytes}&sig={hex}   PUT one multipart part (returns ETag)
sig = hex(HMAC-SHA256(secret, "v1\nop\nkey\nexp\nct\nlen\nuid\npn"))  (empty strings for absent fields)
```

Statuses: 200/206 ok (PUT returns `ETag`), 400 malformed URL or wrong body length, 403 bad signature / expired / wrong Content-Type / wrong Content-Length header, 404 missing object or upload, 405 wrong method, 416 bad range. The signing secret is `SESSION_SECRET` (fallback `DEV_STORAGE_FALLBACK_SECRET` when unset; fs/memory are refused in production by config.ts), so the web app and the worker accept each other's URLs. Only the path after `/api/dev-storage/` is checked (host may differ: localhost vs 127.0.0.1).

The web agent mounts it (only for local drivers):

```ts
// apps/web/app/api/dev-storage/[...key]/route.ts
import { createLocalStorageHandler, isLocalStorage } from '@app/storage'
async function handle(req: Request) {
  const storage = getStorage()            // the app's single storage instance (createStorageFromConfig, cached on globalThis)
  if (!isLocalStorage(storage)) return new Response('Not found', { status: 404 })
  return createLocalStorageHandler(storage, { logger })(req)
}
export { handle as GET, handle as HEAD, handle as PUT }
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
```

Create storage **once per process** (MemoryStorage keeps objects in memory; FsStorage is stateless but there is no reason to rebuild it). Upload-Post cannot reach localhost, so local presigned GETs only work with the fake posting provider (which accepts http URLs).

### Using it

```ts
const storage = createStorageFromConfig(config, { logger })     // r2 | fs | memory from STORAGE_DRIVER
const key = uploadKey(userId, mediaId, extForMime(contentType) ?? 'bin')
const { url, headers } = await storage.presignPut(key, contentType, declaredBytes)
// later: const h = await storage.head(key); if (!h || h.bytes !== declaredBytes) → fail the upload
// worker: await storage.getToFile(key, tmpPath); await storage.putFile(clipKey(userId, clipId), outPath, 'video/mp4')
```

Tests: `new MemoryStorage()` (no arguments needed), or `createStorageFromConfig(testConfig())`. Push presigned URLs through `createLocalStorageHandler(storage)(new Request(url, { method: 'PUT', headers, body }))` to simulate the browser.

### Ops: R2 setup (for whoever deploys)

- API token: **Object Read & Write, scoped to the one bucket** (fewest permissions). Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`R2_ENDPOINT` only for EU jurisdiction buckets: `https://<account>.eu.r2.cloudflarestorage.com`).
- Bucket CORS (browser uploads): AllowedOrigins = `APP_URL`; AllowedMethods `PUT`, `GET`, `HEAD`; AllowedHeaders `content-type`; ExposeHeaders `ETag`; MaxAgeSeconds 3600.
- Lifecycle rules: abort incomplete multipart uploads after 1 day; delete `users/*/sources/` objects after 30 days (ARCHITECTURE retention; R2 lifecycle filters by prefix, so a per-user prefix rule is not possible: the `cleanup` worker job must delete expired sources by key, or put sources under a top-level prefix — see Requests).

## `@app/transcription`

| File | What |
| --- | --- |
| `src/whisper.ts` | `WhisperTranscriber`, `whisperEndpoint`, `WhisperVerboseJsonSchema` (zod) |
| `src/assemblyai.ts` | `AssemblyAITranscriber`, `AssemblyAITranscriptSchema` (zod) |
| `src/fake.ts` | `FakeTranscriber` (+ `failNext`, `calls`), `fakeWords`, `FAKE_TRANSCRIPT_TEXT` |
| `src/fallback.ts` | `createFallbackTranscriber([primary, fallback])` → `FallbackTranscriber` (`transcribe`, `transcribeDetailed`), `transcribeWithEngine(transcriber, input)` |
| `src/normalize.ts` | `normalizeTranscript`, `segmentsFromWords`, `wordsFromSegments`, `normalizeLanguage` |
| `src/factory.ts` | `createTranscriberFromConfig(config, { fetch?, logger?, whisper?, assemblyai?, fake? })` |
| `src/errors.ts` | `transcriptionError`, `transcriptionErrorReason`, `shouldFallBack`, `isRetryableTranscriptionError`, `safeEngineMessage` |
| `src/shared.ts` | input schema, lazy file Blob, fetch with timeout/abort, HTTP error mapping, `TranscribeInput`, `DetailedTranscription` |

### Using it (worker `transcribe` handler)

```ts
const transcriber = createTranscriberFromConfig(config, { logger })     // chain | whisper | assemblyai | fake
const { engine, result, attempts } = await transcribeWithEngine(transcriber, { filePath, language, signal })
// engine ∈ 'whisper' | 'assemblyai' | 'fake' → transcripts.engine; result → language, duration_ms, text, words, segments
```

- `result` is `TranscriptResult` in integer ms, validated with `TranscriptResultSchema` from `@app/core/validation`. Words and segments are sorted, trimmed, `e ≥ s`; `durationMs` = max(engine-reported duration, last word/segment end); `language` is the ISO 639 primary code (`"english"`/`"en_us"` → `"en"`, `"und"` when unknown). A silent file gives an empty transcript (not an error).
- Always call `transcribeWithEngine` (works for any Transcriber) so the engine that actually answered is recorded.
- **Send audio, not video.** Extract compressed mono audio first, capped at the reserved seconds, e.g. `ffmpeg -i src -t <reservedSec> -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 48k out.mp3` (4 h ≈ 86 MB). Limits: Whisper 1 GB (`whisper.maxFileBytes`), AssemblyAI 2.2 GB; over the limit → `engine_rejected` (so the chain moves on).
- `input.language` (optional): `"en"`, `"en-US"`, `"en_us"`; Whisper gets `"en"`, AssemblyAI `"en_us"`; omitted → auto-detect.
- `input.signal` cancels (worker shutdown) → `reason: 'aborted'`, no fallback.

### Errors (all `AppError`, `details.reason` + `details.engine`)

| reason | code | fallback? | retry job later? |
| --- | --- | --- | --- |
| `input_invalid` (missing/empty file, bad language) | validation | no | no |
| `aborted` | unavailable | no | — |
| `engine_auth` (401/403: our key) | unavailable | yes | yes (alert ops) |
| `rate_limited` (429, `retryAfterSec`) | rate_limited | yes | yes |
| `engine_rejected` (other 4xx, too large) | bad_request | yes | no |
| `engine_failed` (AssemblyAI status=error, e.g. no audio) | bad_request | yes | no |
| `engine_unavailable` (network, 5xx) | unavailable | yes | yes |
| `malformed_response` (zod failed) | unavailable | yes | yes |
| `timeout` | unavailable | yes | yes |
| `all_failed` (chain exhausted; `details.attempts[]`) | last error's | — | `isRetryableTranscriptionError` |

Use `isRetryableTranscriptionError(err)` for the worker's retry/dead decision; on a final failure release the clip-seconds reservation (ARCHITECTURE). Messages are user-safe (URLs stripped, secrets scrubbed, the API key removed verbatim even if the server echoes it).

## Decisions (where ARCHITECTURE / the task were silent)

1. **Exact-length presigned PUT** (above). The port's `maxBytes` is treated as the declared size.
2. **Key prefix enforced in every driver**, not only by helpers (defence in depth; FsStorage also re-checks resolved paths stay inside its directory).
3. **Multipart added as an optional capability** (`MultipartStorage`), because R2 single PUTs stop at ~5 GB and sources may be 10 GB. `putFile` uses it transparently.
4. **R2 client:** `region: 'auto'`, path-style, `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'` (verified: without it the SDK adds `x-amz-checksum-crc32` of an empty body to presigned PUT URLs), `maxAttempts: 3`. Content-Type is signed through `signableHeaders` (verified: the presigner leaves it unsigned by default, contrary to Cloudflare's docs page).
5. **Local URLs are HMAC-signed** with `SESSION_SECRET` so dev behaves like R2 (expiry, pinned type and size) and both processes can serve each other's URLs.
6. **`WHISPER_URL`** may be the server root or end in `/v1` (config.ts describes `…/v1`; the task says `{WHISPER_URL}/v1/audio/transcriptions`): both resolve to `…/v1/audio/transcriptions`; a full `…/audio/transcriptions` URL is used as is.
7. **Whisper fallbacks inside the adapter:** words nested in segments (faster-whisper/speaches) are read; servers that return only segments get word timings spread over each segment by word length; text without any timestamps is `malformed_response` (captions need timings).
8. **AssemblyAI** (confirmed against the API reference on 2026-10-31): upload raw bytes → create with `punctuate`, `format_text`, `language_code` or `language_detection: true` (`speech_models` only if configured; the API default is used otherwise) → poll every 3 s ×1.5 up to 15 s, 60 min overall, Retry-After honoured, up to 5 consecutive transient poll failures → **DELETE the transcript afterwards** (also after errors) so user speech is not retained there. Segments are built from the punctuated words locally (no extra `/sentences` call).
9. **Fallback order** is the array order; no fallback on `input_invalid`/`aborted`; a single failed attempt rethrows the original error; several failures throw `all_failed` with the last error's code and every attempt.
10. **Fake transcript**: a ~92 s monologue (210 words, 17 sentences, several standalone hooks) with fixed timings (500 ms lead-in, 320 ms per word, 80 ms gap, +400 ms after sentence ends, 1 s tail), useful for `pick_clips`/`make_clips` in dev. `FakeTranscriber({ text | words, repeat, language, name, requireFile })`.

## Requests

1. **Lockfile / dependency (done, please keep):** both packages validate external input with zod, so `zod ^4.6.7` (already in the workspace, same version) was added to `packages/storage/package.json` and `packages/transcription/package.json`. `pnpm install --offline --lockfile-only` updated `pnpm-lock.yaml` with exactly those two importer entries **plus the already-declared `zod` of `packages/posting`**, which the lockfile was missing (a frozen install would have failed on it). `node_modules` links were created by hand, mirroring what pnpm does. No other dependency was added or changed.
2. **Web agent:** mount `/api/dev-storage/[...key]` exactly as shown above (GET, HEAD, PUT; 404 when the storage is R2). Build presigned uploads with the declared size. For sources over 5 GB use the multipart flow; the browser must read `ETag` from each part response.
3. **Worker agent:** use `createStorageFromConfig` and `createTranscriberFromConfig` once per process; call `transcribeWithEngine`; extract audio with ffmpeg before transcribing (see above); `getToFile` into `MEDIA_TMP_DIR`.
4. **Services agent:** keys only through the helpers; `presignPut(key, contentType, declaredBytes)`; in `completeUpload` require `head(key)?.bytes === declaredBytes` and an allowed content type; for the 30-day source cleanup delete `sourceKey(...)` objects by key (or ask for a top-level `sources/` prefix if a bucket lifecycle rule is preferred).

## Tests

All offline (mocked `fetch`, a `vi.fn` S3 `send`, temp directories; nothing touches the network).

- `@app/storage`: 4 files, 84 tests — key rules; a shared ObjectStorage contract run against MemoryStorage, FsStorage and R2Storage (on an in-memory S3 mock); presigned URL contents (signed headers, expiry, no checksum params, host/path); signed-URL handler (type/length/expiry/tamper/range/405/404); multipart for all drivers (uniform-part rule, ETag checks, abort); R2 error mapping without leaking secrets or raw responses; streaming downloads (web stream, SDK mixin, broken stream cleanup); factory per driver.
- `@app/transcription`: 6 files, 59 tests — normalisation (rounding, sorting, segments↔words, 60k-word input, languages); Whisper request shape, auth header, language, response variants, malformed responses (zod), HTTP error mapping, key redaction, timeout, abort, network failure, input checks; AssemblyAI upload/create/poll/delete flow, backoff, Retry-After, transient failures, overall timeout, engine error, malformed responses, abort, cleanup; fake determinism; fallback chain with fakes and with the real adapters; factory.

Also checked by hand (not in the suite): the real `fetch` streams the file-backed Blob correctly in both the Whisper multipart body and the AssemblyAI raw upload (local HTTP server).

## Gaps

- Not exercised against live R2, a live Whisper server or live AssemblyAI (no credentials here). Presigned URLs are produced by the official SDK; R2's acceptance of signed `content-length` is per SigV4 but unverified live.
- `R2Storage.putFile` cannot resume an interrupted multipart upload (it aborts and the job retries from scratch).
- No list/prefix-delete API in the port; deleting all of a user's objects needs keys from `media_assets`.
- Whisper servers that ignore `timestamp_granularities[]=word` still work (segment-spread word timings), but caption timing is then approximate.
