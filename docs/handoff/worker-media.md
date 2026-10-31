# Worker handoff: media handlers (`apps/worker/src/media/**`)

Owner: worker-media agent. `mediaHandlers` (and `createMediaHandlers(options)`) are exported from
`apps/worker/src/media/index.ts`. Requests for other owners are at the end.

## What exists

| Path | What |
| --- | --- |
| `index.ts` | `mediaHandlers` = `createMediaHandlers()`: `source_ingest`, `transcribe`, `clip_render`, `carousel_render`, `video_render`. `createMediaHandlers({ fetch, renderer, streamSources, download, timeouts })` for tests/tooling |
| `source-ingest.ts` | drive link: core `checkSourceUrl` again → direct-download URL → guarded download → stored at the row's `sources/` key. Upload: copied from storage; **clip sources are promoted to `sourceKey(u, mediaId, ext)`** and the `uploads/` object deleted (a still-valid presigned PUT can no longer swap the file). ffprobe (allowed container, video stream for videos, audio for audio, ≤ 4 h, ≤ 10 GB), sha256 → `media.markIngested` (ready, one reservation per source, link nulled, `transcribe` queued) |
| `transcribe.ts` | 16 kHz mono MP3 (32 kbit/s) via ffmpeg → `transcribeWithEngine(ctx.transcriber)` (Whisper → AssemblyAI chain) → `transcripts.save` (settles). Final failure → `transcripts.fail` (releases) + dead job |
| `clip-render.ts` | `clips.startRender` → ffmpeg (accurate `-ss` cut, 1080×1920, ASS captions, H.264 High + AAC 48 kHz, faststart, metadata stripped) → output re-probed (1080×1920, audio, duration) → `storage.putFile(clipKey)` → `clips.completeRender` (output media + **draft**, never a post). Final failure → `clips.failRender` |
| `renders.ts` | `carousel_render` (PNG slides at `RENDER_SIZES[aspect]`, default 1080×1350) and `video_render` (cards → MP4 slideshow with crossfades, default 1080×1920, optional background audio) → `renders.recordOutputs` → draft (adapter below). Result `{ mediaIds, draftId, platforms, draftReason?, durationMs? }` |
| `captions.ts` | words → ASS: lines of 2–4 words (break at sentence ends, pauses > 600 ms, char budget), one event per word for the highlight; styles `bold` (current word yellow, 108 %), `karaoke` (spoken words green), `minimal` (boxed lines), `none`. Safe margins L110 R150 bottom 540 (clear of TikTok/Reels UI). Font `Noto Sans` (image fonts; fontconfig falls back to DejaVu) |
| `ffmpeg.ts` | Pure arg builders: `clipRenderArgs`, `clipFilterGraph` (crop for landscape / ~9:16; blurred fill for portrait, square, narrow), `extractAudioArgs`, `slideshowPlan` |
| `drive.ts` | `directDownloadUrl` (Drive → `drive.usercontent.google.com/download?id=…&confirm=t`, Dropbox → `dl=1`, OneDrive → `api.onedrive.com/v1.0/shares/u!…/root/content`; folders / Google Docs refused), `downloadDriveFile` (manual redirects ≤ `MAX_REDIRECT_HOPS`, each hop `isAllowedDownloadHop`, HTML pages refused, byte cap, overall + idle timeout, streamed sha256) |
| `probe.ts` | ffprobe JSON → duration, display size (rotation applied), fps, codecs, mime; **container allowlist** (mov/mp4, matroska/webm, avi, mpegts, mp3, wav, ogg, aac, flac); later runs force that demuxer (`-f`), inputs get `-protocol_whitelist file` (or `https,tls,tcp`) so playlists/concat files cannot pull other files or URLs |
| `process.ts` | `runTool`: `spawn` with an args array (never a shell), minimal env (no DB URL / API keys), SIGKILL on abort (→ `JobAbortedError`) or timeout, bounded stderr tail (never logged or returned: may contain presigned URLs) |
| `source.ts` | `withStoredSource`: R2 sources are **streamed** through a 6 h presigned URL (ffmpeg seeks with range requests: a clip of a 4 h source reads MBs, not 10 GB); local/memory storage, or any streaming failure, falls back to downloading into the job's temp dir |
| `renderer.ts` | playwright-core Chromium: `CHROMIUM_PATH` (config, env) → playwright-core's own browser (`PLAYWRIGHT_BROWSERS_PATH`, `/ms-playwright` in the image) → `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` (sandbox). JavaScript disabled, network blocked (only `data:` images), minimal env |
| `templates.ts` | Carousel templates `minimal`, `bold`, `quote`, `list`, `photo`; video cards `text_slides`, `quote`, `captioned_images`; theme colours re-checked, all text escaped, font presets → system font stacks |
| `adapters.ts` | Local stand-ins for missing service functions (Requests 1–2) |
| `options.ts` | Defaults (timeouts: probe 2 min, audio 90 min, clip 30 min, slideshow segment 5 min, final video 30 min; download 3 h / idle 2 min / 10 GB), `isRetryableMediaError`, `isFinalAttempt` |
| `files.ts` | `withTempDir` (per-job dir under `MEDIA_TMP_DIR`, removed in `finally`), `hashFile`, `pngSize` |
| `__tests__/*.test.ts` | 62 tests (below) |

## Behaviour notes

