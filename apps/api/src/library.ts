import { sql } from 'drizzle-orm';
import type { Db } from '@tamilcache/db';
import { HINDI_DECISIONS as HINDI_DECISION_VALUES, variantsForMedia } from './queries.js';

export interface LibraryParams {
  type?: 'all' | 'movie' | 'tv' | undefined;
  q?: string | undefined;
  quality?: string | undefined;
  health?: 'all' | 'missing' | 'no_hindi' | 'unmatched' | undefined;
  sort?: 'latest' | 'title' | 'coverage' | undefined;
  limit: number;
  offset: number;
}

export interface LibraryTitle {
  mediaId: number;
  type: 'movie' | 'tv';
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  voteAverage: number | null;
  originalLanguage: string | null;
  audioLangs: string[];
  resolutions: string[];
  releases: number;
  latestRelease: string | null;
  largestBytes: number;
  seasons: number | null;
  coverage: { aired: number; covered: number; missing: number } | null;
  noHindi: boolean;
}

export interface UnmatchedRelease {
  id: number;
  slug: string;
  rawTitle: string;
  resolution: string | null;
  sizeBytes: number;
  decision: string;
}

export interface LibraryPage {
  total: number;
  limit: number;
  offset: number;
  titles: LibraryTitle[];
  /** Only on `health=unmatched`: releases that no provider could be matched to. */
  unmatched?: UnmatchedRelease[];
}

const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
const BACKDROP_BASE = 'https://image.tmdb.org/t/p/w780';

/** Same list the Torznab feed filters on; imported so the two lanes cannot drift. */
const HINDI_DECISIONS = sql`(${sql.join(
  HINDI_DECISION_VALUES.map((decision) => sql`${decision}`),
  sql`, `,
)})`;

/**
 * The single source of truth for "what the feed would serve, grouped by title".
 *
 * `ranked` de-duplicates one infohash posted in several forums — the same collapse the Torznab
 * feed performs, done in one window pass rather than a correlated per-row subquery.
 *
 * The decision and `media_id IS NOT NULL` predicates belong *inside* `ranked`, before the
 * partition is numbered. Outside it they run too late: when the highest-ranked copy of an
 * infohash is unmatched, that copy wins `rn = 1` and the matched twin is discarded, so a title
 * vanishes from Browse (and from the grid's release count) while Radarr/Sonarr still get the
 * release. That is the exact divergence this CTE exists to prevent.
 */
function keptCte(decisions: 'hindi' | 'no_hindi' = 'hindi', quality?: string) {
  const decisionFilter = decisions === 'hindi' ? HINDI_DECISIONS : sql`('not_hindi','unknown')`;
  return sql`WITH ranked AS (
      SELECT v.id, v.media_id, v.infohash, v.decision, v.resolution, v.audio_langs,
             v.size_bytes, v.published_at, v.season, v.ep_from, v.ep_to, v.quality_rank,
             ROW_NUMBER() OVER (
               PARTITION BY v.infohash, v.decision
               ORDER BY v.quality_rank DESC, v.id ASC
             ) AS rn
      FROM variants v
      WHERE v.is_preferred = 1
        AND v.media_id IS NOT NULL
        AND v.decision IN ${decisionFilter}
        ${quality === undefined ? sql`` : sql`AND v.resolution = ${quality}`}
    ), kept AS (
      SELECT * FROM ranked WHERE rn = 1
    )`;
}

