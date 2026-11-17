# Fixture manifest

Captured **2026-11-09** from the live site (`www.1tamilmv.io`), one request every 2 s, with a
descriptive User-Agent. These are the ground truth for every parser test: **do not edit a fixture
to make the parser pass** — if a fixture disagrees with the code, the code is wrong.

**Nothing in this directory can be used to download anything.** Every `xt=urn:btih:` payload has
been replaced with a synthetic hash, and the `.torrent` attachment is built in code
(`synthetic-torrent.ts`) instead of being committed: it announces `tracker.example`, names a file
that does not exist, and its piece hash is filler. `pnpm check:leaks` fails the build if a real
infohash ever reappears here — see `synthetic-hashes.json` for the allowlist.

The one cross-check that matters still holds: the synthetic torrent's bencoded info-hash is
`c9d385dc7158d74f70b733f17a8c0dde9b67357c`, which is byte-identical to the `xt=urn:btih:` in
`single-quality.html`'s first block — the pair the upload test asserts on. Verify it out of band:

```bash
printf '%s' 'd6:lengthi1024e4:name19:example-fixture.txt12:piece lengthi16384e6:pieces20:bbbbbbbbbbbbbbbbbbbbe' | sha1sum
```

## THE PARSING RULE THIS SET PROVES

A **quality block** is not simply "a line containing a size and a source tag". Every topic body
also repeats a *topic-level summary* of the form

```
Jailer 2 (2026) Tamil TRUE WEB-DL - [1080p & 720p - AVC / HEVC - (AAC 2.0) - 2.8GB - 1.4GB & 950MB] - [x264 - 700MB - ...]
```

which appears **three times** before the topic URL line and would otherwise consume magnets.
`multi-quality.html` has 20 candidate lines but only 7 magnets.

The reliable anchor is the **trailing colon**:

```
Jailer 2 (2026) Tamil HQ HDRip - 1080p - x264 - (AAC 2.0) - 2.8GB - HC- ESub :      <- block header
www.1TamilMV.io - Jailer 2 (2026) Tamil HQ HDRip - 1080p - x264 ... .mkv.torrent   <- its attachment
magnet:?xt=urn:btih:...                                                            <- its magnet
```

Measured across all seven magnet-bearing fixtures: **lines that end with `:` and contain both a
size and a source tag equal the magnet count exactly** (7/7, 6/6, 5/5, 3/3, 3/3, 3/3, 2/2, 0/0).
Use that as the primary selector, then take the next magnet/attachment that follows it.

Other facts visible in this set that the parser must survive:

- **A block header may have no resolution**: `A Minecraft Movie (2025) Hindi  HDTC-Rip  - x264 - HQ Clean Audio - AAC - 400MB :` → `resolution = null`, still a valid variant.
- **Audio languages may be bracketed and abbreviated**: `[Hindi + Eng]`, `[Tamil + Eng]`, `[Tam + Eng]` (the *attachment filename* abbreviates, the header does not — prefer the header).
- **`HQ Clean` / `HC` is audio/quality noise, never a source token** (`HQCAM` is a real Radarr token, so the string must not survive into the normalised name).
- **`UNTOUCHED`** appears in some block lines and means nothing to Radarr.
- **`Original Audio` / `Org Audio` / `Original Audios` / `Org Auds`** indicate the original track was kept; they carry no language token themselves.
- Block headers for a *season* repeat the season/episode range in the header, e.g. `S01 EP (01-05)`, while the slug uses `s01-ep-01-05`.

## Fixtures

