import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '@tamilcache/db';
import { media, mediaEpisodes, metadataCache, topics, variants } from '@tamilcache/db/schema';
import {
  decideMatchAcrossTypes,
  imdbIdDigits,
  normaliseImdbId,
  queryFromSlug,
  yearsInSlug,
  type MatchOutcome,
  type MediaKind,
  type TmdbCandidate,
} from '@tamilcache/shared';
import { getState, setState } from './state.js';
import { TmdbRateLimitedError, type TmdbClient, type TmdbDetails, type TmdbEpisode } from './tmdb.js';

export interface ProviderPassOptions {
  /** How many topics to resolve per invocation; keeps a tick short and resumable. */
  limit?: number;
  /** Season numbers to fetch per show. Beyond this the episode list is not worth the API calls. */
  maxSeasons?: number;
  /** Re-check topics that previously found nothing, after this many days. */
  noneTtlDays?: number;
}

export interface ProviderPassResult {
  checked: number;
  matched: number;
  ambiguous: number;
  none: number;
  errors: number;
  /** Set when TMDB returned 429; the worker sets a backoff window and skips later passes. */
  rateLimitedMs?: number;
}

interface CacheRow {
  payload: string;
}

function readCache<T>(db: Db, queryKey: string, isValid: (value: unknown) => value is T): T | null {
  const row = db.select().from(metadataCache).where(eq(metadataCache.queryKey, queryKey)).get() as CacheRow | undefined;
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    // A cached payload is trusted input to the scorer, so it is shape-checked on the way out:
    // a candidate missing `popularity` used to yield a NaN score, which `decideMatch` read as
    // "not below threshold" and accepted.
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCandidateList(value: unknown): value is TmdbCandidate[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const candidate = item as Partial<TmdbCandidate>;
      return (
        typeof candidate.id === 'number' &&
        (candidate.mediaType === 'movie' || candidate.mediaType === 'tv') &&
        typeof candidate.title === 'string' &&
        (candidate.year === null || typeof candidate.year === 'number') &&
        typeof candidate.popularity === 'number' &&
        Number.isFinite(candidate.popularity)
      );
    })
  );
}

function isDetails(value: unknown): value is TmdbDetails {
  const details = value as Partial<TmdbDetails>;
  return typeof details.id === 'number' && (details.mediaType === 'movie' || details.mediaType === 'tv');
}

function writeCache(db: Db, queryKey: string, payload: unknown): void {
  db.insert(metadataCache)
    .values({ queryKey, payload: JSON.stringify(payload) })
    .onConflictDoNothing()
    .run();
}

/** Cached search: one TMDB request per (query, year) for the life of the database. */
async function cachedSearch(
  db: Db,
  tmdb: TmdbClient,
  query: string,
  year: number | null,
): Promise<TmdbCandidate[]> {
  const key = `tmdb:search:${query.toLowerCase()}:${year ?? ''}`;
  const cached = readCache<TmdbCandidate[]>(db, key, isCandidateList);
  if (cached) return cached;
  const fresh = await tmdb.search(query, { year });
  // An empty result is not cached: a film added to TMDB tomorrow must not be permanently
  // `none` because we asked about it today.
  if (fresh.length > 0) writeCache(db, key, fresh);
  return fresh;
}

/**
 * A cached payload written before schema v9 has no enrichment keys at all. `isDetails()` accepts
 * it — it only needs `id`/`mediaType` — so the widening has to be repaired here.
 *
 * Without this, `attachMedia()` dereferences `details.genres.length` on `undefined` and throws a
 * `TypeError` that takes down the *whole* provider lane for that tick: on an upgraded volume the
 * ~4,800 old cache rows silently stop every new release from attaching. That is the exact failure
 * this function exists to prevent, so do not "simplify" it away.
 */
function normaliseDetails(details: TmdbDetails): TmdbDetails {
  return {
    ...details,
    genres: Array.isArray(details.genres) ? details.genres : [],
    voteAverage: details.voteAverage ?? null,
    voteCount: details.voteCount ?? null,
    runtime: details.runtime ?? null,
    backdropPath: details.backdropPath ?? null,
    status: details.status ?? null,
  };
}

