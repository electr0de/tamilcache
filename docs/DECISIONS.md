# Decisions

Append-only ledger of deliberate compromises: what this project hardcodes, fakes or deliberately
does not do, why, and what doing it properly would take. If you are about to "fix" one of these, read
the entry first — it may be a decision, not a bug.

## 2026-11-15 — The Torznab feed publishes `seeders: 1` as a "not measured" sentinel

**Hardcoded:** `apps/api/src/routes/torznab.ts` sends `seeders: 1, peers: 0` on every item
(`SEEDERS_UNKNOWN`).

**Why:** 1TamilMV publishes no swarm data — there is no seeder/leecher column anywhere in the listing
or topic HTML (a grep of `packages/shared/test/fixtures` for `seeder|leecher|peers` is empty) — and
the magnets we store carry only `xt`, `dn`, `xl` and `tr`. Radarr/Sonarr never measure seeders
either: the `Peers` column is the feed attribute printed verbatim.

**What it fixes:** a client-side `Minimum Seeders` rule (1 in this house's Radarr) rejects any
release whose `seeders` attribute is 0. Ours was a literal 0, so every release from this indexer was
rejected, including correct WEB-DLs, in interactive and automatic search alike.

**What it costs:** Radarr's seeder tie-break becomes a no-op (all releases rank equal), and a dead
torrent is offered exactly like a live one. The download client's own swarm view (qBittorrent sitting
at 0 %) is the only real gate.

Do not "correct" this back to 0 without reading the rest of this entry;
`apps/api/test/torznab.test.ts` pins the published value.

### What real seeders would take

1. **Parse the magnet.** Take the 40-hex infohash from `xt=urn:btih:` and collect every `tr=` announce
   URL (17 per release; public trackers such as opentrackr, demonii, torrent.eu.org). A magnet carries
   nothing else about the swarm — `x.pe` is one peer hint and is absent here.
2. **HTTP scrape** (BEP-15): `GET <announce-url, /announce → /scrape>?info_hash=<20 raw percent-encoded
   bytes>` returns bencoded `files -> <20-byte hash> -> {complete, incomplete, downloaded}`: `complete`
   is seeders, `incomplete` is leechers. `bdecode` already exists
   (`packages/shared/src/bencode.ts:48`); no dependency needed.
3. **UDP scrape** (BEP-15 over UDP) for the UDP trackers: connect (action 0) returns a connection
   id, then scrape (action 2) accepts up to 64 hashes and returns the same three counters.
   `node:dgram`, roughly 40 lines, no dependency.
4. **Cache** — `torrent_stats(infohash TEXT PRIMARY KEY, seeders INTEGER, leechers INTEGER,
   scraped_at TEXT, ok INTEGER)`, TTL about an hour, taking the **max** `complete` across trackers:
   dead trackers answer nothing and live ones disagree. Re-scrape infohashes seen in the last 24 h;
   older ones on demand only.
5. **Feed** — report `seeders` from the cache, keeping `SEEDERS_UNKNOWN` as the fallback when every
   tracker fails, so a client's minimum-seeders rule still cannot block an unmeasured release.

**Rejected alternative — act as a torrent client.** A DHT crawl (`get_peers` over KRPC) plus BT
handshakes and bitfield reads per peer yields a peer count with no tracker at all, but costs 10 s to
2 min and hundreds of sockets per infohash, and answers "who does DHT know", not "how many seeds". An
`announce` returns the same `complete`/`incomplete` numbers as a scrape but joins the swarm and can be
counted as a leecher.

## 2026-11-15 — Release age is stamped "now"

**Hardcoded:** `apps/api/src/routes/torznab.ts` sends `pubDate = published_at ?? now`, and nothing
writes `published_at` (`apps/worker/src/persist.ts` omits it), so every item claims to be brand new.

**Why we have not fixed it:** Radarr/Sonarr have no age rule for a torrent indexer — `Minimum Age` and
`Retention` are Usenet-only — so age is display-only: the `Age` column and "sort by age".

**What doing it properly takes:** the listing HTML already carries the post time
(`<time datetime='2026-11-04T13:49:53Z'>` in the same row as the title link, see
`packages/shared/test/fixtures/forum-listing.html`). Parse it in `listings.ts collect()`, carry it
through the queue, and write it on insert — and note that variant inserts are `onConflictDoNothing`,
so existing rows need an `onConflictDoUpdate` for that column or a backfill.

## Topic states and the Hindi gate (2026-11-17)

**Decision:** a topic's status describes its links (`parsed`, `external`, `no_link`, `gone`,
`parse_failed`), and the Hindi gate stays per **variant**, decided from the block header plus the
topic title/prose plus the provider — never from the board.

**Why the board rule was removed:** five rules were taught from one review click each
(`{ forumIds }` with no content constraint). One stamped 881 variants `hindi_original`, three
deleted every variant on their board. Raised to `enabled = 0`, then `pnpm replay` re-decided 881
rows from evidence: the 5-language blocks became `hindi_dubbed`, the Tamil-only ones were deleted.

**Decision:** nothing without a Hindi classification is *served* — the feed selects
`decision IN ('hindi_dubbed','hindi_original') AND is_preferred` — but a topic with no usable
download is still *stored*, as a work queue (`external` 2,408 / `no_link` 1,960), because the
question "is this Hindi?" cannot be answered without the magnet.

**Decision:** one release per **title × resolution**, existing size rule first (largest 1080p,
smallest 2160p), then view count, then `published_at`. Radarr's quality profile still chooses
between resolutions.

## 2026-11-17 — A post under the 1080p floor is not a parser failure

**Decision:** `below_floor` is its own topic status.

**Why:** the re-crawl of the 65 `parse_failed` topics left 33, and sampling them showed two different
things behind one label: posts the parser genuinely missed, and posts whose blocks parsed correctly and
were then dropped for being 480p/DVD9. Only the first is actionable, and reporting the second as a
parser failure sends someone to look at markup that is fine. After the split: `parse_failed` 65 → 0,
`below_floor` 33.

## 2026-11-17 — The unresolved queue is paged, and ordered by "never looked at"

**Decision:** `/api/v1/unresolved` returns `{ rows, total, page, pages, counts }`, searches the title,
filters by board and by state, and orders by `views DESC NULLS LAST, lastSeenAt ASC`.

**Why:** the first version returned a bare array capped at 200. Against 2,408 gated posts that meant
92% were unreachable, board 12 showed 4 of its 490, and there was no way to work one board. The
ordering matters because `views` is still NULL for most rows: sorted by recency, the posts nobody has
opened sink permanently.

## 2026-11-17 — The parser keeps a block it cannot name

**Decision:** shape (a year, a resolution, a size) decides whether something is a block; vocabulary
decides only whether the source is recognised. An unknown source persists as `UNKNOWN_SOURCE` with an
unknown decision, so it lands in review instead of vanishing with its magnet.

**Narrowing on purpose:** a header with no resolution is still dropped, because its resolution is
inferred from the summary line and a guess there could invent the wrong block. `TVRip`, `HQ PRE-HD`
and the `HQ HDRp` typo were added to the table from fixtures captured off the live site, and headers
are now anchored on `ESub`/`.torrent` endings as well as a colon. A line ending in `.torrent` is
attached in a second pass, not counted as a header — otherwise one block yields two variants.

