# Verifying with Prowlarr (primary path)

Prowlarr is the likely endpoint, and it speaks the same Torznab contract as adding the indexer
directly to Radarr/Sonarr — so this checklist covers both. Skip to §6 for the direct path.

The one thing to check first: the app must show you its key without any copying. Open
`http://<lan-ip>:8484/settings` — the key appears immediately and **Copy Torznab URL** is next to it.
If it says "not resolved yet", the `Host` you used is a dotted domain not listed in
`TRUSTED_HOSTS`; use the IP instead.

## 1. Add the indexer

Prowlarr → **Settings → Indexers → Add Indexer → Torznab**

| field | value |
|---|---|
| Name | `TamilCache` |
| URL | `http://<unraid-lan-ip>:8484/api/v1` |
| API Key | from the app's Settings page |
| Categories | leave to the next step |

## 2. Test

Click **Test**.

- [ ] Green tick. `401` means the key is wrong; a timeout means Prowlarr's container cannot reach
      the host IP/port (check the published port, not `localhost` — inside a container `localhost`
      is the container itself).

## 3. Sync categories

**Sync Categories** → select `2040` (Movies/SD) and `5030` (TV/HD), or `2000`/`5000` for whole
subtrees — both forms are supported.

- [ ] Categories appear under the indexer. Our caps also declare 2030/2045/2050/2070/5040/5045.

## 4. Search

Indexer → **Search** → a film you know is cached in Hindi (e.g. `Jailer 2`).

- [ ] Results appear.
- [ ] Language column shows **Hindi**.
- [ ] Resolution shows a real value (`1080p` / `2160p`), and `alternatives` are hidden — one
      result per resolution by design.
- [ ] Exactly **one** result per release even though the same torrent is posted in several
      language forums (cross-posted infohashes are collapsed at emit).

## 5. Grab

Click download on a result.

- [ ] The grab succeeds. The `<link>` points at `http://<unraid-lan-ip>:8484/api/v1/download/N`,
      i.e. the same origin you configured — not `localhost`. If the search worked but the grab
      failed, this is the line to check: it means `SELF_ORIGIN` is pinned to a host the client
      cannot reach.

## 6. Direct path (Radarr / Sonarr, no Prowlarr)

Identical steps in Radarr/Sonarr → Settings → Indexers → Add → **Torznab**, then
**Interactive Search** for a film. Expect the same language/quality/category results as §4.

For Sonarr specifically: this indexer does **not** advertise `tvdbid` (TMDB returns null for
almost every regional show, so a tvdbid search could only ever return nothing). Sonarr therefore
searches by title + season/episode, which is why a series search works but a tvdbid-keyed lookup
would not.

## What can legitimately differ

- **Only 1080p+ is offered, one per resolution.** A film that only exists as 720p will not appear
  at all. Within a resolution you get one result: the largest 1080p encode, or the smallest 4K.
- **`HDRip` is emitted as `WEBRip`** — Radarr has no `HDRip` token, and an unmatched source means
  `Quality.Unknown`, which no quality profile contains.
- **Seeders are 0**; `downloadvolumefactor` is 0, so ratio rules do not reject us.
- **A missing resolution** (the site's 700MB/400MB "Rips" tier, ~34% of blocks) means the variant
  is dropped before it reaches the indexer under the 1080p+ rule.
