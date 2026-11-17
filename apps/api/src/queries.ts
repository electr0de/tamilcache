import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { Db } from '@tamilcache/db';
import {
  backfillState,
  crawlTasks,
  forums,
  links,
  media,
  mediaEpisodes,
  topics,
  variants,
} from '@tamilcache/db/schema';
import { normaliseImdbId, searchHint } from '@tamilcache/shared';
import { mediaKindOf } from '@tamilcache/worker';
import type { CategoryRange } from './categories.js';
import { shouldUseFts, toFtsQuery } from './search-text.js';

export const HINDI_DECISIONS = ['hindi_dubbed', 'hindi_original'] as const;

/**
 * Title search: the FTS5 index when the term is indexable, `LIKE` otherwise.
 *
 * The subquery form is deliberate — FTS5 cannot be joined inline into the existing drizzle query
 * without disturbing the infohash-dedupe subquery and the SQL `LIMIT` that keep this query fast.
 */
function textSearchCondition(raw: string) {
  const fts = shouldUseFts(raw) ? toFtsQuery(raw) : null;
  if (fts) {
    return sql`${variants.id} IN (
      SELECT f.rowid FROM variants_fts f WHERE variants_fts MATCH ${fts}
    )`;
  }
  // Short fragment, or nothing indexable: escape LIKE metacharacters so a typed `%` or `_`
  // cannot widen the query into a full scan.
  const needle = `%${escapeLike(raw.toLowerCase())}%`;
  return or(like(sql`lower(${variants.normTitle})`, needle), like(sql`lower(${topics.rawTitle})`, needle))!;
}

/**
 * One row per (infohash, decision): the best-quality copy.
 *
 * The same torrent is routinely posted in several language forums, so `browse()` must collapse
 * it exactly as the Torznab feed does — otherwise the screen cannot be used to judge what the
 * *arrs will see (measured: one release appearing three times).
 *
 * Partitioning by `(infohash, decision)` keeps the representative consistent with the outer
 * query's filter, so a `not_hindi` copy can never stand in for an infohash whose Hindi copy was
 * requested.
 *
 * This used to be a *correlated* subquery (`v2.infohash = variants.infohash`), which SQLite
 * evaluated once per candidate row with an ORDER BY temp B-tree each time: 2.9 s for the rows and
 * 3.0 s for the count on a 6.2k-variant database. The window function is one pass.
 */
function dedupeByInfohash(includeAlternatives: boolean) {
  return sql`${variants.id} IN (
    SELECT id FROM (
      SELECT v2.id,
             ROW_NUMBER() OVER (
               PARTITION BY v2.infohash, v2.decision
               ORDER BY v2.quality_rank DESC, v2.id ASC
             ) AS rn
      FROM variants v2
      ${includeAlternatives ? sql`` : sql`WHERE v2.is_preferred = 1`}
    ) WHERE rn = 1
  )`;
}

/** `%` and `_` are wildcards in LIKE; a user typing them must not widen the query. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export interface SearchParams {
  q?: string | undefined;
  imdbid?: string | undefined;
  tmdbid?: number | undefined;
  tvdbid?: number | undefined;
  season?: number | undefined;
  ep?: number | undefined;
  /** Movie/tv release year, as Radarr sends it. */
  year?: number | undefined;
  categories?: CategoryRange[] | null;
  limit: number;
  offset: number;
  bestVariantOnly: boolean;
  /** false ⇒ only the preferred variant of each resolution (largest 1080p, smallest 4K). */
  includeAlternatives?: boolean;
}

