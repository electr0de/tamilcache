# Deployment

TamilCache ships as one image with one compose file. There is no installer, no database step and
no `.env` to fill in.

```bash
docker compose up -d          # or: podman compose up -d
```

## What runs

| service | what it does |
|---|---|
| `api` | Fastify on `:8484` — Torznab for Radarr/Sonarr, REST for the SPA, serves the React UI |
| `worker` | the crawler: delta every night, backfill on demand, replay, retention |
| `snapshot` | **not started by `up`** (`profiles: [tools]`) — backup and restore only |

Both real services use the same image and the same `/data` volume. The API migrates the database on
start; the worker waits for the API to report healthy so two processes never race a fresh file.

## Where the data lives

Everything persistent is in **one host directory**: the SQLite database, its WAL sidecars, uploaded
`.torrent` files and exports.

```yaml
volumes:
  - type: bind
    source: ${TAMILCACHE_DATA:-./data}    # relative to the compose file
    target: /data
```

Default `./data` means "next to `docker-compose.yml`", which is what makes the whole install
copyable: move the directory and the compose file together and you have moved the app.

```bash
TAMILCACHE_DATA=/srv/tamilcache/data docker compose up -d    # somewhere else
```

### It must be a local disk

SQLite runs in **WAL mode**, and WAL fails badly on storage that reorders or relocates files:

- a file-sync service (Seafile, Dropbox, OneDrive, iCloud Drive) that syncs the directory out from
  under a live database;
- NFS/SMB, where SQLite's locking assumptions do not hold;
- **an Unraid shfs volume** (`/mnt/user/...`) while files can still move between array disks.

The database does not fail loudly in those cases — it corrupts. Keep it on a local filesystem.

## Unraid

Unraid runs Docker with a `shfs` union at `/mnt/user` layered over the array plus cache pools. The
fix is to make sure the directory holding the database never lives on the array:

1. **Shares → appdata → Cache: `Only`** (or `Prefer` if you also have a cache pool you trust).
   With `Only`, `/mnt/user/appdata` resolves to the cache pool and shfs is not shuffling files.
2. `/mnt/cache/appdata/...` bypasses even the FUSE overhead if you want the direct path; it is the
   same directory with `Cache: Only`.

### Compose Manager project layout

With the *Docker Compose Manager* plugin, each stack is a directory:

```
/mnt/user/appdata/compose.manager/projects/tamilcache/
├── docker-compose.yml     ← copy the repo's file here
├── .env                   ← optional; only if you want to override a default
└── data/                  ← created on first start
    ├── tamilcache.db
    ├── tamilcache.db-wal
    └── backups/
```

```bash
cd /mnt/user/appdata/compose.manager/projects/tamilcache
docker compose up -d
```

That is the entire Unraid install. Open `http://<unraid-ip>:8484`.

### Ownership: PUID / PGID

The container starts as root, `chown`s `/data` to `PUID:PGID`, then drops privileges with
`setpriv` — no supervisor process, no `gosu`. Unraid's convention is the default:

| var | default | meaning |
|---|---|---|
| `PUID` | `99` | `nobody` on Unraid |
| `PGID` | `100` | `users` on Unraid |
| `UMASK` | `002` | `rwxrwxr-x` / `rw-rw-r--` |

So files land as `nobody:users` and the rest of the array can read them. **On any other Linux
host**, set your own ids, otherwise `data/` will be owned by a uid you cannot easily use:

```yaml
environment:
  PUID: "1000"
  PGID: "1000"
```

On macOS and Windows with Docker Desktop, ownership is virtualised — leave the defaults.

The chown is recursive and includes the bind-mounted directory itself, so after the first start
`data/` **is** owned by `PUID:PGID` on the host. That is the intended outcome (your backup user can
read it without sudo), but it also means removing the directory later may need that user — with
rootless podman, `podman unshare rm -rf data` gets you the same namespace back.

If you start the container with `--user`, the entrypoint skips the chown and runs as that user; the
directory has to be writable by it.

**Rootless podman note:** the host shows container uid 99 as `100098` (`100000 + 99 - 1`) because
rootless podman maps container root to your own uid. Check the *inside* values, not the host ones:

```bash
podman run --rm -v "$PWD/data:/data" --entrypoint stat ghcr.io/electr0de/tamilcache:latest -c '%u:%g %n' /data/tamilcache.db
```

## Getting the image

