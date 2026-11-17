# Verifying with Radarr and Sonarr (direct path)

> **If you use Prowlarr, read [`prowlarr.md`](prowlarr.md) instead** — it is the same flow with
> Prowlarr in front, and it covers the grab-link origin check that matters in containers.

This is the only check that proves the Torznab contract end-to-end: a real client, parsing our
real titles, against real crawled data. Everything else in the suite is offline.

## 1. Start the stack

```bash
cp .env.example .env
# set TMDB_API_KEY and TORZNAB_API_KEY (any random string; you will paste it into Radarr)
docker compose up -d --build
docker compose --profile verify up -d radarr sonarr
```

Radarr → http://localhost:7878 · Sonarr → http://localhost:8989

## 2. Add the indexer in Radarr

| field | value |
|---|---|
| Settings → Indexers → Add → **Torznab** | |
| Name | `TamilCache` |
| URL | `http://<lan-ip>:8484/api/v1` — a client on another machine must use the LAN IP, not `localhost` |
| API Key | the value of `TORZNAB_API_KEY` |
| Categories | `2040`, `5030` *(Movies/SD, TV/HD — our other categories are optional)* |

Radarr and Sonarr append `/api` to whatever base you enter (`{url}/api?t=caps`); the API serves that
suffix, so `…/api/v1` is correct exactly as typed. A Radarr running as a sibling container on the
same host can instead use `http://host.docker.internal:8484/api/v1` (Linux: `http://172.17.0.1:8484/api/v1`).

Click **Test**.

- [ ] **Test passes** (green tick). If it fails with 401, the API key is wrong; if it times out,
      the URL cannot reach the host from inside the container; if it fails with **404** on a URL
      ending `/api`, the build predates the alias route (`feat(api): serve the /api?t= entry point`).

## 3. Prove Radarr parses our titles

1. Movies → Add New → search for a film you know is cached in Hindi.
2. Open **Interactive Search** for it.

- [ ] Results appear.
- [ ] The quality column shows a **real quality** (`TeleSync`, `WEBRip`, `WEBDL`, `Bluray`) —
      **not `Unknown`**. This is the whole point of the token mapping: `Quality.Unknown` is in no
      quality profile and would never be grabbed.
- [ ] The language column shows **Hindi**.
- [ ] Clicking the download button grabs the release (it redirects to `magnet:` or a `.torrent`).

## 4. Prove Sonarr matches a season

1. TV Shows → Add New → add a series that exists in the cache (e.g. one posted as `S01 EP(01-08)`).
2. Open the season and run **Search** (Season search, not episode search).

- [ ] The season pack appears as a result for that season.
- [ ] Sonarr reports the episodes it covers, not `Unknown`.

Season-pack aware is deliberate: an `S01E01-E08` torrent is one entry describing eight episodes,
so Sonarr's season search finds it without us fanning one torrent into eight fake episodes.

## 5. Record the outcome

Paste the Radarr/Sonarr screenshots or the `docker compose logs radarr` lines into your notes,
and run `docker compose exec api node apps/api/dist/verify.js` for the invariant table. If a
check fails, the detail column names the exact invariant.

## What can legitimately differ

- **Only 1080p+ is offered, one per resolution.** If a film exists only as 720p on the site it
  will not appear in Radarr at all — that is deliberate. Within a resolution you see exactly one
  result: the largest 1080p encode, or the smallest 4K encode. Append `?alternatives=1` to the
  Torznab search when you want the rest for manual inspection.
- **`HDRip` → `WEBRip`**: the site's `HQ HDRip` has no Radarr token at all; mapping it to
  `WEBRip` is what makes it grabbable. A true `WEBRip` and an `HDRip` therefore share a quality
  bucket — a deliberate trade.
- **Seeders are a constant 1**: this is a cache of public postings, not a live tracker query, so the
  feed publishes a "not measured" sentinel instead of 0 — a client-side minimum-seeders rule rejects
  0 and would block the whole indexer. Radarr only uses seeders for tie-breaking;
  `downloadvolumefactor = 0` prevents ratio-based rejections. See `docs/DECISIONS.md`.
