# TamilCache

A local, single-user Torznab indexer that caches every **Hindi-audio** release variant posted on
TamilMV (TamilRockers' sister site), plus a React UI for browsing them, chasing the non-magnet
download paths by hand, and teaching the classifier what counts as Hindi.

It is not a downloader, a tracker, or a scraper-as-a-service. It stores metadata, links and
infohashes — no media — for a personal library on localhost. What you index and download is your
responsibility, and the upstream site's own terms and your local law apply. Nothing in this
repository is a download link: every test fixture has been sanitized, and the crawler fills its
database from the site itself on first run.

## Which loop are you in?

| you want to | start here |
|---|---|
| **run** it — one command, or on Unraid | the Quickstart below, then [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| **change** it — parser, UI, crawler | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — Node and a database file, no containers |
| **contribute** a change back | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| **move** a database between installs | [`docs/SNAPSHOT.md`](docs/SNAPSHOT.md) |

## Quickstart

```bash
git clone https://github.com/electr0de/tamilcache.git
cd tamilcache
docker compose up -d
```

Open <http://localhost:8484>. That is the whole install: the image is pulled, the database is
created and migrated, the API key is generated, and the SPA configures itself. No `.env` required,
nothing to type, no database step.

**No API key to invent.** On first start the app generates a 48-character key, stores it in the
database, shows it on the **Settings** page and logs it once (`docker compose logs api`). The SPA
fetches it through `/api/v1/bootstrap`, so opening the UI on `http://localhost:8484` or
`http://<lan-ip>:8484` needs zero configuration. `TORZNAB_API_KEY` pins your own value instead.

### Unraid

Put this file in a Compose project directory — e.g.
`/mnt/user/appdata/compose.manager/projects/tamilcache/docker-compose.yml` — and start it. Data
lands in `…/tamilcache/data`, owned by `99:100` (`nobody:users`) automatically.

**The appdata share must be `Cache: Only`.** SQLite runs in WAL mode, and WAL on a volume where
files move between array disks (shfs) corrupts the database. Full walkthrough, backup/restore and
troubleshooting: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Updating and backup

```bash
docker compose pull && docker compose up -d     # update
docker compose run --rm --no-deps snapshot export   # backup → data/backups/
```

Schema upgrades run automatically on start; a database written by a **newer** build is refused
rather than corrupted. Restore and the full story: [`docs/SNAPSHOT.md`](docs/SNAPSHOT.md).

## First run, in order

| when | what happens |
|---|---|
| immediately | API is live on `:8484`, Torznab answers, SPA served. Empty database. |
| +seconds | worker sees no `last_delta_at` and runs the **delta** job: the three home-page sections + page 1 of every in-scope forum (~125 requests, ~4 min at 2 s/request) |
| +~4 min | those releases are searchable; the review queue holds the ambiguous ones |
| you | Dashboard → **Start backfill** when you are ready (it starts paused on purpose) |
| days | the backfill walks ~22k topic pages newest-first, resumably |
| nightly 03:00 | delta runs again, forever |

Nothing waits for the cache to be full. The indexer is usable from the first minute; it just knows
about less.

## Why it exists

TamilMV has no language filter, no API, rotating domains, and inconsistent tagging: `hindi`
appears in 91 of 169 sampled titles, `hin` in 1, `hind` in 0, and sometimes the language is only
stated inside a quality block. Roughly a third of blocks name no resolution at all. None of the
terms map cleanly onto what Radarr parses, and an unmatched source token makes a release invisible
to Radarr forever.

So this project does four things the site and generic indexers cannot:

1. **Filters per quality block, not per topic** — one topic often carries Hindi, Tamil and Telugu
   variants, each with its own magnet.
2. **Caches** so search is instant and the site is hit about 125 times a day instead of on every
   Radarr poll.
3. **Re-serialises titles** into names Radarr can actually parse, verified against Radarr's own
   `QualityParser` regexes in the test suite.
4. **Surfaces the human paths** — GDrive gates, shorteners, streams, `.torrent` attachments — with
   a UI to review, teach and upload.

## Adding it to Radarr / Sonarr

Settings → Indexers → Add → **Torznab**:

- URL: `http://localhost:8484/api/v1` (from another machine or container: `http://<lan-ip>:8484/api/v1`)
- The app answers the `/api` suffix Radarr appends (`{url}/api?t=caps`), so the URL above is used
  exactly as typed.
- API key: copy it from the app's **Settings** page (the app generated it; nobody typed it)
- Categories: `2040` (Movies/SD), `5030` (TV/HD)

A full click-by-click checklist, including what "correct" looks like, is in
[`docs/verify/radarr-sonarr.md`](docs/verify/radarr-sonarr.md).

## What gets cached

**Only 1080p and above**, and only **one variant per resolution** is handed to Radarr/Sonarr:

| resolution | rule | why |
|---|---|---|
| 1080p | keep the **largest** file | at that resolution a bigger encode is the better encode |
| 4K / 2160p | keep the **smallest** file | two 2160p encodes of the same film look the same; the smaller one is cheaper |
| 1440p | keep the largest | same logic as 1080p |

The choice is per **(title, resolution)**, across every board the film was posted in — not per post.
When two releases tie on the size rule the one with more views wins, then the newer one; view counts
are read from the listing page on every crawl.

Everything below 1080p is dropped at persist time, so it never consumes a Torznab slot or review
attention. Measured on the fixture set: **7 of 29 parsed variants survive (24%)** — the rest are
720p/480p encodes and the resolution-less "Rips" tier. A post whose releases were *all* below the
floor keeps its topic row with status `below_floor`: that is a floor decision, not a parser failure,
and it is not part of the review backlog.

A block whose header omits its resolution is resolved from the topic's summary line
(`[1080p & 720p - … - 2.8GB - 1.4GB & 950MB]`) only when that size maps to exactly one resolution.
No match ⇒ dropped, never guessed.

An unrecognised **source** token is different: the block is kept and stored as `UNKNOWN_SOURCE` with
an unknown decision, so it waits in the review queue instead of disappearing with its magnet. The
site invents spellings (`TVRip`, `HQ PRE-HD`, the `HQ HDRp` typo); the alternative was silent loss.

## What is stored but not served

A topic with no servable variant is still kept, because that is what a human needs to act on:

| status | meaning | where it goes |
|---|---|---|
| `external` | no magnet or `.torrent`, but a real shortener / stream / Drive link | **Unresolved** — solve the gate or open the post |
| `no_link` | only site chrome (player banner, Telegram invite) | browsable, no action |
| `below_floor` | releases parsed, all under 1080p | not a task |
| `gone` | the topic is a 404/410 upstream | **Dead links** — with a recheck |
| `parse_failed` | a download is on the page and the parser missed it | counted, retried, never dead-lettered |

`/unresolved` is paged and searchable (`?status=&q=&forum=&page=&limit=`), returns
`{ rows, total, page, pages, counts }`, and is the only screen that starts from `topics` rather than
`variants`. A human can paste a magnet there (`POST /api/v1/topics/:id/magnet`, with the resolution
and size the feed needs to rank it), which turns the post into a servable variant.

Non-preferred variants are still stored as **alternatives** — visible in Browse when you toggle
`best per resolution` off, and to clients via `?alternatives=1`.

## TMDB provider pass

With `TMDB_API_KEY` set, the worker resolves each crawled topic against TMDB **before** replay, so
the classifier's provider branch has data to read:

| what | how |
|---|---|
| search | `/search/multi` once per `(query, year)`, cached forever in `metadata_cache` |
| query | from the topic slug (`panthadikkaam-2026-s01-…` → `panthadikkaam`, 2026), not the block header |
| accept | score ≥ 70 **and** ≥ 10 points clear of the runner-up |
| reject | `ambiguous` (proposal stored, one-click bind in Review) or `none` |
| episodes | `/tv/{id}/season/{n}` for shows → coverage + missing list in the title view |

Scoring is title similarity (exact 60 / prefix 40 / contains 30 / word overlap 10–20) + year
(exact 25, ±1 10) + media type 10 + regional language 5 + a capped popularity tiebreak. A candidate
more than a year off is rejected outright — otherwise `Scene` (2026) binds to `Scene.` (2006) on an
exact-title match.

This is what makes `hindi_original` work: `Ramayana` (2026) matches *Ramayana: Rise of a Legend* on
prefix + year + `hi`, so the release is labelled Hindi-original instead of being guessed at.

Two honest limits:

- **`tvdbid` is not advertised in caps.** TMDB's `external_ids` returns `null` for almost every
  regional show and TVMaze does not know them either, so we could receive a filter we cannot
  satisfy — which silently returns zero results. Sonarr searches by `q` + `season`/`ep` instead. A
  `tvdbid` parameter is accepted and ignored.
- **`external_ids` is best-effort.** It 502s on its own; a failure costs the imdb/tvdb hint, not the
  match.

## Optional metadata providers (OMDb, TVDB)

TMDB is the only provider the worker calls automatically. OMDb and TVDB are **manual-only
fallbacks** for a title TMDB does not have — the worker never touches either, and both are hidden in
the review queue until a key is set.

- **OMDb** answers a hand-typed search and every call spends one of 1,000 free daily requests. The
  review panel says so before it will search, and the count is stored in the database so an API
  restart cannot reset the budget. A hit is bound by IMDb id: if TMDB maps that id to exactly one
  title, the normal attach path runs and TMDB stays authoritative; otherwise the title is stored
  under its IMDb id with a negative `tmdb_id` sentinel that is never emitted to Prowlarr, Sonarr or
  Radarr.
- **TVDB** is shows-only: the panel appears on a `tv` row and, on an explicit click, fetches the
  series detail — original language, country, seasons, episode count and aliases. It also supplies
  the identity: when TVDB links a TMDB id the hit is bound through the normal TMDB path (positive
  `tmdb_id`, episodes imported by the usual replay); when it links only an IMDb id the manual attach
  runs; with neither, the panel offers no attach control and says why. Free keys are issued to
  individuals; **attribution to TheTVDB.com is a licence term**, so the panel links back on every
  render. Its name search is weak for regional serials — a Tamil query can return an unrelated show
  — which is why the identity route matters more than the search box.
- A trailer, a song or an audio-launch post is classified `other` and is skipped by the provider
  ladder entirely — it is not a title to match.

## Teaching it

The classifier is ordered and pure: **override → rule → provider → audio token → unknown**.
Anything it cannot decide lands in the review queue with a reason (`NO_AUDIO_TAG`,
`NO_PROVIDER_MATCH`, `AMBIGUOUS_TITLE`, `UNKNOWN_SOURCE`) and is **never** sent to Radarr.

1. Open **Review**. Rows are grouped by reason with the evidence attached.
2. Select rows → *apply to all similar* → **preview** (shows how many rows would change) →
   **commit + replay**.
3. Matching rows are reclassified retroactively; the whole table is replayed idempotently.
4. **Rules** lists what you taught; disable, promote or delete any rule and the table replays.

## Configuration

Every value lives in the environment (see `.env.example`); the compose file defaults each one, so
`.env` is optional.

| var | default | meaning |
|---|---|---|
| `TAMILCACHE_PORT` | `8484` | host port. The container always listens on 8484 internally |
| `TAMILCACHE_DATA` | `./data` | host directory for the database, uploads and backups |
| `TAMILCACHE_IMAGE` | `ghcr.io/electr0de/tamilcache:latest` | image to run; pin a `sha-` or semver tag |
| `PUID` / `PGID` | `99` / `100` | owner of the files in `TAMILCACHE_DATA` (Unraid `nobody:users`) |
| `UMASK` | `002` | file mode for new files |
| `TZ` | `UTC` | container timezone; `DELTA_CRON` is a local-time spec |
| `HOST` | `127.0.0.1` (`0.0.0.0` in compose) | listen address — see exposure below |
| `DB_PATH` | `./data/tamilcache.db` (`/data/…` in compose) | SQLite file; must be on a **local** disk |
| `DATA_DIR` | `./data` (`/data` in compose) | uploaded `.torrent` files and backups |
| `TMDB_API_KEY` | empty | enables Hindi-original detection + episode coverage |
| `OMDB_API_KEY` | empty | optional: manual OMDb search in the review queue (1,000 free calls/day) |
| `TVDB_API_KEY` / `TVDB_PIN` | empty | optional: TVDB series detail in the review queue (shows only). Attribution required |
| `TORZNAB_API_KEY` | empty | leave blank to have one generated and stored |
| `CRAWL_DELAY_MS` | `2000` | global gap between outbound requests |
| `DELTA_CRON` | `0 3 * * *` | when the nightly delta fires |
| `BACKFILL_PAGES_PER_TICK` | `2` | listing pages fetched per backfill tick |
| `BEST_VARIANT_ONLY` | `false` | collapse the Torznab feed to one row per title |
| `MIRRORS` | the five 1tamilmv hosts | ordered failover list |
| `SELF_ORIGIN` | `http://localhost:$PORT` | absolute URLs inside the Torznab feed |
| `FORUMS_CONFIG` | `config/forums.json` | scope allowlist |
| `LOG_LEVEL` | `info` | minimum level written to `log_events` (and pino) |
| `LOG_DEBUG_SCOPES` | empty | comma-separated scopes (`http,torznab`) that keep `debug` rows |
| `LOG_KEEP_DAYS` | `14` | how long `diag` log rows are kept; `audit` rows are never pruned |

## Exposure and access

| setting | default | meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | the API only listens on loopback. Set `0.0.0.0` to reach it from another machine/container — that also exposes the review queue, crawl controls and torrent upload to anything that can reach the port. |
| `ALLOW_BOOTSTRAP` | unset (validated) | unset/`true` = the SPA fetches the generated key; `false` = never hand it out. |
| `TORZNAB_API_KEY` | empty | pins your own key instead of the generated one. |

The compose file sets `HOST=0.0.0.0` and leaves bootstrap at its validated default, so the SPA
configures itself when you open it at `http://<lan-ip>:8484`.

Bootstrap trust is established by things a browser cannot forge — `Sec-Fetch-Site`, `Origin`, and a
`Host` rule that rejects dotted domains unless they are in `TRUSTED_HOSTS` (DNS rebinding needs a
domain). **Residual risk, stated once:** a script such as `curl` on your LAN can send any header it
likes and therefore read the key. That is accepted: the app is LAN-only and the catalogue is public
metadata. If that is unacceptable, set `ALLOW_BOOTSTRAP=false` and copy the key from the logs.

## Operational notes

- **Politeness is enforced centrally**: `CRAWL_DELAY_MS` (default 2000), one outbound request at a
  time, `Retry-After` honoured, and a circuit breaker that pauses everything for 30 minutes after
  three consecutive 403/429 responses.
- **The database must stay on a local disk.** WAL mode on a file-sync service (Dropbox, Seafile,
  NFS) corrupts SQLite. The compose file bind-mounts `./data` for that reason; see
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the Unraid specifics.
- **Schema changes** bump `SCHEMA_VERSION`; an upgrade ladder migrates older files in place and the
  app refuses to open a database from a *newer* build rather than corrupting it.
- **The Dashboard shows crawl health**: the dead-letter count with the offending URLs, both queue
  lanes, and per-forum backfill progress as a percentage. If a forum's backfill stopped early you
  see it there rather than inferring it from an empty search.
- **Title search is FTS5-indexed** with a `LIKE` fallback for fragments under three characters.
- **A URL that keeps failing is dead-lettered after 5 attempts** (30s → 2m → 8m → 32m backoff), so
  one 404 cannot eat the politeness budget forever.
- **A listing page that parses to zero topics is treated as a failure**, not as "last page" —
  otherwise one markup change would silently truncate a forum's entire backfill.
- **Torznab links follow the request `Host`.** A container that asked `localhost:8484` would mean
  *itself*, so configuring Radarr with the LAN IP yields grab links on that same origin. Pin
  `SELF_ORIGIN` only if you front the app with a proxy.
- **`none` provider results are re-checked after 30 days**, and empty searches are never cached, so
  a film added to TMDB later can still be matched.

## Layout

| path | what |
|---|---|
| `packages/shared` | parsers, token mapping, title normaliser, classifier, Torznab XML — all pure |
| `packages/db` | Drizzle schema + the single `migrate()` authority + drift test |
| `apps/worker` | polite HTTP client, two-lane queue, delta/backfill crawl, replay |
| `apps/api` | Torznab + REST, serves the SPA, the snapshot CLI, `/api/v1/verify` |
| `apps/web` | React 19 + Tailwind UI |
| `config/forums.json` | the crawl allowlist (46 boards + 6 language hubs) |
| `config/scope.json` | the include/exclude decision for every board the site serves (96) |
| `docs/api.md` | every HTTP route, with the Torznab flags and error codes |
| `docs/DEVELOPMENT.md` | the local loop: dev servers, dev databases, commands, worktrees |
| `docs/DEPLOYMENT.md` | Unraid, bind mounts, ownership, backups, troubleshooting |
| `docs/SNAPSHOT.md` | moving a database in and out |
| `docs/DECISIONS.md` | why the non-obvious choices were made |
| `docs/RELEASING.md` | maintainer: publishing the image and the public snapshot |

## How this repository is kept honest

Two gates run in CI on every push:

- **`pnpm check:leaks`** fails the build if a `*.torrent`, a database, a real infohash, a tracker
  URL, or agent/planning material is ever tracked. The parser fixtures are captured pages whose
  infohashes, attachment keys and shortener tokens have all been replaced with deterministic
  synthetic values (`pnpm sanitize:fixtures`), so nothing in the repository can be used to download
  anything.
- **`npx vitest run`** (900+ tests) plus `pnpm -r typecheck`, after `pnpm -r build`.

Contributor setup, the gate order and the fixture rules: [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Licence

MIT — see [`LICENSE`](LICENSE). The software only; the catalogue belongs to whoever posted it.
