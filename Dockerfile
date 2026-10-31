# Tably Team · single service for Railway: the API serves the built frontend, runs Claude Code / Codex for the users
# (each with their own subscription token) and keeps everything under /data: attach a Railway Volume mounted at /data in the
# service settings (no VOLUME instruction here: Railway rejects Dockerfiles that declare one).
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
# the «Anuncios» gallery plays the ad composition that lives with the renderer (vite alias @ads → ../backend/video/src)
COPY backend/video/src /backend/video/src
RUN npm run build

FROM python:3.12-slim-bookworm
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
# node (for the agents, builds and Expo/Vite projects), git (own repos), chromium (reference captures), ffmpeg (the Ad Studio)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git chromium ffmpeg zip unzip \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code @openai/codex pnpm @railway/cli \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# the ads' video engine (Remotion, backend/video): its packages, its own headless Chrome and the composition bundled once
WORKDIR /app/backend/video
COPY backend/video/package*.json ./
RUN npm ci --no-audit --no-fund && node -e "require('@remotion/renderer').ensureBrowser().then(() => console.log('remotion chrome ok'))"
COPY backend/video/src ./src
COPY backend/video/render.mjs ./
RUN npx remotion bundle src/index.ts --out-dir build
# betterleaks: before publishing, Tably looks for keys written in the apps' code (see app/leaks.py); pinned and checked
ARG BETTERLEAKS=1.9.0
ARG BETTERLEAKS_SHA256=f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7
RUN curl -fsSL -o /tmp/bl.tgz https://github.com/betterleaks/betterleaks/releases/download/v${BETTERLEAKS}/betterleaks_${BETTERLEAKS}_linux_x64.tar.gz \
    && echo "${BETTERLEAKS_SHA256}  /tmp/bl.tgz" | sha256sum -c - && tar -xzf /tmp/bl.tgz -C /usr/local/bin betterleaks && rm /tmp/bl.tgz && betterleaks version
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock* ./
RUN uv sync --no-dev --frozen 2>/dev/null || uv sync --no-dev
COPY backend/app ./app
COPY backend/content ./content
COPY --from=web /web/dist /app/frontend/dist
ENV ARENA_DATA_DIR=/data/sessions ARENA_STATIC_DIR=/app/frontend/dist ARENA_CHROME=/usr/bin/chromium \
    CLAUDE_CONFIG_DIR=/data/claude-root HOME=/data/home PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "mkdir -p /data/home /data/claude-root && uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