| file | shape | magnets | expected variants | notes |
|---|---|---|---|---|
| `home.html` | delta source **and** board index | 0 | n/a | 544 KB. Contains `TOP RELEASES THIS WEEK`, `Week Releases`, `RECENTLY ADDED`. Topics appear as absolute `1tamilmv.io` URLs. Used by `parseHomeSections`. It is also the guard fixture for `parseListingPage`: the page has no `cTopicList`, so a listing parser that scans the whole document returns **804** topics from the banner — the accident that filed 723 topics under one forum. Must return 0. |
| `pagination.html` | listing page | 0 | n/a | Forum 11 page 1. 24 topic rows + `Page 1 of 107`. Used by `parseListingPage`. |
| `forum-listing.html` | listing page, captured 2026-11-11 | 0 | n/a | Forum 12 page 1. 25 topic rows + `Page 1 of 46`. **13 of the 25 slugs are `%C2%A0`-encoded** (a non-breaking space in the title), which the old `[a-z0-9_.-]` slug class rejected: the parser saw 12 of 25 rows and those topics were never enqueued. Must return 25. |
| `forum-listing-last.html` | last listing page, captured 2026-11-11 | 0 | n/a | Forum 12 **page 46 of 46**, 6 topic rows. Proves `done` detection reads `Page N of M`, not `Page 1 of M`. |
| `empty-forum.html` | empty board, captured 2026-11-11 | 0 | n/a | Forum 26 (`dvd9-dvd5`, Telugu). 45 KB, **no `cTopicList` container**, and the empty-state sentence `There are no topics in this forum yet`. Proves `hasTopicList()` is false *exactly* when a board is empty: the old empty-forum branch required the container, so forums 26 and 71 dead-lettered on every attempt and, having no cursor row, took both backfill slots per tick. Must make `isEmptyForumPage` true and `hasTopicList` false. |
| `forum-hub.html` | language hub, captured 2026-11-11 | 0 | n/a | Forum 9 (`tamil-language`). No `cTopicList`, no page count; it lists subforums plus 10 links from widgets. Must parse to 0 topics so the crawler completes it as a hub instead of dead-lettering it. |
| `single-quality.html` | single/multi quality, Hindi dubbed | 2 | **2** | A Minecraft Movie (2025), `HDTC-Rip`. Second block has **no resolution**. The synthetic `synthetic-torrent.ts` blob belongs to this page. |
| `multi-quality.html` | many qualities, mixed sources | 7 | **7** | Jailer 2 (2026) Tamil: `HQ HDRip` (x264 **and** x265) + `TRUE WEB-DL` variants. 20 candidate header lines → the colon rule rejects the 13 summary lines. Also the fixture that proves `HDRip` needs a grabbable token. |
| `multi-quality-hq-predvd.html` | `HQ PreDVD` multi | 6 | **6** | Sardar 2 (2026) Tamil `v2 HQ PreDVD`. Proves `PREDVD` must be emitted as `PDVD`. |
| `hindi-original.html` | Hindi-original | 5 | **5** | Ramayana (2026) in forum 56. `HQ PreDVD`, `Original Audio`. Provider `original_language == 'hi'` ⇒ `hindi_original`. |
| `season-pack.html` | season pack | 3 | **3** | Panthadikkaam (2026) `S01 EP (01-05)`. The **topic-level summary line omits the language entirely** (`… S01 EP (01-05) TRUE WEB-DL - [1080p - 720p …]`), while all three **block** lines say `Malayalam`. Parsing the summary would yield `audioLangs: []` and dump an explicitly-Malayalam release into the review queue. This is the fixture that proves filtering must be per-block, not per-topic. (An earlier draft of this file claimed the topic held Tamil *and* Malayalam blocks; measured again on 2026-11-09, the blocks are Malayalam-only.) |
| `single-episode.html` | single episode | 3 | **3** | IT: Welcome to Derry `S01 EP01`, `[Hindi + Eng]`. Tests `epFrom == epTo == 1`, `isPack == false`, and bracketed language extraction. |
| `multi-audio-orgauds.html` | Hollywood multi-audio | 3 | **3** | A History of Violence (2005) `BluRay + Original Audios`, `[Tamil + Eng]`. No Hindi → must classify `not_hindi`, **not** "unknown". |
| `gdrive-only.html` | GDrive-only | 0 | **0** | Panchayat S04 `[Gdrive]`: zero magnets, zero attachments, 13 `adrinolinks.in` gate URLs in front of the Drive files. Must yield **0 variants** and not crash; the links are the product here. |
| `no-audio-tag.html` | no audio tag | 0 | **0** | Music video (`Danger - Param Sundari`). No magnets and no language token — the review-queue shape. |
| `daily-show-episodes.html` | daily show, many episodes in one post | 192 | **192** | Captured 2026-11-11 from BIGG BOSS Tamil S10 (topic 199652, which the site 301-redirects as the uploader renames it). 198 block headers, each ending `: [dd-mm-yyyy]` — the **date after the colon** is the shape that broke the anchor rule: a strict `endsWith(':')` saw 0 of 198 and the whole category dead-lettered. 6 headers are attachment-only, hence 192 magnets and 192 variants. |
| `torrent-no-magnet.html` | attachment without magnet | 0 | **0 pending enrichment** | **Synthetic**: `single-quality.html` with magnet anchors removed, because no live topic in this sample had an attachment and no magnet. Documents the enrichment path: fetch attachment → infohash → synthesise magnet. |

## Not covered by a live fixture

- **Login-walled or expired-`key=` attachments.** Cannot be captured without an account.
- **A real magnet-less-but-torrented topic.** See the synthetic fixture above; every live topic sampled had both.
- **`www.1tamilmv.io` markup drift.** Re-capture (`npm run fixture:capture`) whenever a real parse failure is found, and add a row here with the reason.

## Source-spelling and header-anchor fixtures (captured 2026-11-17)

Saved from the live site during the `parse_failed` audit (14 sampled topics, three causes). Each
proves one parser gap; the topic URL is given so it can be re-captured.

| fixture | topic | proves |
|---|---|---|
| `source-tvrip.html` | `/topic/198xxx-…` (TVRip release) | the source token is `TVRip`, absent from the table → the block was dropped |
| `source-pre-hd.html` | `/topic/…-war-2-2025-hindi-hq-pre-hd-…` | `HQ PRE-HD` is a real spelling; absent from the table → dropped |
| `source-hdrp-typo.html` | `/topic/197328-return-to-the-jurassic-2025-…` | the site prints `HQ HDRp` (typo for HDRip) → dropped |
| `header-no-colon-esub.html` | `/topic/…-constable-kanakam-2026-s02-…` | the block header ends with `ESub`, not `:`, so the anchor missed it |
| `header-torrent-follows.html` | `/topic/…-the-naked-gun-2025-…` | the header ends with the `.torrent` filename itself |

These are real pages, not hand-built HTML: a fixture that invents a shape passes while the real
page keeps failing.