async function cachedDetails(db: Db, tmdb: TmdbClient, kind: MediaKind, id: number): Promise<TmdbDetails> {
  const key = `tmdb:details:${kind}:${id}`;
  const cached = readCache<TmdbDetails>(db, key, isDetails);
  if (cached) return normaliseDetails(cached);
  const fresh = await tmdb.details(kind, id);
  // Do not cache details fetched while `external_ids` was failing: the null ids would otherwise
  // be permanent, and one transient 502 would erase a good imdb id for every topic on this row.
  if (fresh.externalIdsOk !== false) writeCache(db, key, fresh);
  return normaliseDetails(fresh);
}

/** The one place `topics.kind` becomes the scorer's MediaKind. The review API reuses it. */
export function mediaKindOf(kind: string): MediaKind | null {
  if (kind === 'show') return 'tv';
  if (kind === 'movie') return 'movie';
  return null;
}

/** Upserts the media row and points every variant of the topic at it. */
function attachMedia(db: Db, topicId: number, details: TmdbDetails, meta: { seasons: number | null }): number {
  const existing = db.select().from(media).where(eq(media.tmdbId, details.id)).get();
  let mediaId: number;

  if (existing) {
    if (existing.type !== details.mediaType) {
      // TMDB numbers movies and TV in separate namespaces, so id 1399 can be both. `media.tmdb_id`
      // is UNIQUE, so attaching here would overwrite the other title's language and episodes.
      throw new Error(
        `tmdb id ${details.id} is already stored as ${existing.type}, refusing to attach it as ${details.mediaType}`,
      );
    }
    mediaId = existing.id;
    // Merge, never blank: `details` legitimately carries nulls when `external_ids` failed, and
    // overwriting a known imdb id with null loses data permanently.
    db.update(media)
      .set({
        originalLanguage: details.originalLanguage ?? existing.originalLanguage,
        imdbId: details.imdbId ?? existing.imdbId,
        tvdbId: details.tvdbId ?? existing.tvdbId,
        seasons: meta.seasons ?? existing.seasons,
        posterPath: details.posterPath ?? existing.posterPath,
        overview: details.overview ?? existing.overview,
        // Same merge rule as the ids above: an old cached payload predates schema v9 and carries
        // no enrichment, so a re-attach must not erase what a backfill has since filled in.
        genres: details.genres.length > 0 ? details.genres : existing.genres,
        voteAverage: details.voteAverage ?? existing.voteAverage,
        voteCount: details.voteCount ?? existing.voteCount,
        runtime: details.runtime ?? existing.runtime,
        backdropPath: details.backdropPath ?? existing.backdropPath,
        status: details.status ?? existing.status,
      })
      .where(eq(media.id, mediaId))
      .run();
  } else {
    mediaId = db
      .insert(media)
      .values({
        tmdbId: details.id,
        type: details.mediaType,
        title: details.title,
        year: details.year,
        originalLanguage: details.originalLanguage,
        imdbId: details.imdbId,
        tvdbId: details.tvdbId,
        seasons: meta.seasons,
        posterPath: details.posterPath,
        overview: details.overview,
        genres: details.genres,
        voteAverage: details.voteAverage,
        voteCount: details.voteCount,
        runtime: details.runtime,
        backdropPath: details.backdropPath,
        status: details.status,
      })
      .returning()
      .get().id;
  }

  db.update(variants).set({ mediaId }).where(eq(variants.topicId, topicId)).run();
  return mediaId;
}

/**
 * Fills the schema-v9 enrichment columns for media rows that predate them.
 *
 * The work list is `vote_average IS NULL`, so the batch is idempotent and resumable. A cursor in
 * `app_state` walks the ids in order and wraps around when it runs out: without it, one media row
 * whose TMDB id is permanently gone sits at the head of `ORDER BY id` and every later row starves
 * forever — the batch reports `enriched: 0` every tick and nothing ever moves.
 *
 * Rows with a negative `tmdb_id` are manual binds and are never sent to TMDB.
 */