const selected = {
  id: variants.id,
  topicId: variants.topicId,
  mediaId: variants.mediaId,
  isPreferred: variants.isPreferred,
  normTitle: variants.normTitle,
  rawTitle: topics.rawTitle,
  slug: topics.slug,
  resolution: variants.resolution,
  sourceTag: variants.sourceTag,
  sourceTagRaw: variants.sourceTagRaw,
  codec: variants.codec,
  audioCodecs: variants.audioCodecs,
  audioLangs: variants.audioLangs,
  sizeBytes: variants.sizeBytes,
  infohash: variants.infohash,
  magnet: variants.magnet,
  torrentUrl: variants.torrentUrl,
  torrentLocalPath: variants.torrentLocalPath,
  season: variants.season,
  epFrom: variants.epFrom,
  epTo: variants.epTo,
  isPack: variants.isPack,
  categoryId: variants.categoryId,
  qualityRank: variants.qualityRank,
  publishedAt: variants.publishedAt,
  decision: variants.decision,
  reviewReason: variants.reviewReason,
  forumId: topics.forumId,
  forumName: forums.name,
  // `kind` rides along for the Title page's TMDB picker; browse and the feed ignore it.
  kind: topics.kind,
  poster: topics.poster,
  tmdbId: media.tmdbId,
  tvdbId: media.tvdbId,
  imdbId: media.imdbId,
  year: media.year,
  originalLanguage: media.originalLanguage,
  mediaTitle: media.title,
};

export type VariantRow = {
  [K in keyof typeof selected]: (typeof selected)[K] extends { _: { data: infer T } } ? T : never;
};

/**
 * LIMIT/OFFSET are pushed into SQL on purpose. At 25k matching variants, materialising every
 * row and slicing in JS blocks the single Fastify event loop for ~72 ms per request; with the
 * limit applied by SQLite the same query returns 50 rows in ~10-20 ms.
 */
export function search(db: Db, params: SearchParams) {
  const conditions = [inArray(variants.decision, [...HINDI_DECISIONS])];
  if (params.includeAlternatives !== true) conditions.push(eq(variants.isPreferred, true));
  if (params.q) conditions.push(textSearchCondition(params.q));
  if (params.tmdbid !== undefined) conditions.push(eq(media.tmdbId, params.tmdbid));
  if (params.tvdbid !== undefined) conditions.push(eq(media.tvdbId, params.tvdbid));
  // Radarr sends `?imdbid=6478412`; we store `tt6478412`. `'\u0000'` cannot equal a stored id, so an
  // unparseable query matches nothing instead of everything.
  if (params.imdbid) conditions.push(eq(media.imdbId, normaliseImdbId(params.imdbid) ?? '\u0000'));
  if (params.year !== undefined) conditions.push(eq(media.year, params.year));
  if (params.season !== undefined) conditions.push(eq(variants.season, params.season));
  if (params.season !== undefined && params.ep !== undefined) {
    conditions.push(sql`(${variants.epFrom} <= ${params.ep} AND ${variants.epTo} >= ${params.ep})`);
  }
  if (params.categories && params.categories.length > 0) {
    conditions.push(
      or(...params.categories.map((range) => sql`${variants.categoryId} BETWEEN ${range.from} AND ${range.to}`))!,
    );
  }

  // The same torrent is routinely posted in two or three language forums, so one infohash can
  // appear under several topics. Collapse in SQL (best-ranked row per infohash) rather than in
  // JS: collapsing after LIMIT/OFFSET both duplicates rows across pages and returns short pages.
  conditions.push(dedupeByInfohash(params.includeAlternatives === true));

  const windowSize = params.bestVariantOnly ? Math.max((params.offset + params.limit) * 5, 500) : params.limit;

  const fetched = db
    .select(selected)
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .innerJoin(forums, eq(topics.forumId, forums.id))
    .leftJoin(media, eq(variants.mediaId, media.id))
    .where(and(...conditions))
    .orderBy(desc(variants.qualityRank), desc(variants.publishedAt), asc(variants.id))
    .limit(windowSize)
    .offset(params.bestVariantOnly ? 0 : params.offset)
    .all();

  const rows = fetched;

  if (!params.bestVariantOnly) return rows;

  // `bestVariantOnly` collapses further, to one row per title. The offset is applied *after*
  // collapsing, against a window sized from `offset + limit` — otherwise any offset beyond the
  // window returned an empty page with no indication why.
  const best = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = (row.normTitle ?? row.rawTitle)
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/\b(?:1080p|1440p|2160p|720p|480p)\b/, '');
    if (!best.has(key)) best.set(key, row);
  }
  return [...best.values()].slice(params.offset, params.offset + params.limit);
}

