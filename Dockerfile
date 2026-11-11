# syntax=docker/dockerfile:1

# Same Node release as the openGym API image.
FROM node:22.23.4-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY vendor ./vendor
COPY src ./src

# The build fails unless the test suite passes. Nothing from this stage is shipped.
FROM base AS test
COPY test ./test
RUN npm test

FROM base AS runtime
# Tie the runtime image to the test stage so BuildKit cannot skip it.
COPY --from=test /app/package.json /tmp/tested
COPY LICENSE README.md ./
RUN rm /tmp/tested \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /data && chown node:node /data

ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="opengym-mcp" \
      org.opencontainers.image.description="Remote MCP server for openGym: lets AI assistants read and edit a paired openGym profile over OAuth." \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV PORT=8082 DATA_DIR=/data
USER node
VOLUME /data
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:${PORT}/healthz" || exit 1
# Node runs the TypeScript sources directly by stripping their types; there is no build step.
CMD ["node", "src/server.ts"]