The default is the published multi-arch-free (amd64) image:

```yaml
image: ${TAMILCACHE_IMAGE:-ghcr.io/electr0de/tamilcache:latest}
```

Tags published per build:

| tag | when |
|---|---|
| `latest` | every push to `main` |
| `sha-<short>` | every push — pin this if you want reproducible restarts |
| `1.2.3`, `1.2`, `1` | on a `v*` tag |

```bash
TAMILCACHE_IMAGE=ghcr.io/electr0de/tamilcache:sha-1a2b3c4 docker compose up -d
```

### `denied` when pulling

The GHCR package has to be **public** for anonymous pulls. If `docker pull` says `denied`:

- GitHub → your profile → **Packages** → `tamilcache` → *Package settings* → *Change visibility* →
  **Public**. This is a one-time click and cannot be done from the repo settings.
- Or authenticate: create a classic PAT with `read:packages` and
  `echo "$PAT" | docker login ghcr.io -u <user> --password-stdin`.

Pushing by hand (only needed if you publish outside CI) uses the same login with a `write:packages`
PAT. In CI there is nothing to configure: the workflow authenticates with the built-in
`GITHUB_TOKEN` and `permissions: packages: write`.

### Building locally instead

```bash
git clone https://github.com/electr0de/tamilcache.git && cd tamilcache
docker build -t tamilcache:local .
TAMILCACHE_IMAGE=tamilcache:local docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```

The database upgrades itself on start — schema changes are applied one version at a time, inside a
transaction, stamping `PRAGMA user_version` as they go. A database from a **newer** build is
refused with a clear error instead of being opened: upgrade the image, not the file.

Pin a tag if you want updates on your schedule:

```yaml
image: ghcr.io/electr0de/tamilcache:1.2
```

## Podman

Everything works, with two differences from Docker Compose:

- `podman-compose` does not enable a `profiles:` service for `run`, so backup/restore needs the
  profile spelled out: `podman compose --profile tools run --rm --no-deps snapshot export`.
- `podman compose down` leaves no containers, but files written by uid 99 stay behind in the
  mapped namespace; `podman unshare rm -rf data` (or `podman unshare chown -R 0:0 data`) puts you
  back in control of them.
- **Ownership follows that mapping.** `PUID=99` on rootless podman gives you files owned by host uid
  `100098`, which your own user then cannot write. For a *local* run where you also want
  `pnpm dev:api` to open the same database, set `PUID=0`/`PGID=0`: container root *is* your host
  user under rootless podman, so files land owned by you. Keep `99:100` on Unraid and on real
  Docker.

## Backups

One directory, one command:

```bash
tar -czf tamilcache-$(date +%F).tar.gz -C /mnt/user/appdata/compose.manager/projects/tamilcache data
```

For a consistent copy while it runs, use the built-in export instead — it checkpoints WAL properly
and scrubs credentials: see [`SNAPSHOT.md`](SNAPSHOT.md).

## Resource use

- ~250 MB image, ~120 MB RSS per service, idle CPU ≈ 0 between crawls.
- The database is ~90 MB at 8.7k topics / 6.2k variants; growth is dominated by `log_events`, which
  retention prunes after `LOG_KEEP_DAYS` (default 14).
- Crawling is deliberately slow: `CRAWL_DELAY_MS=2000`, one request at a time. Do not lower it —
  the site starts answering 403 and the circuit breaker pauses everything for 30 minutes.

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `port is already allocated` | 8484 taken | `TAMILCACHE_PORT=8585`, then use `http://host:8585` |
| `permission denied` on `/data` | bind target owned by another uid | `PUID`/`PGID` to match, or `chown -R 99:100 data` |
| container restarts with `newer than this build` | the image was downgraded | upgrade the image; do not delete the database |
| `database disk image is malformed` | the directory was on a synced/shfs volume | restore from `data/backups/`, move it to a local disk |
| SPA loads but every request 401s | stale key in `localStorage` for that origin | the app re-bootstraps on the first 401; if it persists, `ALLOW_BOOTSTRAP=false` is set — copy the key from `docker compose logs api` |
| worker logs `circuit open` | the site answered 403/429 three times | wait 30 minutes; do not raise concurrency |
| nothing in the feed after a rebuild | a stale image is still running | `docker compose up -d --force-recreate`, then `docker inspect <project>_worker_1 --format '{{.Image}}'` |
