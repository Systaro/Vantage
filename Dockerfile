# Hub and worker: one image, two commands.
#   hub:     bun run src/hub/index.tsx      (port 7100)
#   worker:  bun run src/hub/worker.ts      (no port)
#   migrate: bun run src/shared/migrate-cli.ts hub
# Ops has its own image (Dockerfile.ops) because it needs Ansible and SSH, which the
# internet-facing hub must not carry.
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.json ./
COPY src/shared src/shared
COPY src/hub src/hub
COPY public public
COPY scripts/create-admin.ts scripts/create-admin.ts
COPY scripts/kuma-import.ts scripts/kuma-import.ts
COPY scripts/set-integration.ts scripts/set-integration.ts
COPY scripts/kuma scripts/kuma
RUN mkdir -p /data/storage && chown bun:bun /data/storage
ENV STORAGE_DIR=/data/storage
USER bun
EXPOSE 7100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7100/healthz >/dev/null || exit 1
CMD ["bun", "run", "src/hub/index.tsx"]
