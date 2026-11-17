# API reference

Everything is served by one Fastify process on `:8484`. Every route under `/api/` requires the
API key (`?apikey=…` or `X-API-Key: …`) **except** `/api/v1/bootstrap`, which hands the generated
key to a browser on your LAN (see below).

The key is generated on first boot, shown on the Settings page and printed once in the API log.

```bash
KEY=$(docker compose logs api | grep -o 'torznab api key: .*' | awk '{print $4}')
curl "http://localhost:8484/api/v1/stats?apikey=$KEY"
```

---

## Torznab (what Radarr/Sonarr use)

| route | notes |
|---|---|
| `GET /api/v1/caps` | advertises `search`, `movie-search` (`q,imdbid,tmdbid,year`), `tv-search` (`q,season,ep,year`). Deliberately **no `tvdbid`** — see below. |
| `GET /api/v1/search` | `t=movie\|tvsearch\|search`, `q`, `imdbid`, `tmdbid`, `year`, `season`, `ep`, `cat`, `limit` (≤100), `offset`. Emits only `hindi_dubbed`/`hindi_original` **and** `is_preferred`, one row per infohash. `cat` accepts a single id, a comma list (`2000,5000`) or a repeated parameter; a parent id covers its subtree. `q` is answered by an FTS5 index over the normalised and raw titles (prefix-matched, quoted so FTS syntax in the input cannot error); fragments shorter than three characters fall back to `LIKE`. Ordering stays quality-first, never relevance. Grab links use the **request `Host`** (so a container client gets reachable URLs), overridable with `SELF_ORIGIN`. |
| `GET /api/v1/download/:id` | `302` → cached `.torrent` if one was uploaded, else the magnet. |

The same three endpoints are also reachable at the shapes clients build for themselves:
`GET /api/v1/api?t=caps|movie|tvsearch|search` (Radarr and Sonarr append `/api` to the base URL)
and the bare `GET /api/v1?t=…` (generic Torznab clients that treat the URL as the whole feed). Both
dispatch to the routes above; auth, XML and the grab-link origin are identical.

Query flags that are not in the Torznab spec:

- `alternatives=1` — include non-preferred variants (the other encodes we kept but do not offer).
- `bestonly=1` — collapse further, to one row per title.

**Why `tvdbid` is absent:** TMDB's `external_ids` returns `tvdb_id: null` for almost every
regional show, and TVMaze does not know them either. Advertising a parameter we cannot satisfy
makes Sonarr issue searches that can only return zero results. A `tvdbid` parameter that arrives
anyway is accepted and ignored, so a manual query still works.

---

## Browse / inspect (what the UI uses)

