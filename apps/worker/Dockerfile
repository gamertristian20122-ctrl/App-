# syntax=docker/dockerfile:1.7
#
# Railway worker image. One image, two Railway services (see railway.toml):
#   posting  WORKER_TYPES=posting  publish_post, check_post_status, analytics_pull, import_past_posts, cleanup
#   media    WORKER_TYPES=media    source_ingest, transcribe, clip_render, carousel_render, video_render
#
# Build from the repository root (Railway: Dockerfile path apps/worker/Dockerfile, root directory /):
#   docker build -f apps/worker/Dockerfile -t app-worker .
#
# Base: the official Playwright image for the exact playwright-core version in apps/worker/package.json
# (1.63.0). It ships Node.js, the matching Chromium build under /ms-playwright and its system libraries.
# We add ffmpeg (clips, template videos), caption fonts and tini (reaps Chromium's child processes).

ARG PLAYWRIGHT_VERSION=1.63.0

# ---------------------------------------------------------------------------------------------
# deps: install only the worker and its workspace packages, production dependencies only
# ---------------------------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/pnpm/store
RUN corepack enable
WORKDIR /app

# The worker's workspace packages, plus every other workspace manifest so the frozen lockfile matches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY apps/web/package.json ./apps/web/package.json

RUN pnpm install --frozen-lockfile --prod --filter "@app/worker..."

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      tini \
      fontconfig \
      fonts-noto-core \
      fonts-noto-mono \
      fonts-noto-color-emoji \
      fonts-dejavu-core \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    MEDIA_TMP_DIR=/tmp/worker-media \
    WORKER_TYPES=all

# Application code stays owned by root (read-only for the worker user).
COPY --from=deps /app /app

# Non-root user that ships with the Playwright image; scratch space under /tmp.
RUN mkdir -p /tmp/worker-media && chown pwuser:pwuser /tmp/worker-media
USER pwuser
WORKDIR /app/apps/worker

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/main.ts"]
