# Snapshots: moving a database in and out

A fresh install caches itself — there is nothing to import. Snapshots exist for the three cases
that are actually awkward:

- moving an existing install to new hardware (laptop → Unraid, or a new server),
- keeping a real backup before an upgrade,
- seeding a second instance from the same crawl instead of hitting the site again.

**No snapshot is published.** The database is a crawl result: it contains the same links and
infohashes the site itself serves. It is your data to keep, not to redistribute.

## Export

```bash
docker compose run --rm --no-deps snapshot export
```

On **podman-compose** the `snapshot` service sits behind a profile, which podman does not enable
for `run`, so spell it out: `podman compose --profile tools run --rm --no-deps snapshot export`.

Writes `data/backups/tamilcache-<timestamp>.db.gz` — beside your compose file, in the one directory
you already back up. Measured on a real install: 90 MB live → **8.1 MB**, in ~2.5 s.

The worker keeps running: the copy is taken with `VACUUM INTO`, SQLite's consistent-copy mechanism
for a live WAL database — one statement, no downtime, no half-written file.

**Credentials are scrubbed by default.** The export deletes `log_events` (the bulk of the file) and
clears `app_state.torznab_api_key`, `tvdb_token` and the OMDb quota counters, then `VACUUM`s. The
safe default costs you one re-copied API key into Radarr; the unsafe default costs a leaked key.

```bash
# keep the key, for a same-owner migration where Radarr should keep working
docker compose run --rm --no-deps snapshot export --keep-secrets
```

An explicit output path works too:

```bash
docker compose run --rm --no-deps snapshot export /data/backups/before-upgrade.db.gz
```

## Import

```bash
docker compose run --rm --no-deps snapshot import /data/backups/tamilcache-2026-01-01.db.gz
docker compose run --rm --no-deps snapshot import https://example.invalid/tamilcache.db.gz
```

Local path or `http(s)` URL. **Stop the services first** when you are replacing a database that is
in use — `docker compose down` — because the running API holds the file open:

```bash
docker compose down
docker compose run --rm --no-deps snapshot import <file> [--force]
docker compose up -d
```

Before anything is replaced, the archive is:

1. gunzipped to a temporary file next to the target,
2. opened and `PRAGMA integrity_check`ed — a truncated download or a file that is not a database is
   rejected,
3. checked for a **newer** `user_version` — refused, always, because a newer schema cannot be
   downgraded safely (an older one is upgraded automatically by the migration ladder),
4. refused if the target already holds variants — unless you pass `--force`.

Only then is it `rename()`d into place, atomically, so a failed import leaves the previous database
untouched. Exit codes: `0` success, `1` refused or failed (one line explaining why), `2` misuse.

```bash
docker compose run --rm --no-deps snapshot import <file> --force   # replace deliberately
```

The import also deletes any `-wal`, `-shm` or `-journal` left beside the target: SQLite does not
check that a WAL belongs to the file next to it, so a stale one would silently bring the previous
contents back after a successful-looking restore.

An imported database that came from a build with an older schema is migrated on first start. A
scrubbed import generates a **new** API key on first boot — copy it from
`docker compose logs api` into Radarr/Sonarr, or use `--keep-secrets` on export.

## Manual route

If you would rather not run a container, `data/` is a normal directory:

```bash
docker compose down
gunzip -c tamilcache-2026-01-01.db.gz > data/tamilcache.db
rm -f data/tamilcache.db-wal data/tamilcache.db-shm
docker compose up -d
```

**Stale `-wal`/`-shm` files next to a replaced database are the classic corruption case** — delete
them, as above. The CLI does this correctly by staging to a temp file and renaming.

## What is inside

| table | rows on a real install | keep? |
|---|---|---|
| `topics` | 8.7k | yes — the crawl result |
| `variants` | 6.2k | yes — what the feed serves |
| `links`, `media`, `media_episodes`, `metadata_cache` | 39k / 4.8k / 9.3k / 11k | yes |
| `rules`, `overrides` | a handful | yes — teaching is expensive to redo |
| `crawl_tasks`, `backfill_state` | 14k / 46 | yes — resumable state |
| `log_events` | 88k (≈32 MB) | **no** — pruned on export |
| `app_state` | ~10 keys | **credentials scrubbed** by default |