export async function enrichBatch(
  db: Db,
  tmdb: TmdbClient,
  options: { limit: number },
): Promise<{ enriched: number; failed: number; remaining: number | null; rateLimitedMs: number | null }> {
  const cursor = Number(getState(db, 'enrich_cursor') ?? 0);
  const workList = (after: number) =>
    db
      .select({ id: media.id, tmdbId: media.tmdbId, type: media.type })
      .from(media)
      .where(and(isNull(media.voteAverage), sql`${media.tmdbId} > 0`, sql`${media.id} > ${after}`))
      .orderBy(media.id)
      .limit(options.limit)
      .all();

  // Past the end of the table: wrap so retried rows come round again after a full cycle.
  let rows = workList(cursor);
  if (rows.length === 0 && cursor > 0) {
    rows = workList(0);
  }

  let enriched = 0;
  let failed = 0;
  let reached = cursor;
  for (const row of rows) {
    reached = row.id;
    try {
      const details = await cachedDetails(db, tmdb, row.type === 'tv' ? 'tv' : 'movie', row.tmdbId);
      db.update(media)
        .set({
          genres: details.genres,
          voteAverage: details.voteAverage,
          voteCount: details.voteCount,
          runtime: details.runtime,
          backdropPath: details.backdropPath,
          status: details.status,
        })
        .where(eq(media.id, row.id))
        .run();
      enriched += 1;
    } catch (error) {
      if (error instanceof TmdbRateLimitedError) {
        setState(db, 'enrich_cursor', String(reached));
        return { enriched, failed, remaining: null, rateLimitedMs: error.retryAfterMs };
      }
      // One 404 or timeout must not stop the batch, but it must be *counted*: a silently stuck
      // backfill is indistinguishable from a finished one.
      failed += 1;
    }
  }
  setState(db, 'enrich_cursor', String(reached));

  const remaining =
    db.get<{ c: number }>(sql`SELECT count(*) AS c FROM media WHERE vote_average IS NULL AND tmdb_id > 0`)?.c ?? 0;
  return { enriched, failed, remaining, rateLimitedMs: null };
}

async function storeEpisodes(db: Db, tmdb: TmdbClient, mediaId: number, tmdbId: number, maxSeasons: number): Promise<void> {
  const seasons = (await tmdb.seasonNumbers(tmdbId)).slice(0, maxSeasons);
  for (const season of seasons) {
    const episodes = await tmdb.seasonEpisodes(tmdbId, season);
    for (const episode of episodes) {
      db.insert(mediaEpisodes)
        .values({
          mediaId,
          season: episode.season,
          episode: episode.episode,
          airDate: episode.airDate,
          name: episode.name,
        })
        .onConflictDoNothing()
        .run();
    }
  }
}

function proposalPayload(outcome: MatchOutcome): string | null {
  if (outcome.status !== 'ambiguous' || !outcome.proposal) return null;
  return JSON.stringify({
    tmdbId: outcome.proposal.id,
    mediaType: outcome.proposal.mediaType,
    title: outcome.proposal.title,
    year: outcome.proposal.year,
    originalLanguage: outcome.proposal.originalLanguage,
    score: outcome.proposal.score,
    reasons: outcome.proposal.reasons,
    runnerUp: outcome.runnerUp
      ? { tmdbId: outcome.runnerUp.id, title: outcome.runnerUp.title, score: outcome.runnerUp.score }
      : null,
  });
}

/**
 * Resolve one topic against TMDB.
 *
 * Runs *before* replay, so the classifier's provider branch has something to read. A topic is
 * checked once: `provider_checked_at` is the guard, and ambiguous ones are only rechecked when a
 * human clears that stamp (via the review queue's "retry" action).
 */
