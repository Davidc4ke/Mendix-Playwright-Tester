### Zoniq Test Runner — Standalone Server
###
### Runs the Express API + Playwright execution engine without Electron.
### Designed for Railway / any container platform.
###
### The Microsoft Playwright base image already includes Node.js 20+ and all
### Chromium system dependencies (libgbm, libnss3, etc.).

FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Install dependencies first to maximise layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy application source
COPY src ./src
COPY lib ./lib
COPY agents ./agents
COPY helpers ./helpers
COPY settings.js ./

# Persistent data (mounted as a Railway Volume in production — must be writable
# by the runtime user; Railway mounts the volume as root at runtime, so we run
# as root here. Single-tenant container, isolated by Railway, so the trade-off
# is acceptable. Add a non-root entrypoint in a later hardening pass.
ENV DATA_DIR=/data
RUN mkdir -p /data

# Cloud runs are headless by default
ENV ZONIQ_HEADED=false

# Default port (Railway sets PORT automatically)
ENV PORT=3100
EXPOSE 3100

CMD ["node", "src/server/index.js"]