export interface BrowseParams {
  /** `hindi` (default) | `all` | a specific decision. */
  decision?: string | undefined;
  resolution?: string | undefined;
  sourceTag?: string | undefined;
  forumId?: number | undefined;
  minSize?: number | undefined;
  maxSize?: number | undefined;
  hasMagnet?: boolean | undefined;
  q?: string | undefined;
  includeAlternatives?: boolean | undefined;
  sort?: 'quality' | 'newest' | 'size' | undefined;
  limit: number;
  offset: number;
}

export function browse(db: Db, params: BrowseParams) {
  const conditions = [];
  if (params.includeAlternatives !== true) conditions.push(eq(variants.isPreferred, true));

  // Hindi-first by default: this endpoint backs the UI, whose job is to show what the indexer
  // would serve. `all` and `not_hindi` stay available because those rows are kept for debugging.
  if (params.decision === undefined || params.decision === 'hindi') {
    conditions.push(inArray(variants.decision, [...HINDI_DECISIONS]));
  } else if (params.decision !== 'all') {
    conditions.push(eq(variants.decision, params.decision as never));
  }
  if (params.resolution) conditions.push(eq(variants.resolution, params.resolution));
  if (params.sourceTag) conditions.push(eq(variants.sourceTag, params.sourceTag));
  if (params.forumId !== undefined) conditions.push(eq(topics.forumId, params.forumId));
  if (params.minSize !== undefined) conditions.push(sql`${variants.sizeBytes} >= ${params.minSize}`);
  if (params.maxSize !== undefined) conditions.push(sql`${variants.sizeBytes} <= ${params.maxSize}`);
  if (params.hasMagnet === true) conditions.push(sql`${variants.magnet} IS NOT NULL`);
  if (params.hasMagnet === false) conditions.push(sql`${variants.magnet} IS NULL`);
  if (params.q) conditions.push(textSearchCondition(params.q));
  conditions.push(dedupeByInfohash(params.includeAlternatives === true));

  const order =
    params.sort === 'newest'
      ? [desc(variants.publishedAt), asc(variants.id)]
      : params.sort === 'size'
        ? [desc(variants.sizeBytes), asc(variants.id)]
        : [desc(variants.qualityRank), asc(variants.id)];

  const rows = db
    .select(selected)
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .innerJoin(forums, eq(topics.forumId, forums.id))
    .leftJoin(media, eq(variants.mediaId, media.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...order)
    .limit(params.limit)
    .offset(params.offset)
    .all();

  const total = db
    .select({ count: sql<number>`count(*)` })
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .get();

  const linkRows = rows.length
    ? db
        .select()
        .from(links)
        .where(
          or(
            inArray(links.variantId, rows.map((row) => row.id)),
            inArray(links.topicId, [...new Set(rows.map((row) => row.topicId ?? 0))]),
          ),
        )
        .all()
    : [];

  return {
    total: total?.count ?? 0,
    rows: rows.map((row) => ({
      ...row,
      // Manual rows carry a synthetic negative id; it is database-internal and must not travel.
      tmdbId: row.tmdbId !== null && row.tmdbId > 0 ? row.tmdbId : null,
      links: linkRows.filter((link) => link.variantId === row.id),
    })),
  };
}

export function stats(db: Db) {
  const byDecision = db
    .select({ decision: variants.decision, count: sql<number>`count(*)` })
    .from(variants)
    .groupBy(variants.decision)
    .all();

  const reviewQueue = db
    .select({ reason: variants.reviewReason, count: sql<number>`count(*)` })
    .from(variants)
    .where(eq(variants.decision, 'unknown'))
    .groupBy(variants.reviewReason)
    .all();

  const counts = db
    .select({
      variants: sql<number>`count(*)`,
      withMagnet: sql<number>`sum(case when ${variants.magnet} is not null then 1 else 0 end)`,
      withTorrent: sql<number>`sum(case when ${variants.torrentLocalPath} is not null then 1 else 0 end)`,
      // Titles per resolution, not a count of preferred rows: the dashboard card claims to show
      // what the *arrs see, and `selectPreferredAcrossTitles()` now guarantees one preferred row
      // per (title, resolution) — but two rows could still carry the flag after a partial crawl,
      // and counting them twice is exactly the overstatement this card was fixed for once already.
      preferred: sql<number>`count(distinct case when ${variants.isPreferred} = 1 then (coalesce(cast(${variants.mediaId} as text), ${variants.normTitle}, ${variants.infohash}) || '|' || coalesce(${variants.resolution}, '')) end)`,
    })
    .from(variants)
    .get();

  // Titles, not releases, and only the ones Browse would show: the two dashboard cards *are* links
  // to /browse, so counting a media row whose every variant is non-preferred or non-Hindi would
  // make the number disagree with the page it opens (`libraryPage` applies the same two predicates).
  const mediaCounts = db
    .select({ type: media.type, count: sql<number>`count(distinct ${media.id})` })
    .from(media)
    .innerJoin(variants, eq(variants.mediaId, media.id))
    .where(and(eq(variants.isPreferred, true), inArray(variants.decision, [...HINDI_DECISIONS])))
    .groupBy(media.type)
    .all();
  const byType = Object.fromEntries(mediaCounts.map((row) => [row.type, row.count]));

  // The real backlog: topics with no servable variant, by why. `deadLetters` counts crawl tasks in
  // `error` — an infrastructure signal — so the dashboard needs both or it shows "0" while
  // thousands of posts wait for a human.
  const unresolvedCounts = db
    .select({ status: topics.status, count: sql<number>`count(*)` })
    .from(topics)
    // `below_floor` is deliberately not backlog: those posts have no release the indexer would
    // serve, so there is nothing for a human to do about them.
    .where(inArray(topics.status, ['external', 'no_link', 'parse_failed', 'gone']))
    .groupBy(topics.status)
    .all();
  const unresolved = Object.fromEntries(
    (['external', 'no_link', 'parse_failed', 'gone'] as const).map((status) => [
      status,
      unresolvedCounts.find((row) => row.status === status)?.count ?? 0,
    ]),
  ) as Record<'external' | 'no_link' | 'parse_failed' | 'gone', number>;

  return {
    topics: db.select({ count: sql<number>`count(*)` }).from(topics).get()?.count ?? 0,
    variants: counts?.variants ?? 0,
    withMagnet: counts?.withMagnet ?? 0,
    withTorrent: counts?.withTorrent ?? 0,
    preferred: counts?.preferred ?? 0,
    unresolved,
    movies: byType['movie'] ?? 0,
    shows: byType['tv'] ?? 0,
    byDecision: Object.fromEntries(byDecision.map((row) => [row.decision, row.count])),
    // A null reason means the row has not been replayed yet (classifier_version 0), which is a
    // different thing from an ambiguous one — name it so the dashboard cannot be misread.
    reviewQueue: Object.fromEntries(reviewQueue.map((row) => [row.reason ?? 'NOT_YET_CLASSIFIED', row.count])),
  };
}

/**
 * Every preferred variant attached to one media row, in the shape the UI's `VariantRow` renders.
 *
 * Shared by the library title page; `titleDetail()` is keyed by topic slug/TMDB id and answers a
 * different question ("what did this upload claim"), so the two cannot simply be merged.
 */
export function variantsForMedia(db: Db, mediaId: number) {
  const rows = db
    .select(selected)
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .innerJoin(forums, eq(topics.forumId, forums.id))
    .leftJoin(media, eq(variants.mediaId, media.id))
    .where(and(eq(variants.mediaId, mediaId), eq(variants.isPreferred, true)))
    .orderBy(desc(variants.qualityRank), asc(variants.id))
    .all();

  const linkRows =
    rows.length === 0
      ? []
      : db
          .select()
          .from(links)
          .where(inArray(links.variantId, rows.map((row) => row.id)))
          .all();

  // One infohash posted in several forums is one release. The grid counts them deduped, so the
  // detail list has to agree or the same torrent appears three times under a "3 releases" card.
  const seen = new Set<string>();
  const deduped = rows.filter((row) => {
    if (seen.has(row.infohash)) return false;
    seen.add(row.infohash);
    return true;
  });

  return deduped.map((row) => ({
    ...row,
    // The manual-bind sentinel is database-internal; see the note in `titleDetail()`.
    tmdbId: row.tmdbId !== null && row.tmdbId > 0 ? row.tmdbId : null,
    links: linkRows.filter((link) => link.variantId === row.id),
  }));
}

export function titleDetail(db: Db, key: string) {
  const rows = db
    .select(selected)
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .innerJoin(forums, eq(topics.forumId, forums.id))
    .leftJoin(media, eq(variants.mediaId, media.id))
    .where(or(eq(topics.slug, key), sql`${media.tmdbId} = ${Number(key) || -1}`))
    .orderBy(desc(variants.qualityRank), asc(variants.id))
    .all();

  if (rows.length === 0) return null;

  const linkRows = db
    .select()
    .from(links)
    .where(
      or(
        inArray(links.variantId, rows.map((row) => row.id)),
        inArray(links.topicId, [...new Set(rows.map((row) => row.topicId ?? 0))]),
      ),
    )
    .all();

  // Resolve through the FK `variants.media_id`, not `media.tmdb_id`: TMDB numbers movies and TV
  // in separate namespaces, so looking up by id alone can attach another title's episodes.
  const linkedVariant = rows.find((row) => row.mediaId !== null);
  const linkedMediaId = linkedVariant?.mediaId ?? null;
  const mediaRow = linkedMediaId !== null ? db.select().from(media).where(eq(media.id, linkedMediaId)).get() : undefined;
  const episodes = mediaRow
    ? db
        .select()
        .from(mediaEpisodes)
        .where(eq(mediaEpisodes.mediaId, mediaRow.id))
        .orderBy(asc(mediaEpisodes.season), asc(mediaEpisodes.episode))
        .all()
    : [];

  // Coverage: which aired episodes does *any* cached variant cover, per season.
  const covered = new Set<string>();
  for (const row of rows) {
    // Only variants that actually reach the indexer count as coverage; a dropped or
    // below-1080p row would otherwise claim episodes nobody can download.
    if (!row.isPreferred) continue;
    if (row.season === null || row.epFrom === null || row.epTo === null) continue;
    const from = Math.max(1, row.epFrom);
    const to = Math.min(row.epTo, from + 500);
    for (let ep = from; ep <= to; ep++) covered.add(`${row.season}:${ep}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const aired = episodes.filter((episode) => episode.airDate !== null && episode.airDate <= today);
  const missing = aired
    .filter((episode) => !covered.has(`${episode.season}:${episode.episode}`))
    .map((episode) => ({ season: episode.season, episode: episode.episode, airDate: episode.airDate, name: episode.name }));

  // Provider fields come from whichever variant is linked to a media row: not every variant of a
  // topic is attached (unlinked ones belong to a different upload of the same topic).
  const linked = linkedVariant ?? rows[0];

  // The picker's prefill: the same helper the review endpoint uses, so both screens ask TMDB the
  // same question about the same topic.
  const hint = searchHint(linked?.slug ?? key, linked?.rawTitle ?? '');

  return {
    episodes: episodes.map((episode) => ({
      season: episode.season,
      episode: episode.episode,
      airDate: episode.airDate,
      name: episode.name,
      covered: covered.has(`${episode.season}:${episode.episode}`),
      aired: episode.airDate !== null && episode.airDate <= today,
    })),
    coverage: { aired: aired.length, covered: aired.filter((episode) => covered.has(`${episode.season}:${episode.episode}`)).length },
    missing,
    title: linked?.mediaTitle ?? linked?.rawTitle ?? key,
    year: linked?.year ?? null,
    // A manual row (OMDb/TVDB attach) carries a negative sentinel in `media.tmdb_id`. It is an
    // internal key, not an identity: exposing it makes the Title page print `tmdb -9216888` and
    // link to a themoviedb.org page that does not exist.
    // A manual row (OMDb/TVDB attach) carries a negative sentinel in `media.tmdb_id`. It is an
    // internal key, not an identity: exposing it makes the Title page print `tmdb -9216888` and
    // link to a themoviedb.org page that does not exist.
    tmdbId: linked && linked.tmdbId !== null && linked.tmdbId > 0 ? linked.tmdbId : null,
    imdbId: linked?.imdbId ?? null,
    poster: linked?.poster ?? null,
    originalLanguage: linked?.originalLanguage ?? null,
    // Display default only: the title page always needs a kind to render, and `other` has no
    // provider namespace of its own.
    kind: mediaKindOf(linked?.kind ?? 'other') ?? 'movie',
    searchQuery: hint.query,
    searchYear: hint.year,
    variants: rows.map((row) => ({ ...row, links: linkRows.filter((link) => link.variantId === row.id) })),
  };
}

export interface CrawlHealth {
  dead: {
    count: number;
    sample: Array<{ url: string; kind: string; attempts: number }>;
  };
  pending: { p0: number; p1: number };
  /** How many media rows still have no TMDB enrichment; 0 means the backfill finished. */
  enrichment: { remaining: number };
  backfill: Array<{
    forum: string;
    sourceForumId: number;
    nextPage: number;
    totalPages: number | null;
    done: boolean;
    percent: number | null;
  }>;
  lastDeltaAt: string | null;
}

/**
 * Operational surface for the two silent failure modes: a URL that has been dead-lettered
 * (retried five times, then parked) and a forum whose backfill stopped early. Without this they
 * are only visible by reading `docker logs`.
 */
export function crawlHealth(db: Db): Omit<CrawlHealth, 'lastDeltaAt'> {
  const deadRows = db
    .select({ url: crawlTasks.url, kind: crawlTasks.kind, attempts: crawlTasks.attempts })
    .from(crawlTasks)
    .where(eq(crawlTasks.state, 'error'))
    .orderBy(desc(crawlTasks.attempts), asc(crawlTasks.id))
    .all();

  const pendingRows = db
    .select({ priority: crawlTasks.priority, count: sql<number>`count(*)` })
    .from(crawlTasks)
    .where(eq(crawlTasks.state, 'pending'))
    .groupBy(crawlTasks.priority)
    .all();

  const backfill = db
    .select({
      forum: forums.name,
      sourceForumId: forums.sourceForumId,
      nextPage: backfillState.nextPage,
      totalPages: backfillState.totalPages,
      done: backfillState.done,
      failures: backfillState.failures,
      lastError: backfillState.lastError,
      retryAfter: backfillState.retryAfter,
    })
    .from(backfillState)
    .innerJoin(forums, eq(backfillState.forumId, forums.id))
    .orderBy(asc(forums.sourceForumId))
    .all()
    .map((row) => ({
      ...row,
      // `nextPage` is the page to fetch next, so a finished forum reads as lastPage + 1 (113% once
      // the count is known, 200% for a one-page empty forum). 100 is the truthful ceiling.
      percent:
        row.totalPages && row.totalPages > 0
          ? Math.min(100, Math.round((row.nextPage / row.totalPages) * 100))
          : null,
    }));

  // "Is the metadata backfill finished?" had no answer anywhere in the UI before this.
  const enrichmentRemaining =
    db.get<{ c: number }>(sql`SELECT count(*) AS c FROM media WHERE vote_average IS NULL AND tmdb_id > 0`)?.c ?? 0;

  return {
    dead: { count: deadRows.length, sample: deadRows.slice(0, 10) },
    pending: {
      p0: pendingRows.find((row) => row.priority === 0)?.count ?? 0,
      p1: pendingRows.find((row) => row.priority === 1)?.count ?? 0,
    },
    enrichment: { remaining: enrichmentRemaining },
    backfill,
  };
}