export async function resolveTopicProvider(
  db: Db,
  tmdb: TmdbClient,
  topicId: number,
  options: ProviderPassOptions = {},
): Promise<'matched' | 'ambiguous' | 'none'> {
  const topic = db.select().from(topics).where(eq(topics.id, topicId)).get();
  if (!topic) throw new Error(`topic ${topicId} not found`);

  // `other` is a strong verdict (trailer, songs, audio launch): it is not a film or a show, so
  // searching TMDB for it only produces a wrong match the review queue then has to undo.
  if (topic.kind === 'other') {
    db.update(topics)
      .set({ providerStatus: 'skipped', providerCheckedAt: new Date().toISOString() })
      .where(eq(topics.id, topicId))
      .run();
    return 'none';
  }

  const kindHint = mediaKindOf(topic.kind);
  const { query, year } = queryFromSlug(topic.slug);
  if (!query) {
    db.update(topics)
      .set({ providerStatus: 'skipped', providerCheckedAt: new Date().toISOString() })
      .where(eq(topics.id, topicId))
      .run();
    return 'none';
  }

  const candidates = await cachedSearch(db, tmdb, query, year);
  // `year` is the preferred (last) year; `years` is every year the slug named, so a re-release
  // slug cannot disqualify the film it names.
  // The hint is a preference, never a gate. Scoring only the hinted namespace would let a wrong
  // hint veto the other one: a topic filed as `movie` by the old season-tag heuristic could never
  // bind the `tv` entry that is actually correct. `decideMatchAcrossTypes` scores both and lets
  // the hint win only an exact tie, so no hint can hide the right answer.
  const outcome = decideMatchAcrossTypes(candidates, {
    query,
    year,
    years: yearsInSlug(topic.slug),
    kindHint,
  });

  if (outcome.status === 'matched') {
    const best = outcome.candidate;
    const details = await cachedDetails(db, tmdb, best.mediaType, best.id);

    // Episodes are fetched *before* the transaction (they are network calls) but written inside
    // it, so a crash cannot leave a topic stamped 'matched' with a half-populated season list.
    const episodes: TmdbEpisode[] = [];
    if (details.mediaType === 'tv') {
      const seasons = (await tmdb.seasonNumbers(details.id)).slice(0, options.maxSeasons ?? 5);
      for (const season of seasons) episodes.push(...(await tmdb.seasonEpisodes(details.id, season)));
    }

    db.transaction(
      () => {
        const mediaId = attachMedia(db, topicId, details, { seasons: details.seasons });
        for (const episode of episodes) {
          db.insert(mediaEpisodes)
            .values({
              mediaId,
              season: episode.season,
              episode: episode.episode,
              airDate: episode.airDate,
              name: episode.name,
            })
            .onConflictDoNothing()
            .run();
        }
        db.update(topics)
          .set({
            providerStatus: 'matched',
            providerProposal: null,
            providerCheckedAt: new Date().toISOString(),
            kind: best.mediaType === 'tv' ? 'show' : 'movie',
            kindSource: 'tmdb',
          })
          .where(eq(topics.id, topicId))
          .run();
        // replay never writes category_id, so a corrected kind would otherwise leave the release
        // filed as a movie until it is re-crawled.
        db.update(variants).set({ categoryId: best.mediaType === 'tv' ? 5030 : 2040 }).where(eq(variants.topicId, topicId)).run();
      },
      { behavior: 'immediate' },
    );
    return 'matched';
  }

  db.update(topics)
    .set({
      providerStatus: outcome.status === 'ambiguous' ? 'ambiguous' : 'none',
      providerProposal: proposalPayload(outcome),
      providerCheckedAt: new Date().toISOString(),
    })
    .where(eq(topics.id, topicId))
    .run();
  return outcome.status === 'ambiguous' ? 'ambiguous' : 'none';
}

/** Resolves every topic that has not been checked yet, cheapest-first. */
export async function runProviderPass(
  db: Db,
  tmdb: TmdbClient | null,
  options: ProviderPassOptions = {},
): Promise<ProviderPassResult> {
  const result: ProviderPassResult = { checked: 0, matched: 0, ambiguous: 0, none: 0, errors: 0 };
  if (!tmdb) return result;

  // `none` is retried after `noneTtlDays`: TMDB's catalogue keeps growing, and a film that did
  // not exist last month must not stay unmatched forever.
  const noneTtlDays = options.noneTtlDays ?? 30;
  const noneCutoff = new Date(Date.now() - noneTtlDays * 86_400_000).toISOString();

  const pending = db
    .select({ id: topics.id })
    .from(topics)
    .where(
      and(
        eq(topics.status, 'parsed'),
        ne(topics.kind, 'other'),
        sql`(${topics.providerCheckedAt} IS NULL OR (${topics.providerStatus} = 'none' AND ${topics.providerCheckedAt} < ${noneCutoff}))`,
      ),
    )
    .orderBy(topics.id)
    .limit(options.limit ?? 25)
    .all();

  for (const topic of pending) {
    try {
      const status = await resolveTopicProvider(db, tmdb, topic.id, options);
      result.checked++;
      result[status]++;
    } catch (error) {
      if (error instanceof TmdbRateLimitedError) {
        // Stop the whole pass and back off: hammering a rate-limited API at one tick per second
        // is how a personal crawler gets blocked.
        result.rateLimitedMs = error.retryAfterMs;
        break;
      }
      // A single TMDB failure must not abort the pass: the topic stays unchecked and is retried
      // on the next tick, which is exactly the resume behaviour we want.
      result.errors++;
    }
  }

  return result;
}

/** Clears the check stamp so the next pass re-queries (used after a human rejects a proposal). */
export function resetProviderCheck(db: Db, topicId: number): void {
  db.update(topics)
    .set({ providerStatus: 'pending', providerProposal: null, providerCheckedAt: null })
    .where(eq(topics.id, topicId))
    .run();
}