/** `%` and `_` are LIKE wildcards; a typed one must not widen the search. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function whereClause(params: LibraryParams) {
  const parts = [];
  if (params.type === 'movie' || params.type === 'tv') parts.push(sql`m.type = ${params.type}`);
  if (params.q !== undefined && params.q.trim() !== '') {
    parts.push(sql`lower(m.title) LIKE ${`%${escapeLike(params.q.trim().toLowerCase())}%`} ESCAPE '\\'`);
  }
  return parts.length === 0 ? sql`` : sql`WHERE ${sql.join(parts, sql` AND `)}`;
}

function orderClause(sort: LibraryParams['sort']) {
  // `coverage` is ordered in JS after the episode join (see `sortInJs`); this only has to be stable.
  if (sort === 'title' || sort === 'coverage') return sql`lower(m.title) ASC, m.id ASC`;
  return sql`max(k.published_at) DESC, m.id ASC`;
}

interface TitleRow {
  mediaId: number;
  type: 'movie' | 'tv';
  title: string;
  year: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number | null;
  original_language: string | null;
  seasons: number | null;
  releases: number;
  latestRelease: string | null;
  largestBytes: number;
  resolutions: string | null;
  langJson: string | null;
}

export function libraryPage(db: Db, params: LibraryParams): LibraryPage {
  // A non-integer `LIMIT` is a SQLite datatype error (500), so the value is truncated, not trusted.
  const limit = Math.min(Math.max(Math.trunc(params.limit) || 1, 1), 100);
  const decisions = params.health === 'no_hindi' ? 'no_hindi' : 'hindi';
  const where = whereClause(params);

  if (params.health === 'unmatched') {
    return unmatchedPage(db, limit, Math.max(params.offset, 0));
  }

  // `health=missing` replaces `total` with the post-coverage count, so counting here would run the
  // whole CTE twice for a number that is thrown away.
  const total =
    params.health === 'missing'
      ? 0
      : (db.get<{ c: number }>(sql`
          ${keptCte(decisions, params.quality)}
          SELECT count(DISTINCT k.media_id) AS c FROM kept k JOIN media m ON m.id = k.media_id
          ${where}
        `)?.c ?? 0);

  // A stale bookmark past the end must render the last page, not an empty grid.
  const maxOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
  const offset = Math.min(Math.max(params.offset, 0), maxOffset);

  // "Coverage" sorts and the `missing` health filter both need what only exists after the episode
  // join. Materialising the (533-row) TV library and slicing in JS keeps that honest instead of
  // approximating it in SQL and paginating a lie.
  const sortInJs = params.sort === 'coverage' || params.health === 'missing';
  const rows = db.all<TitleRow>(sql`
    ${keptCte(decisions, params.quality)}
    SELECT m.id AS mediaId, m.type, m.title, m.year, m.poster_path, m.backdrop_path, m.vote_average,
           m.original_language, m.seasons,
           count(*) AS releases,
           max(k.published_at) AS latestRelease,
           max(k.size_bytes) AS largestBytes,
           group_concat(DISTINCT k.resolution) AS resolutions,
           group_concat(DISTINCT k.audio_langs) AS langJson
    FROM kept k JOIN media m ON m.id = k.media_id
    ${where}
    GROUP BY m.id
    ORDER BY ${orderClause(params.sort)}
    ${sortInJs ? sql`LIMIT -1` : sql`LIMIT ${limit} OFFSET ${offset}`}
  `);

  // Only TV rows can have episode coverage; skipping movie ids keeps the coverage sort off the
  // 2,000+ movie rows that have no episodes at all.
  const tvIds = rows.filter((row) => row.type === 'tv').map((row) => row.mediaId);
  const coverage = coverageFor(db, tvIds);

  const titles = rows.map((row) => {
    const counts = coverage.get(row.mediaId);
    return {
      mediaId: row.mediaId,
      type: row.type,
      title: row.title,
      year: row.year,
      poster: row.poster_path === null ? null : `${POSTER_BASE}${row.poster_path}`,
      backdrop: row.backdrop_path === null ? null : `${BACKDROP_BASE}${row.backdrop_path}`,
      voteAverage: row.vote_average,
      originalLanguage: row.original_language,
      audioLangs: parseLangJson(row.langJson),
      resolutions: (row.resolutions ?? '').split(',').filter(Boolean),
      releases: row.releases,
      latestRelease: row.latestRelease,
      largestBytes: row.largestBytes,
      seasons: row.seasons,
      // A show with no provider episode list cannot be called covered or missing; `null` says so
      // and the card falls back to resolution/size instead of inventing 0/0.
      coverage: row.type === 'tv' && counts !== undefined ? { ...counts } : null,
      noHindi: decisions === 'no_hindi',
    };
  });

  if (params.health === 'missing') {
    const incomplete = titles.filter((title) => title.type === 'tv' && (title.coverage?.missing ?? 0) > 0);
    const maxOffset = incomplete.length === 0 ? 0 : Math.floor((incomplete.length - 1) / limit) * limit;
    const clamped = Math.min(offset, maxOffset);
    const ordered = params.sort === 'coverage'
      ? [...incomplete].sort((a, b) => (b.coverage?.missing ?? 0) - (a.coverage?.missing ?? 0) || a.title.localeCompare(b.title))
      : incomplete;
    return { total: incomplete.length, limit, offset: clamped, titles: ordered.slice(clamped, clamped + limit) };
  }

  if (!sortInJs) {
    return { total, limit, offset, titles };
  }

  const sorted = [...titles].sort((a, b) => (b.coverage?.missing ?? 0) - (a.coverage?.missing ?? 0) || a.title.localeCompare(b.title));
  return { total, limit, offset, titles: sorted.slice(offset, offset + limit) };
}

/**
 * The `unmatched` lane: preferred Hindi releases with no provider identity. They cannot form a
 * card (no title, year or poster), so they travel as release rows and link to the release page.
 */