| route | notes |
|---|---|
| `GET /api/v1/bootstrap` | hands the app-generated key to the SPA. It validates the request (cross-site reject, `Origin`/`Host` match, DNS-rebinding-safe host) instead of restricting it to loopback, so any browser that can load the UI gets the key without being asked for one. `ALLOW_BOOTSTRAP=false` disables it. |
| `GET /api/v1/stats` | topics, variants, preferred count, per-decision counts, review queue grouped by reason |
| `GET /api/v1/browse` | release rows (one per infohash): `decision`, `resolution`, `sourceTag`, `forumId`, `minSize`, `maxSize`, `hasMagnet`, `q`, `sort=quality\|newest\|size`, `limit`, `offset`, `alternatives=1`. The UI no longer uses it; it backs the unmatched lane's release rows and any external release-level query |
| `GET /api/v1/library` | **title grid.** One row per `media` title, not per release. `type=all\|movie\|tv`, `q`, `quality` (a resolution the title must have at least one kept release in), `health=all\|missing\|no_hindi\|unmatched`, `sort=latest\|title\|coverage`, `limit` (default 48, cap 100), `offset`. Returns `{ total, limit, offset, titles[] }`; each title carries `mediaId`, `type`, `title`, `year`, `poster`/`backdrop` (TMDB `w342`/`w780` URLs, `null` when the provider had none), `voteAverage`, `audioLangs`, `resolutions`, `releases`, `latestRelease`, `largestBytes`, `seasons`, and `coverage {aired,covered,missing}` for shows (`null` when the provider supplied no episodes). `health=unmatched` returns `unmatched[]` release rows instead of cards. Titles are keyed by the internal `media.id`, never by TMDB's id — movies and TV collide in that namespace |
| `GET /api/v1/library/suggest` | `q` (2+ chars) → at most 8 `{ mediaId, title, year, type, poster }`. Each typed token must start a word in the title: `spid` → Spider-Man, `avatar way` → Avatar: The Way of Water. No typo tolerance, no fuzzy index — 1–2 ms against 4.8k titles |
| `GET /api/v1/library/:mediaId` | one title for the detail pages: `media{}` (including `genres`, `voteAverage`, `voteCount`, `runtime`, `status`), `availability` (`hindi_ready`/`no_hindi`), `releases[]` (preferred variants in the UI's row shape), and for shows `seasons[]` with per-episode `aired`/`covered`, `coverage`, `missing[]`. `seasons: null` means the provider returned no episode data — the UI says so instead of inventing a grid |
| `GET /api/v1/forums` | the in-scope allowlist as seeded |
| `GET /api/v1/titles/:key` | `key` = topic slug or TMDB id. Returns variants, `episodes[]` (with `covered`/`aired`), `coverage {aired,covered}`, `missing[]`, plus `kind` (`movie`/`tv`) and the TMDB picker's prefill `searchQuery`/`searchYear` |
| `GET /api/v1/crawl` | lane state (`armed`, `paused`, `deltaRequested`, `lastDeltaAt`, `circuitOpenUntil`, `tmdbBackoffUntil`) plus **crawl health**: `dead { count, sample[] }` (tasks retried 5× and parked), `pending { p0, p1 }`, and `backfill[]` with `forum`, `nextPage`, `totalPages`, `percent`, `done` |
| `GET /api/v1/health` | liveness + review backlog |
| `GET /api/v1/verify` | the invariant table as JSON (`{ok, checks[]}`) |

**Episodes and specials:** coverage is an intersection of provider episodes with the ranges kept
releases claim, so a release advertising `S01E01–E99` cannot mark episodes the provider never
listed. Season 0 (specials) is displayed but never counted in `coverage`/`missing`: an aired
featurette would otherwise make every such series look permanently incomplete.

**Images:** posters and backdrops are served from `image.tmdb.org` in the browser. There is no
proxy — a title without a stored path renders a neutral tile, and a failed image falls back to the
same tile. TMDB attribution is rendered on both detail pages.

---

## Teaching (review queue + rules)

| route | body / notes |
|---|---|
| `GET /api/v1/review` | unknown variants grouped by reason, each with evidence and a `providerProposal`. Each item also carries `kind`, `searchQuery` and `searchYear` — the query the crawler itself asked TMDB, so the reviewer never retypes it |
| `POST /api/v1/review/preview` | `{ predicate, action }` → `{ affected, sample }`. Never writes. |
| `POST /api/v1/review/decide` | Either `{ variantIds[], action }` (exact overrides, evidence-hashed) or `{ applyToSimilar: true, predicate, action }` (writes a rule). `dryRun: true` returns the blast radius. Actions: `hindi_dubbed`, `hindi_original`, `not_hindi`, `ignore`. An **empty predicate is rejected** — it would match every row. |
| `GET/POST/PATCH/DELETE /api/v1/rules[/:id]` | CRUD; every mutation replays and returns `{ replay: { updated } }`. Re-applying an identical predicate+action does not create a duplicate rule. |

Replay order is `override → rule → provider → audio token → unknown`, so a rule never overrides a
manual decision.

---

## Provider (TMDB)

| route | notes |
|---|---|
| `GET /api/v1/tmdb/search?q=&year=&kind=` | manual search, for when the proposal is wrong or absent. `kind=movie\|tv` adds `score`/`reasons` — **ranked by the same scorer the provider pass uses but never filtered**, because a bad year parsed from a slug must not hide the right film. Without `kind` the results are raw and unscored |
| `POST /api/v1/titles/:topicId/bind` | `{ tmdbId, mediaType }` — bind a specific title, bypassing scoring; replays afterwards |
| `POST /api/v1/titles/:topicId/recheck` | clear the provider stamp so the next worker tick searches again |
| `GET /api/v1/providers` | which manual providers are configured: `{ omdb: boolean, tvdb: boolean }`. The review panel probes this once and renders nothing for an absent key |
| `GET /api/v1/omdb/search?q=&year=` | manual OMDb search. Every call spends one of 1,000 free daily requests, guarded **before** the network by an `app_state` counter; `429` when spent, `503` without a key, `400` on empty `q` |
| `GET /api/v1/tvdb/search?q=` | manual TVDB series search (shows only). `503` without a key, `400` on empty `q`. Hits carry **no remote ids** — they arrive with the detail route |
| `GET /api/v1/tvdb/series/:id` | series detail for the review card: `originalLanguage` (ISO-639-1, mapped from TVDB's 3-letter form), `originalCountry` (**country**, not language), `seasons`, `episodes`, `aliases`, and `imdbId`/`tmdbId` read from `remoteIds`. `503` without a key, `400` on a non-numeric id, `502` on upstream failure — the upstream path is logged, never echoed |
| `POST /api/v1/titles/:topicId/bind-manual` | `{ imdbId, mediaType, title, year, originalLanguage, seasons }` — attach a title TMDB does not have. Tries TMDB `/find` first; `409` with candidates when it returns several; otherwise stores the row keyed by `imdb_id` with a negative `tmdb_id` sentinel that is never emitted to clients |

---

## Rest of the surface

| route | notes |
|---|---|
| `GET /api/v1/bootstrap` | returns `{ apiKey, torznabUrl }`, where `torznabUrl` uses the origin you called. `Cache-Control: no-store`. Trust is checked with headers a browser cannot forge: `Sec-Fetch-Site: cross-site` → 403, an `Origin` that differs from `Host` → 403, and a **dotted** `Host` not in `TRUSTED_HOSTS` → 403. IP literals, `localhost`, dotless names and `.local` pass. `ALLOW_BOOTSTRAP=false` disables it entirely. |
| `POST /api/v1/crawl/delta` | queue an immediate delta run |
| `POST /api/v1/crawl/backfill` | `{ armed?, paused? }` — the worker polls these flags; only the worker makes outbound requests |
| `POST /api/v1/torrents/:variantId` | `multipart/form-data` field `file`. Infohash is derived from the bytes (never trusted), the file is stored as `data/<id>.torrent`, and a torrent already used by another variant returns `409` |
| `POST /api/v1/links/:id` | `{ kind }` — reclassify a link (`gdrive`, `shortener`, `stream`, `torrent`, `spam`, `other`) |

---

## Error behaviour

- `400` for an invalid predicate, action, link kind, or a non-numeric path id.
- `401` for a missing/wrong key on any guarded route.
- `403` for bootstrap when the request is cross-site, carries a mismatched `Origin`, or uses a
  dotted `Host` that is not in `TRUSTED_HOSTS`.
- `409` for a torrent already attached elsewhere.
- `5xx` returns `{ "error": "internal error" }`; the SQLite detail goes to the log only.

Column values are enum-checked in code (SQLite has no CHECK constraints here), so an unknown
`action` is rejected rather than stored and silently disappearing from the feed.