/** Manual bind from the review UI: attach a specific TMDB id, bypassing scoring. */
export async function bindTopicToTmdb(
  db: Db,
  tmdb: TmdbClient,
  topicId: number,
  tmdbId: number,
  mediaType: MediaKind,
): Promise<{ mediaId: number; originalLanguage: string | null }> {
  const details = await cachedDetails(db, tmdb, mediaType, tmdbId);
  const mediaId = attachMedia(db, topicId, details, { seasons: details.seasons });
  if (details.mediaType === 'tv') await storeEpisodes(db, tmdb, mediaId, details.id, 10);
  db.update(topics)
    .set({ providerStatus: 'matched', providerProposal: null, providerCheckedAt: new Date().toISOString() })
    .where(eq(topics.id, topicId))
    .run();
  return { mediaId, originalLanguage: details.originalLanguage };
}

export class TmdbAmbiguousImdbError extends Error {
  constructor(public readonly candidates: TmdbCandidate[]) {
    super(`tmdb has ${candidates.length} titles for that imdb id; pick one`);
  }
}

export interface ManualBindInput {
  imdbId: string;
  mediaType: MediaKind;
  title: string;
  year: number | null;
  originalLanguage: string;
  seasons: number | null;
  poster?: string | null;
}

/**
 * A title TMDB does not have. `media.tmdb_id` is NOT NULL UNIQUE, so the row is keyed by
 * `imdb_id` and carries a negative sentinel. TMDB ids are strictly positive, so it cannot
 * collide; deriving it from the IMDb digits makes it deterministic, which makes a repeated bind
 * idempotent. `torznab` emits `tmdbid` only when `tmdb_id > 0`, so it never leaves the database.
 */
export async function bindManual(
  db: Db,
  tmdb: TmdbClient | null,
  topicId: number,
  input: ManualBindInput,
): Promise<{ mediaId: number; viaTmdb: boolean }> {
  const imdbId = normaliseImdbId(input.imdbId);
  if (!imdbId) throw new Error(`not an imdb id: ${input.imdbId}`);

  const found = tmdb ? await tmdb.findByImdbId(imdbId) : [];
  if (found.length === 1 && tmdb) {
    const only = found[0]!;
    const bound = await bindTopicToTmdb(db, tmdb, topicId, only.id, only.mediaType);
    return { mediaId: bound.mediaId, viaTmdb: true };
  }
  if (found.length > 1) throw new TmdbAmbiguousImdbError(found);

  const digits = imdbIdDigits(imdbId);
  if (digits === null) throw new Error(`imdb id has no digits: ${imdbId}`);

  const existing = db.select().from(media).where(eq(media.imdbId, imdbId)).get();
  let mediaId = existing?.id ?? 0;

  // One transaction: a crash between the media row and the variant pointers would leave a title
  // nobody is attached to, which the review queue cannot see or clean up.
  db.transaction(
    () => {
      if (existing) {
        db.update(media)
          .set({
            type: input.mediaType,
            title: input.title,
            year: input.year,
            originalLanguage: input.originalLanguage,
            seasons: input.seasons,
            posterPath: input.poster ?? existing.posterPath,
          })
          .where(eq(media.id, existing.id))
          .run();
      } else {
        mediaId = db
          .insert(media)
          .values({
            tmdbId: -digits, // sentinel: TMDB ids are positive
            type: input.mediaType,
            title: input.title,
            year: input.year,
            originalLanguage: input.originalLanguage,
            imdbId,
            seasons: input.seasons,
            posterPath: input.poster ?? null,
          })
          .returning()
          .get().id;
      }

      db.update(variants).set({ mediaId }).where(eq(variants.topicId, topicId)).run();
      db.update(topics)
        .set({
          providerStatus: 'matched',
          providerProposal: null,
          providerCheckedAt: new Date().toISOString(),
          kind: input.mediaType === 'tv' ? 'show' : 'movie',
          kindSource: 'human',
        })
        .where(eq(topics.id, topicId))
        .run();
      db.update(variants)
        .set({ categoryId: input.mediaType === 'tv' ? 5030 : 2040 })
        .where(eq(variants.topicId, topicId))
        .run();
    },
    { behavior: 'immediate' },
  );

  return { mediaId, viaTmdb: false };
}

void sql;
