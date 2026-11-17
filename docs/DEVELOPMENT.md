# Development

The local loop. No containers needed, no GHCR image, no GitHub repo — Node and a database file.

See also: [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the fork-and-PR loop, and
[`DEPLOYMENT.md`](DEPLOYMENT.md) if your goal is to *run* the app rather than change it.

## Once

Node **22.23.5** (any patch ≥ **22.12**) and pnpm **9.12.0** — the pair the image builds on.
Two reasons the exact patch matters: `better-sqlite3` ships a native binary tied to the Node ABI,
and `require()` of an ES module only works from 22.12 — which is what fastify's lazy
`light-my-request` load needs, and therefore what every API test needs. `apps/api/test/runtime.test.ts`
fails with a readable message if you are below the floor.

```bash
pnpm install --prefer-offline
pnpm -r build          # MUST precede the tests and `dev:api`
```

`apps/*` import `@tamilcache/*` from `packages/*/dist/`, and `dist` is git-ignored. Skip the build
and you get `Failed to load url @tamilcache/db` plus a handful of suites that look broken but are
not. After a branch switch or merge, build again — a *stale* `dist` is worse than a missing one,
because tests then pass against code that is not on disk.

In a fresh worktree, `pnpm install --prefer-offline` must precede `pnpm -r build`, or the build
fails with `tsc: command not found`.

## The loop

```bash
pnpm dev:api        # :8484 — Fastify, serves apps/web/dist, REST + Torznab
pnpm dev:worker     # the crawler: delta, backfill, replay, retention
pnpm dev:web        # only when touching the UI — vite on :5173, proxies /api → :8484
```

All three are `--watch`: `dev:api` and `dev:worker` watch the **built** `dist`, so after changing
`apps/api/src` run `pnpm --filter @tamilcache/api build` (or leave `tsc -p tsconfig.json --watch`
running in a fourth terminal). `dev:web` is real hot-reload.

- Browsing through `:8484` gives you the production shape (one server, one origin).
- Browsing through `:5173` gives you fast UI reloads; `/api` is proxied, so bootstrap and the
  generated API key work the same way.

## Which database to point at

`DB_PATH` defaults to `./data/tamilcache.db`. Three sensible choices:

| goal | do this |
|---|---|
| **UI or parser work** | copy a real database once and keep it quiet: `cp <live>/tamilcache.db ~/.local/share/tamilcache-dev/`, then `export DB_PATH=~/.local/share/tamilcache-dev/tamilcache.db` |
| **crawl work** | an empty database: `export DB_PATH=/tmp/dev.db`. `dev:worker` will immediately run the delta (~125 requests, ~4 min at 2 s) |
| **exactly reproduce a bug** | a scrubbed snapshot: `docker compose run --rm --no-deps snapshot export`, then import it (see [`SNAPSHOT.md`](SNAPSHOT.md)) |

A copy of a live database is *quieter* than an empty one: `last_delta_at` is already set, so the
delta waits for the cron instead of firing on boot, and you get 8k real topics to look at.

If you would rather run the built image against your own copy of the data, put the path in `.env`
(`.env` is gitignored) and it becomes one command:

```bash
# .env
TAMILCACHE_DATA=/home/you/.local/share/tamilcache-dev
TAMILCACHE_IMAGE=tamilcache:local
PUID=0            # rootless podman: container root is your user, so files stay yours
PGID=0
```

```bash
docker compose up -d          # or: podman compose up -d
```

**Do not** point `DB_PATH` at a container volume or at `./data` inside a cloud-synced checkout
(Seafile, Dropbox, OneDrive, NFS). SQLite in WAL mode on a sync service corrupts, and it does it
quietly. Keep dev databases on a local disk.

Two processes writing one database is normal here (that is what the deployment does too); a third
writer — a container *and* `dev:worker` on the same file — is asking for `SQLITE_BUSY` confusion.

## Everyday commands

```bash
pnpm -r build && npx vitest run && pnpm -r typecheck   # the full gate
npx vitest run                                        # all packages
cd apps/api && npx vitest run test/browse.test.ts     # one package, one file
pnpm check:leaks                                      # what CI runs first
pnpm verify                                           # DB invariants against DB_PATH, exit 1 on failure
pnpm replay                                           # re-decide every variant, then re-select
pnpm reclassify                                       # re-derive stored link kinds + topic statuses
pnpm coverage:audit                                   # compare the site's boards/pages with what we crawled
pnpm db:reset --yes                                   # wipe crawl output, keep rules/overrides/media
pnpm sanitize:fixtures                                # after capturing new fixtures
```

`db:reset` keeps `sources`, `forums`, `media`, `rules` and `overrides` — the first two are re-seeded
at boot and the last three are expensive human decisions a crawl cannot recover. It deletes topics,
variants, links, queue rows, cursors and logs.

## Isolation: one worktree per feature

```bash
git worktree add .worktrees/my-feature -b feat/my-feature master
cd .worktrees/my-feature
pnpm install --prefer-offline && pnpm -r build
```

`.worktrees/` is git-ignored. Finish by merging with `--no-ff` and removing the worktree
(`git worktree remove --force .worktrees/my-feature`), then deleting the branch.

## Before you call it done

- `pnpm -r build && npx vitest run && pnpm -r typecheck` green — bare commands, not piped through
  `grep`: a pipe hides the exit status and you will merge over a failure.
- A behavioural change has a test that failed first. If you cannot make it fail, you are testing
  something that cannot break.
- `pnpm check:leaks` clean, especially after adding a fixture.
- UI changes are checked in a browser at `:8484`, not only in jsdom — the empty state, the loading
  state and the error path are where the SPA actually breaks.

## Debugging

- **Logs are in the database**, not only stdout: `log_events` with `LOG_LEVEL=debug` and
  `LOG_DEBUG_SCOPES=http,torznab` for the noisy scopes. The Logs page reads the same table.
- **The worker's first tick** is where most "nothing happened" bugs live — `delta`, circuit breaker,
  then queue lanes, in that order (see `apps/worker/src/tick.ts`).
- **A parser disagreement** is a fixture question: `packages/shared/test/fixtures/MANIFEST.md` says
  what each page proves. If a fixture disagrees with the parser, the parser is wrong.
- **Slow queries**: `/browse` and Torznab search are the hot paths, and
  `apps/api/test/browse.test.ts` already seeds 4,000 rows with a time budget — copy that pattern
  rather than eyeballing a stopwatch.
