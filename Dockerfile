# Node base image is pinned to an exact patch on purpose, for two reasons:
#  1. better-sqlite3 ships a prebuilt native binary tied to the Node ABI; a floating `node:22-slim`
#     tag can move that ABI between rebuilds and break the image with ERR_DLOPEN_FAILED at boot.
#     Any patch within 22.x keeps ABI 127, so 22.23.5 is safe.
#  2. The floor is Node 22.12: `require()` of an ES module is only supported from that version, and
#     light-my-request (which fastify loads lazily for `inject`, i.e. in every API test) `require`s
#     the ESM-only `cookie@2`. On 22.11 that throws ERR_REQUIRE_ESM and 149 tests fail.
FROM node:22.23.5-slim AS base
# `corepack enable` breaks on this base image: its bundled keyring cannot verify the current
# pnpm release signature ("Cannot find matching keyid"). Installing the exact pinned version
# from npm is equivalent for our purposes and does not depend on corepack's key update cadence.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9.12.0
WORKDIR /app

FROM base AS deps
# The lockfile MUST be copied here. `pnpm install --frozen-lockfile` aborts with
# ERR_PNPM_NO_LOCKFILE when pnpm-lock.yaml is absent from the build context.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app ./
# Drops to PUID:PGID after fixing /data ownership — see docker/entrypoint.sh.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 8484
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/api/dist/index.js"]
