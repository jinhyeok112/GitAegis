FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY next.config.ts postcss.config.mjs tsconfig.json instrumentation.ts auth.ts ./
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public
COPY types ./types
RUN npm run build -- --webpack \
    && rm -rf .next/cache \
    && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SEMGREP_EXECUTABLE=/opt/semgrep/bin/semgrep \
    SCAN_PYTHON_EXECUTABLE=/opt/semgrep/bin/python

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/semgrep \
    && /opt/semgrep/bin/pip install --no-cache-dir 'semgrep==1.181.0' \
    && mkdir -p /app/.tools/scans /app/.next \
    && chown node:node /app/.tools/scans /app/.next

COPY --from=build --chown=node:node /app/.next/ ./.next/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/public/ ./public/
COPY package.json next.config.ts tsconfig.json ./
COPY scripts/db-init.mjs scripts/extract_scan_source.py ./scripts/
COPY database/schema.sql ./database/
COPY security_rules/manual.yaml ./security_rules/
COPY security_fixtures/cases.yaml ./security_fixtures/

USER node
RUN /opt/semgrep/bin/semgrep --disable-version-check --version
EXPOSE 3000
CMD ["sh", "-c", "node scripts/db-init.mjs && exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0"]