- **Failures.** User-caused refusals (bad link, folder, private file, not a video, > 4 h, unreadable) mark the
  media failed with a safe message and **complete** the job with `{ status: 'failed', error }` (services' contract).
  Temporary problems (network, 5xx/429, timeouts, storage/engine outages, missing ffmpeg) throw so the runner
  retries; on the last attempt the media/clip is failed and usage released first. After `ctx.signal` aborts
  nothing is failed or refunded (`JobAbortedError`: the runner releases the job).
- **Metering** is only through services: `markIngested` reserves once per source (idempotent key), `transcripts.save`
  settles, `transcripts.fail` / `media.markFailed` release. A source with no audio track fails transcription with
  "This video has no sound…" and is refunded.
- **Drafts only.** Clip drafts come from `clips.completeRender`; render drafts from `drafts.create(…, { via: 'worker' })`
  with one variant per active account whose platform takes the media (pre-checked with core `validateVariant`;
  platforms that would fail are skipped). No accounts → no draft (`draftReason: 'no_accounts'`); a refused draft
  (brand archived, account held) keeps the media (`draftReason: 'draft_refused'`). Retries reuse the same draft and
  the same output keys (`uuidV5(job.id …)`).
- **Template video memory.** One ffmpeg xfade chain over N looped images buffered ~75 MB per slide (1.5 GB for
  20 slides), so videos are rendered slide by slide (each segment crossfades in from the previous card, frame counts
  taken from the cumulative timeline) and joined with the concat demuxer in a final encode. Memory is flat.
- **Captions** need the transcript words that `clips.startRender` returns (clip-relative). `captionStyle: 'none'` or
  no words → no subtitles filter.

## For the MCP agent (`render_carousel` / `render_video`)

The worker now **creates the draft** for renders and puts `draftId` in the job result (`jobs.get(u, jobId).result`).
Tell the AI to use that draft (`drafts.updateVariant` / approval card) instead of creating a second one with the
media ids. `draftId` is null when the brand has no connected account that takes the media.

## Verified / not verified

- `pnpm -F @app/worker typecheck` clean; `pnpm -F @app/worker test`: 9 files, 124 tests (62 media). Boundary lint passes.
- Real ffmpeg on fixtures generated at test time (testsrc + sine; landscape 640×360, portrait 480×640, silent,
  MP3, PNG, text): upload ingest (probe/sha/promotion/reservation/idempotency), post videos not metered, non-video and
  non-media refused, services refusal (no clipping time), missing upload; drive links with mocked fetch (allowed
  redirect chain, YouTube row refused without fetching, redirect to a foreign host / YouTube refused, non-video,
  503 retry then final failure); transcribe (settle, permanent failure refund, outage retry then refund, no sound,
  streaming fallback without leaking the presigned URL); clip render (1080×1920 H.264/AAC, duration, draft for
  TikTok+Instagram and not for a `needs_reauth` account, no posts, idempotent, blurred portrait, silent source gets a
  silent AAC track, abort leaves the clip rendering, missing source → clip failed); real Chromium carousels (1080×1350
  and 1:1 PNGs, photo variants for Instagram/X but not YouTube, retry reuses outputs and draft); template videos
  (duration, 9:16 and 16:9, background audio, deleted audio refused, real Chromium cards); runner drain
  upload → ingest → transcribe → clip → draft.
- **Not verified:** streaming from real R2 presigned URLs (the code path runs in tests only up to its fallback);
  real Google Drive / Dropbox / OneDrive redirect chains (documented [U] in the plan; record fixtures when testing
  with real links — the OneDrive shares API in particular may need auth for some accounts); caption rendering with
  the image's Noto fonts (tested here with fontconfig's DejaVu fallback); performance on Railway CPUs.

## Requests

1. **Services (media):** let the ingest result move a clip-source upload to its immutable key, e.g.
   `markIngested(u, id, { …, storageKey })` accepting only `sourceKey(u, id, ext)` for a pending upload, or
   `media.promoteSource(u, id, toKey)`. The worker does it with one scoped SQL `update … where id, user_id,
   storage_key = old, status = 'pending'` (`movePendingMediaKey` in `adapters.ts`) meanwhile. Post videos stay under
   `uploads/` (their presigned PUT stays valid for `uploadUrlTtlSec`): consider promoting them too (another key area).
2. **Services (renders):** `renders.recordOutputs` (or a `renders.createDraft`) should create the render draft like
   `clips.completeRender` does (variants for active accounts that accept the media, `created_via worker`).
   `createRenderDraft` in `adapters.ts` does it through `drafts.list` + `accounts.list` + `drafts.create` meanwhile.
3. **Storage (`ObjectStorage`):** add `copy(fromKey, toKey)` (S3 `CopyObject`, multipart copy above 5 GB) so promoting
   an upload does not re-upload up to 10 GB from the worker.
4. **Worker Dockerfile owner:** font presets `rounded` and `condensed` have no matching font in the image (they fall
   back to Noto Sans); add e.g. `fonts-noto-extra` (Noto Sans Condensed) and a rounded family if wanted. The image needs
   ffmpeg with `libass`, `libx264`, `libmp3lame` (Ubuntu's ffmpeg has them).
5. **Core (platform rules):** Instagram accepts JPEG images only and Bluesky 1 MB per image (platform-limits.md), but
   `validateVariant` checks neither mime type nor (for Bluesky) the Upload-Post size; carousels are PNG (as specified).
   Either add the rules (the worker then needs a JPEG option) or confirm Upload-Post converts.
6. **Product/services:** videos without an audio track cannot be clipped today (transcription fails and refunds).
   If captionless clips of silent videos are wanted, allow an empty transcript (engine e.g. `none`).
7. **Dependencies:** zod is not a worker dependency, so ffprobe output is parsed with hand-written guards; job payloads
   still go through services' zod schemas (`parseJobPayload`).
