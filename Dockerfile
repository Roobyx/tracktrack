# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# tracktrack multi-stage image
#
# One Dockerfile builds the deployable unit; docker-compose.yml selects the
# target:
#
#   tracktrack-runtime  TrackTrack API server + standalone web GUI + MCP over
#                       HTTP, supervised in one container by
#                       server/entrypoint.ts
#
# Node 24 is required: track-service uses node:sqlite and the runtime relies on
# tsx to execute raw .ts sources.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_IMAGE=node:24-alpine

# ── deps: install the pnpm workspace behind a cacheable layer ───────────────
FROM ${NODE_IMAGE} AS deps
# Keep in sync with `packageManager` in package.json
ARG PNPM_VERSION=11.24.0
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/track-service/package.json packages/track-service/
COPY apps/tracktrack/package.json apps/tracktrack/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── source: full repository (dev clutter is trimmed via .dockerignore) ──────
FROM deps AS source
COPY . .
# Runtime services receive configuration via environment variables, not files;
# create an empty .env so dotenv/config loaders stay quiet inside containers.
RUN touch /app/.env

# ── tracktrack-runtime: Node supervisor running API + web GUI + MCP HTTP ────
FROM source AS tracktrack-runtime
# Builds the web GUI into dist/ so the web server can serve it.
RUN pnpm --filter tracktrack build
ENV NODE_ENV=production \
    TRACKTRACK_DATA_DIR=/data
RUN mkdir -p /data \
    && chown -R node:node /data \
    && ln -s /data/.tracktrack-bootstrap /app/apps/tracktrack/.tracktrack-bootstrap
USER node
WORKDIR /app/apps/tracktrack
EXPOSE 4356 4357 4358
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.TRACKTRACK_PORT||4356)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
# Supervisor: API server (TRACKTRACK_PORT), web GUI (TRACKTRACK_WEB_PORT) and
# MCP over HTTP (TRACKTRACK_MCP_PORT). If any of them dies the container exits
# so the compose restart policy brings the whole stack back.
CMD ["node", "--import", "tsx/esm", "server/entrypoint.ts"]
