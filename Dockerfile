# syntax=docker/dockerfile:1.7
#
# brAIn — single-image build. Reproduces the layout `npm create brain`
# produces: brAIn (the framework, copied from the build context) +
# brAIn-store + storeprojects/<5 default sister repos>, all installed,
# built, and ready to boot. The API serves the built dashboard from the
# same port (3000), so a single `docker run -p 3000:3000` is enough.
#
# Build:
#   docker build -t brain:latest .
#
# Run (foreground):
#   docker run --rm -p 3000:3000 -p 4222:4222 \
#     -v brain-data:/app/brAIn/data \
#     -v brain-store:/app/storeprojects \
#     brain:latest
#
# Then open http://localhost:3000.

# ============ build stage ============
FROM node:20-bookworm-slim AS builder

# Toolchain for better-sqlite3 (native build) + git for sister-repo clones.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (bundled with Node 20).
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /build

# brAIn the framework (this build context). .dockerignore strips
# node_modules / dist / data / authored workspaces.
COPY . brAIn/

# brAIn-store + the 5 default-seed sister repos. Pinned to refs at
# build time for reproducibility (override via --build-arg to bake
# a specific commit).
ARG STORE_REF=main
ARG ESSENTIALS_REF=main
ARG LLM_REF=main
ARG MEMORY_REF=main
ARG TOOLS_REF=main
ARG UI_REF=main

RUN git clone --depth 1 --branch ${STORE_REF} \
        https://github.com/tibzejoker/brAIn-store.git brAIn-store

RUN mkdir -p storeprojects && cd storeprojects \
 && git clone --depth 1 --branch ${ESSENTIALS_REF} https://github.com/tibzejoker/brAIn-essentials.git \
 && git clone --depth 1 --branch ${LLM_REF}        https://github.com/tibzejoker/brAIn-llm.git \
 && git clone --depth 1 --branch ${MEMORY_REF}     https://github.com/tibzejoker/brAIn-memory.git \
 && git clone --depth 1 --branch ${TOOLS_REF}      https://github.com/tibzejoker/brAIn-tools.git \
 && git clone --depth 1 --branch ${UI_REF}         https://github.com/tibzejoker/brAIn-ui.git

# Install + build everything in the workspace (sdk, core, agent, sister
# nodes, dashboard, api). pnpm postinstall downloads the bundled
# nats-server Go binary for linux-x64. BRAIN_NO_STORE_CLONE skips the
# duplicate brAIn-store clone (we already did it).
WORKDIR /build/brAIn
ENV BRAIN_NO_STORE_CLONE=1
RUN pnpm install
RUN pnpm -r build


# ============ runtime stage ============
FROM node:20-bookworm-slim AS runtime

# git: required at runtime for `pnpm brain pull` (marketplace adds new
# nodes after the image is up). ca-certificates for HTTPS clones.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Code-authoring CLIs (claude / codex / gemini) are NOT baked here.
# OAuth flows for those CLIs are unreliable in Docker (Anthropic's
# Cloudflare challenge blocks the callback for `claude setup-token`;
# Gemini's TUI /login needs port forwarding; Codex device-auth works
# but is one CLI among three). Pinning versions in the image also
# means we'd ship security patches behind upstream.
#
# For the `developer` node's authoring flow, run brAIn natively
# (`npm create brain`) so it picks up your host CLIs directly. The
# Docker image is for headless deployment / dashboard / non-LLM
# nodes — see README "Auth in Docker" for the supported patterns
# (env var API keys, ~/.claude volume mount).

WORKDIR /app

# Copy the entire built workspace tree (sources + node_modules + dists +
# bundled nats-server binary) from the builder stage.
COPY --from=builder /build /app

WORKDIR /app/brAIn

ENV NODE_ENV=production \
    API_PORT=3000 \
    BRAIN_DASHBOARD_DIR=/app/brAIn/packages/dashboard/dist \
    BRAIN_NO_STORE_CLONE=1

# Persistent volumes:
#   /app/brAIn/data    — SQLite DB + broker prefs (survives container restart)
#   /app/storeprojects — runtime-pulled sister repos via the marketplace
VOLUME ["/app/brAIn/data", "/app/storeprojects"]

# 3000: REST + WebSocket + dashboard (single port).
# 4222: embedded NATS broker for remote brain-agent / brAIn-mobile.
EXPOSE 3000 4222

CMD ["node", "packages/api/dist/main.js"]