function unmatchedPage(db: Db, limit: number, offset: number): LibraryPage {
  // Callers pass already-truncated integers; see `libraryPage`.
  const total =
    db.get<{ c: number }>(sql`
      SELECT count(*) AS c FROM variants v
      WHERE v.is_preferred = 1 AND v.media_id IS NULL AND v.decision IN ${HINDI_DECISIONS}
    `)?.c ?? 0;

  const rows = db.all<{
    id: number;
    slug: string;
    rawTitle: string;
    resolution: string | null;
    sizeBytes: number;
    decision: string;
  }>(sql`
    SELECT v.id, t.slug, t.raw_title AS rawTitle, v.resolution, v.size_bytes AS sizeBytes, v.decision
    FROM variants v JOIN topics t ON t.id = v.topic_id
    WHERE v.is_preferred = 1 AND v.media_id IS NULL AND v.decision IN ${HINDI_DECISIONS}
    ORDER BY v.published_at DESC, v.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { total, limit, offset, titles: [], unmatched: rows };
}

/**
 * `audio_langs` is a JSON array per variant; `group_concat` produces `["tamil"],["hindi","tamil"]`.
 * Parsing the quoted names back out is safe because the values are lower-case language slugs with
 * no quotes or escapes of their own.
 */
export interface TitleSuggestion {
  mediaId: number;
  title: string;
  year: number | null;
  type: 'movie' | 'tv';
  poster: string | null;
}

const SUGGEST_LIMIT = 8;

/**
 * Word-prefix title search for the suggestion dropdown.
 *
 * Every whitespace-separated token must start a word in the title: `spid` finds Spider-Man,
 * `avatar way` finds Avatar: The Way of Water, and `ider` finds nothing. Implemented against the
 * 4,808-row `media` table rather than an FTS index — measured at 0.7 ms, so a second index would
 * be furniture.
 */
export function suggestTitles(db: Db, raw: string): TitleSuggestion[] {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return [];
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const conditions = tokens.map(
    (token) =>
      sql`(' ' || lower(replace(m.title, '-', ' ')) || ' ') LIKE ${`% ${escapeLike(token)}%`} ESCAPE '\\'`,
  );

  const rows = db.all<{
    mediaId: number;
    title: string;
    year: number | null;
    type: 'movie' | 'tv';
    poster_path: string | null;
  }>(sql`
    SELECT m.id AS mediaId, m.title, m.year, m.type, m.poster_path
    FROM media m
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY
      CASE WHEN lower(m.title) LIKE ${`${escapeLike(tokens[0] as string)}%`} ESCAPE '\\' THEN 0 ELSE 1 END,
      length(m.title) ASC,
      m.year DESC
    LIMIT ${SUGGEST_LIMIT}
  `);

  return rows.map((row) => ({
    mediaId: row.mediaId,
    title: row.title,
    year: row.year,
    type: row.type,
    poster: row.poster_path === null ? null : `${POSTER_BASE}${row.poster_path}`,
  }));
}

/** Aired-vs-covered per media row, from the episodes the provider gave and the ranges we cache. */
function coverageFor(db: Db, ids: number[]): Map<number, { aired: number; covered: number; missing: number }> {
  if (ids.length === 0) return new Map();
  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const today = new Date().toISOString().slice(0, 10);

  const episodeRows = db.all<{ mediaId: number; season: number; episode: number; airDate: string | null }>(sql`
    SELECT media_id AS mediaId, season, episode, air_date AS airDate
    FROM media_episodes WHERE media_id IN (${list})
  `);
  if (episodeRows.length === 0) return new Map();

  const rangeRows = db.all<{ mediaId: number; season: number; epFrom: number; epTo: number }>(sql`
    SELECT media_id AS mediaId, season, ep_from AS epFrom, ep_to AS epTo
    FROM variants
    WHERE is_preferred = 1 AND media_id IN (${list})
      AND season IS NOT NULL AND ep_from IS NOT NULL AND ep_to IS NOT NULL
  `);

  // Membership, not expansion: a complete `S01E01–E600` pack must cover 600 episodes. The old
  // `from + 500` loop cap silently invented missing episodes for long-running Tamil serials.
  const rangesByMedia = new Map<number, Array<{ season: number; from: number; to: number }>>();
  for (const range of rangeRows) {
    const list = rangesByMedia.get(range.mediaId) ?? [];
    list.push({ season: range.season, from: Math.max(1, range.epFrom), to: range.epTo });
    rangesByMedia.set(range.mediaId, list);
  }

  const totals = new Map<number, { aired: number; covered: number; missing: number }>();
  for (const row of episodeRows) {
    const current = totals.get(row.mediaId) ?? { aired: 0, covered: 0, missing: 0 };
    if (row.airDate !== null && row.airDate <= today && row.season !== 0) {
      current.aired += 1;
      const ranges = rangesByMedia.get(row.mediaId) ?? [];
      const covered = ranges.some(
        (range) => range.season === row.season && row.episode >= range.from && row.episode <= range.to,
      );
      if (covered) current.covered += 1;
      else current.missing += 1;
    }
    totals.set(row.mediaId, current);
  }
  return totals;
}

export interface LibraryEpisode {
  season: number;
  episode: number;
  airDate: string | null;
  name: string | null;
  aired: boolean;
  covered: boolean;
}

export interface LibrarySeason {
  season: number;
  episodes: LibraryEpisode[];
  aired: number;
  covered: number;
}

export interface TitleDetail {
  media: {
    mediaId: number;
    type: 'movie' | 'tv';
    title: string;
    year: number | null;
    originalLanguage: string | null;
    imdbId: string | null;
    tvdbId: number | null;
    tmdbId: number | null;
    seasons: number | null;
    poster: string | null;
    backdrop: string | null;
    overview: string | null;
    voteAverage: number | null;
    voteCount: number | null;
    runtime: number | null;
    genres: string[];
    status: string | null;
  };
  availability: 'hindi_ready' | 'no_hindi';
  releases: ReturnType<typeof variantsForMedia>;
  seasons: LibrarySeason[] | null;
  coverage: { aired: number; covered: number };
  missing: Array<{ season: number; episode: number; airDate: string | null; name: string | null }>;
}

interface MediaRow {
  mediaId: number;
  tmdbId: number;
  type: 'movie' | 'tv';
  title: string;
  year: number | null;
  originalLanguage: string | null;
  imdbId: string | null;
  tvdbId: number | null;
  seasons: number | null;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string | null;
  vote_average: number | null;
  vote_count: number | null;
  runtime: number | null;
  status: string | null;
  genres: string | null;
}

export function titleByMediaId(db: Db, mediaId: number): TitleDetail | null {
  const mediaRow = db.get<MediaRow>(sql`
    SELECT id AS mediaId, tmdb_id AS tmdbId, type, title, year, original_language AS originalLanguage,
           imdb_id AS imdbId, tvdb_id AS tvdbId, seasons, poster_path, backdrop_path, overview,
           vote_average, vote_count, runtime, status, genres
    FROM media WHERE id = ${mediaId}
  `);
  if (mediaRow === undefined) return null;

  const releases = variantsForMedia(db, mediaId);
  const today = new Date().toISOString().slice(0, 10);

  const episodeRows = db.all<{ season: number; episode: number; airDate: string | null; name: string | null }>(sql`
    SELECT season, episode, air_date AS airDate, name FROM media_episodes
    WHERE media_id = ${mediaId} ORDER BY season ASC, episode ASC
  `);

  // Coverage is an intersection: a release claiming S01E01–E99 must not mark episodes the
  // provider never listed, and only preferred releases count (a dropped row downloads nothing).
  // Membership is tested per episode rather than by expanding each range to a set — expansion
  // needs a loop cap, and any cap truncates a legitimate 600-episode serial.
  const releaseRanges = releases
    .filter((release) => release.season !== null && release.epFrom !== null && release.epTo !== null)
    .map((release) => ({ season: release.season as number, from: Math.max(1, release.epFrom as number), to: release.epTo as number }));

  const episodes: LibraryEpisode[] = episodeRows.map((row) => ({
    season: row.season,
    episode: row.episode,
    airDate: row.airDate,
    name: row.name,
    aired: row.airDate !== null && row.airDate <= today,
    covered: releaseRanges.some(
      (range) => range.season === row.season && row.episode >= range.from && row.episode <= range.to,
    ),
  }));

  const bySeason = new Map<number, LibraryEpisode[]>();
  for (const episode of episodes) {
    const list = bySeason.get(episode.season) ?? [];
    list.push(episode);
    bySeason.set(episode.season, list);
  }

  const seasons: LibrarySeason[] | null =
    episodes.length === 0
      ? null
      : [...bySeason.entries()]
          // Specials (season 0) last: they are not part of the aired run and would otherwise sort
          // ahead of season 1 and dominate the coverage bar.
          .sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
          .map(([season, list]) => ({
            season,
            episodes: list,
            aired: list.filter((episode) => episode.aired).length,
            covered: list.filter((episode) => episode.aired && episode.covered).length,
          }));

  // Specials are shown but never counted: they are not part of the aired run, and an aired
  // featurette would otherwise make every such series look permanently incomplete.
  const aired = episodes.filter((episode) => episode.aired && episode.season !== 0);

  return {
    media: {
      mediaId: mediaRow.mediaId,
      type: mediaRow.type,
      title: mediaRow.title,
      year: mediaRow.year,
      originalLanguage: mediaRow.originalLanguage,
      imdbId: mediaRow.imdbId,
      tvdbId: mediaRow.tvdbId,
      // Manual binds carry a negative sentinel; it is an internal key, not an identity.
      tmdbId: mediaRow.tmdbId > 0 ? mediaRow.tmdbId : null,
      seasons: mediaRow.seasons,
      poster: mediaRow.poster_path === null ? null : `${POSTER_BASE}${mediaRow.poster_path}`,
      backdrop: mediaRow.backdrop_path === null ? null : `${BACKDROP_BASE}${mediaRow.backdrop_path}`,
      overview: mediaRow.overview,
      voteAverage: mediaRow.vote_average,
      voteCount: mediaRow.vote_count,
      runtime: mediaRow.runtime,
      genres: parseGenres(mediaRow.genres),
      status: mediaRow.status,
    },
    availability: releases.some((row) => row.decision === 'hindi_dubbed' || row.decision === 'hindi_original')
      ? 'hindi_ready'
      : 'no_hindi',
    releases,
    seasons,
    coverage: { aired: aired.length, covered: aired.filter((episode) => episode.covered).length },
    missing: aired
      .filter((episode) => !episode.covered)
      .map(({ season, episode, airDate, name }) => ({ season, episode, airDate, name })),
  };
}

function parseGenres(blob: string | null): string[] {
  if (blob === null) return [];
  try {
    const parsed: unknown = JSON.parse(blob);
    return Array.isArray(parsed) ? parsed.filter((genre): genre is string => typeof genre === 'string') : [];
  } catch {
    return [];
  }
}

function parseLangJson(blob: string | null): string[] {
  if (blob === null) return [];
  const found = new Set<string>();
  for (const match of blob.matchAll(/"([a-z_]+)"/g)) found.add(match[1] as string);
  return [...found].sort();
}
