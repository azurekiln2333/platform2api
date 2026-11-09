# syntax=docker/dockerfile:1
ARG NODE_VERSION=24-bookworm-slim
FROM node:${NODE_VERSION} AS console

WORKDIR /build
COPY web/ ./web/
# A source checkout builds the console; an already-built tree is reused as is.
RUN if [ -f web/package-lock.json ]; then \
      npm ci --prefix web && npm run build --prefix web; \
    else \
      test -f web/dist/index.html; \
    fi

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PLATFORM_HOST=0.0.0.0 \
    PLATFORM_PORT=9000 \
    PLATFORM_DATA_DIR=/app/data

COPY package.json ./
COPY src/ ./src/
COPY --from=console /build/web/dist/ ./web/dist/

EXPOSE 9000
# /health performs no session check, so it also works as a liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:9000/health', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.mjs"]
