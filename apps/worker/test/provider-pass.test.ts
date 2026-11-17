import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, media, mediaEpisodes, metadataCache, sources, topics, variants } from '@tamilcache/db/schema';
import type { TmdbCandidate } from '@tamilcache/shared';
import {
  bindManual,
  bindTopicToTmdb,
  enrichBatch,
  resolveTopicProvider,
  runProviderPass,
  TmdbAmbiguousImdbError,
} from '../src/provider-pass.js';
import { TmdbRateLimitedError } from '../src/tmdb.js';
import type { TmdbDetails, TmdbEpisode } from '../src/tmdb.js';

/** Stand-in for `TmdbClient`: records calls so caching can be asserted. */
class FakeTmdb {
  public searches: string[] = [];
  public detailCalls: number[] = [];
  constructor(
    private readonly searchResults: Record<string, TmdbCandidate[]>,
    private readonly detailsById: Record<number, TmdbDetails> = {},
    private readonly seasonMap: Record<number, number[]> = {},
    private readonly episodeMap: Record<string, TmdbEpisode[]> = {},
  ) {}

  async search(query: string): Promise<TmdbCandidate[]> {
    this.searches.push(query);
    return this.searchResults[query] ?? [];
  }

  async details(_kind: 'movie' | 'tv', id: number): Promise<TmdbDetails> {
    this.detailCalls.push(id);
    const found = this.detailsById[id];
    if (!found) throw new Error(`no fixture details for ${id}`);
    return found;
  }

  async seasonNumbers(id: number): Promise<number[]> {
    return this.seasonMap[id] ?? [];
  }

  async seasonEpisodes(id: number, season: number): Promise<TmdbEpisode[]> {
    return this.episodeMap[`${id}:${season}`] ?? [];
  }
}

let db: Db;
let seq = 0;

function seedTopic(slug: string, kind: 'movie' | 'show' = 'movie', options: { sizeBytes?: number } = {}) {
  if (seq === 0) {
    db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
    db.insert(forums).values({ sourceId: 1, sourceForumId: 64, name: 'Hindi Dubbed', inScope: true }).run();
  }
  seq += 1;
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: 1,
      sourceTopicId: seq,
      slug,
      rawTitle: slug,
      kind,
      status: 'parsed',
    })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      resolution: '1080p',
      sourceTagRaw: 'TRUE WEB-DL',
      sourceTag: 'WEB-DL',
      audioLangs: ['hindi'],
      sizeBytes: options.sizeBytes ?? 3 * 1024 ** 3,
      infohash: String(seq).padStart(40, 'a'),
      decision: 'hindi_dubbed',
      isPreferred: true,
    })
    .run();
  return topic.id;
}

const detailsFor = (over: Partial<TmdbDetails> & { id: number }): TmdbDetails => ({
  mediaType: 'movie',
  title: 'Untitled',
  year: 2026,
  originalLanguage: 'ta',
  imdbId: null,
  tvdbId: null,
  seasons: null,
  posterPath: null,
  overview: null,
  genres: [],
  voteAverage: null,
  voteCount: null,
  runtime: null,
  backdropPath: null,
  status: null,
  ...over,
});

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  seq = 0;
});

describe('pre-v9 metadata cache', () => {
  const OLD_PAYLOAD = {
    id: 656908,
    mediaType: 'movie',
    title: 'Ramayana',
    year: 2026,
    originalLanguage: 'hi',
    imdbId: null,
    tvdbId: null,
    seasons: null,
    posterPath: '/p.jpg',
    overview: null,
  };

  it('attaches a topic from a cached payload written before the enrichment fields existed', async () => {
    // A real upgraded volume holds ~4,800 of these: no `genres`, no `vote_average`, no `runtime`.
    db.insert(metadataCache)
      .values({ queryKey: 'tmdb:details:movie:656908', payload: JSON.stringify(OLD_PAYLOAD) })
      .run();

    const topicId = seedTopic('ramayana-2026-hindi-hq-predvd-1080p');
    const tmdb = new FakeTmdb({
      ramayana: [{ id: 656908, mediaType: 'movie', title: 'Ramayana', year: 2026, originalLanguage: 'hi', popularity: 154 }],
    });

    await expect(resolveTopicProvider(db, tmdb as never, topicId)).resolves.toBe('matched');

    expect(tmdb.detailCalls).toEqual([]);
    expect(db.select().from(media).all()[0]).toMatchObject({ tmdbId: 656908, genres: [], voteAverage: null });
  });

  it('re-attaches over an existing media row without blanking or throwing', async () => {
    db.insert(media).values({ tmdbId: 656908, type: 'movie', title: 'Ramayana', genres: ['Drama'], voteAverage: 7.7 }).run();
    db.insert(metadataCache)
      .values({ queryKey: 'tmdb:details:movie:656908', payload: JSON.stringify(OLD_PAYLOAD) })
      .run();

    const topicId = seedTopic('ramayana-2026-hindi-hq-predvd-1080p');
    const tmdb = new FakeTmdb({
      ramayana: [{ id: 656908, mediaType: 'movie', title: 'Ramayana', year: 2026, originalLanguage: 'hi', popularity: 154 }],
    });

    await resolveTopicProvider(db, tmdb as never, topicId);

    expect(db.select().from(media).all()).toHaveLength(1);
    expect(db.select().from(media).all()[0]).toMatchObject({ genres: ['Drama'], voteAverage: 7.7 });
  });

  it('binds through bindTopicToTmdb with the same old payload', async () => {
    db.insert(metadataCache)
      .values({ queryKey: 'tmdb:details:movie:656908', payload: JSON.stringify(OLD_PAYLOAD) })
      .run();
    const topicId = seedTopic('ramayana-2026-hindi-hq-predvd-1080p');

    await expect(bindTopicToTmdb(db, new FakeTmdb({}) as never, topicId, 656908, 'movie')).resolves.toBeDefined();
  });
});

describe('enrichBatch', () => {
  it('enriches unrated media rows and reports what is left', async () => {
    db.insert(media).values({ tmdbId: 1, type: 'movie', title: 'One' }).run();
    db.insert(media).values({ tmdbId: 2, type: 'movie', title: 'Two' }).run();
    db.insert(media).values({ tmdbId: 3, type: 'movie', title: 'Rated', voteAverage: 6.5 }).run();
    // A manual bind: the negative sentinel must never be sent to TMDB.
    db.insert(media).values({ tmdbId: -55, type: 'tv', title: 'Manual' }).run();

    const tmdb = new FakeTmdb({}, {
      1: detailsFor({ id: 1, title: 'One', voteAverage: 7.1, genres: ['Drama'], backdropPath: '/one.jpg' }),
      2: detailsFor({ id: 2, title: 'Two', voteAverage: 8.2, runtime: 90 }),
    });

    const first = await enrichBatch(db, tmdb as never, { limit: 50 });

    expect(first.enriched).toBe(2);
    expect(first.remaining).toBe(0);
    expect(tmdb.detailCalls.sort()).toEqual([1, 2]);
    expect(db.select().from(media).all().find((row) => row.tmdbId === 1)).toMatchObject({
      voteAverage: 7.1,
      genres: ['Drama'],
      backdropPath: '/one.jpg',
    });

    const second = await enrichBatch(db, tmdb as never, { limit: 50 });
    expect(second.enriched).toBe(0);
  });

  it('advances past rows that keep failing instead of blocking the queue forever', async () => {
    db.insert(media).values({ tmdbId: 1, type: 'movie', title: 'Bad One' }).run();
    db.insert(media).values({ tmdbId: 2, type: 'movie', title: 'Bad Two' }).run();
    db.insert(media).values({ tmdbId: 3, type: 'movie', title: 'Good' }).run();
    // 1 and 2 are not in the fixture map, so FakeTmdb throws for them.
    const tmdb = new FakeTmdb({}, { 3: detailsFor({ id: 3, title: 'Good', voteAverage: 7.5 }) });

    const first = await enrichBatch(db, tmdb as never, { limit: 2 });

    expect(first).toMatchObject({ enriched: 0, failed: 2 });

    const second = await enrichBatch(db, tmdb as never, { limit: 2 });

    expect(second.enriched).toBe(1);
    expect(db.select().from(media).all().find((row) => row.tmdbId === 3)).toMatchObject({ voteAverage: 7.5 });
  });

  it('reports the failure count so a stuck backfill cannot be silent', async () => {
    db.insert(media).values({ tmdbId: 4, type: 'movie', title: 'Broken' }).run();
    const result = await enrichBatch(db, new FakeTmdb({}) as never, { limit: 50 });
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.rateLimitedMs).toBeNull();
  });

  it('stops the batch on a rate limit and leaves the rest for the next tick', async () => {
    db.insert(media).values({ tmdbId: 7, type: 'movie', title: 'Seven' }).run();
    db.insert(media).values({ tmdbId: 8, type: 'movie', title: 'Eight' }).run();
    const limited = new RateLimitedTmdb();

    const result = await enrichBatch(db, limited as never, { limit: 50 });

    expect(result.enriched).toBe(0);
    expect(result.rateLimitedMs).toBe(5_000);
  });
});

describe('media enrichment', () => {
  it('stores the enrichment fields on first attach', async () => {
    const topicId = seedTopic('ramayana-2026-hindi-hq-predvd-1080p');
    const tmdb = new FakeTmdb(
      { ramayana: [{ id: 656908, mediaType: 'movie', title: 'Ramayana', year: 2026, originalLanguage: 'hi', popularity: 154 }] },
      {
        656908: detailsFor({
          id: 656908,
          title: 'Ramayana',
          genres: ['Action', 'Drama'],
          voteAverage: 7.4,
          voteCount: 1200,
          runtime: 160,
          backdropPath: '/b.jpg',
          status: 'Released',
        }),
      },
    );

    await resolveTopicProvider(db, tmdb as never, topicId);

    expect(db.select().from(media).all()[0]).toMatchObject({
      genres: ['Action', 'Drama'],
      voteAverage: 7.4,
      voteCount: 1200,
      runtime: 160,
      backdropPath: '/b.jpg',
      status: 'Released',
    });
  });

  it('never blanks stored enrichment when a later re-attach carries nulls', async () => {
    const first = seedTopic('ramayana-2026-hindi-hq-predvd-1080p');
    const enriched = new FakeTmdb(
      { ramayana: [{ id: 656908, mediaType: 'movie', title: 'Ramayana', year: 2026, originalLanguage: 'hi', popularity: 154 }] },
      { 656908: detailsFor({ id: 656908, title: 'Ramayana', voteAverage: 7.4, genres: ['Action'] }) },
    );
    await resolveTopicProvider(db, enriched as never, first);

    // A second upload of the same film, resolved from a payload whose enrichment fields are null.
    const second = seedTopic('ramayana-2026-hindi-hq-predvd-1080p-repost');
    const bare = new FakeTmdb(
      { ramayana: [{ id: 656908, mediaType: 'movie', title: 'Ramayana', year: 2026, originalLanguage: 'hi', popularity: 154 }] },
      { 656908: detailsFor({ id: 656908, title: 'Ramayana' }) },
    );
    await resolveTopicProvider(db, bare as never, second);

    expect(db.select().from(media).all()[0]).toMatchObject({ voteAverage: 7.4, genres: ['Action'] });
  });
});

class RateLimitedTmdb {
  async details(): Promise<TmdbDetails> {
    throw new TmdbRateLimitedError(5_000);
  }
}

describe('resolveTopicProvider', () => {
  it('binds a confident match and stores the provider language on the variants', async () => {
    const topicId = seedTopic('ramayana-2026-hindi-hq-predvd-1080p');
    const tmdb = new FakeTmdb(
      { ramayana: [{ id: 656908, mediaType: 'movie', title: 'Ramayana: Rise of a Legend', year: 2026, originalLanguage: 'hi', popularity: 154 }] },
      { 656908: detailsFor({ id: 656908, title: 'Ramayana: Rise of a Legend', originalLanguage: 'hi' }) },
    );

    expect(await resolveTopicProvider(db, tmdb as never, topicId)).toBe('matched');

    const stored = db.select().from(media).all()[0];
    expect(stored).toMatchObject({ tmdbId: 656908, originalLanguage: 'hi', type: 'movie' });
    expect(db.select().from(variants).all()[0]?.mediaId).toBe(stored?.id);
    expect(db.select().from(topics).all()[0]?.providerStatus).toBe('matched');
  });

  it('parks an ambiguous title with a proposal instead of binding', async () => {
    const topicId = seedTopic('land-2026-tamil-hdrip-1080p');
    const tmdb = new FakeTmdb({
      land: [
        { id: 11, mediaType: 'movie', title: 'Land', year: 2026, originalLanguage: 'en', popularity: 9 },
        { id: 12, mediaType: 'movie', title: 'Land', year: 2026, originalLanguage: 'en', popularity: 8 },
      ],
    });

    expect(await resolveTopicProvider(db, tmdb as never, topicId)).toBe('ambiguous');
    const topic = db.select().from(topics).all()[0];
    expect(topic?.providerStatus).toBe('ambiguous');
    expect(topic?.providerProposal).toContain('"tmdbId":11');
    expect(db.select().from(media).all()).toHaveLength(0);
    expect(db.select().from(variants).all()[0]?.mediaId).toBeNull();
  });

  it('records none when nothing plausible exists', async () => {
    const topicId = seedTopic('unfindable-film-2026-tamil-1080p');
    const tmdb = new FakeTmdb({ unfindable: [] });
    expect(await resolveTopicProvider(db, tmdb as never, topicId)).toBe('none');
    expect(db.select().from(topics).all()[0]?.providerStatus).toBe('none');
  });

  it('fetches and stores episodes for a show', async () => {
    const topicId = seedTopic('panthadikkaam-2026-s01-ep-01-05-true-web-dl-1080p', 'show');
    const tmdb = new FakeTmdb(
      { panthadikkaam: [{ id: 337062, mediaType: 'tv', title: 'Panthadikkaam', year: 2026, originalLanguage: 'ml', popularity: 1 }] },
      { 337062: detailsFor({ id: 337062, mediaType: 'tv', title: 'Panthadikkaam', originalLanguage: 'ml', seasons: 1 }) },
      { 337062: [1] },
      {
        '337062:1': [
          { season: 1, episode: 1, airDate: '2026-10-01', name: 'One' },
          { season: 1, episode: 2, airDate: '2026-10-08', name: 'Two' },
          { season: 1, episode: 3, airDate: null, name: 'Three' },
          { season: 1, episode: 4, airDate: null, name: 'Four' },
          { season: 1, episode: 5, airDate: null, name: 'Five' },
        ],
      },
    );

    expect(await resolveTopicProvider(db, tmdb as never, topicId)).toBe('matched');
    const episodes = db.select().from(mediaEpisodes).all();
    expect(episodes).toHaveLength(5);
    expect(episodes.map((episode) => episode.episode).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('caching', () => {
  it('queries TMDB once per (query, year) across topics', async () => {
    const tmdb = new FakeTmdb(
      { kara: [{ id: 5, mediaType: 'movie', title: 'Kara', year: 2026, originalLanguage: 'ta', popularity: 3 }] },
      { 5: detailsFor({ id: 5, title: 'Kara' }) },
    );
    seedTopic('kara-2026-tamil-1080p');
    seedTopic('kara-2026-tamil-hq-1080p');

    await runProviderPass(db, tmdb as never, { limit: 10 });

    expect(tmdb.searches.filter((query) => query === 'kara')).toHaveLength(1);
    expect(tmdb.detailCalls).toHaveLength(1);
    expect(db.select().from(metadataCache).all().length).toBeGreaterThan(0);
  });

  it('does not re-check a topic that was already resolved', async () => {
    const tmdb = new FakeTmdb(
      { kara: [{ id: 5, mediaType: 'movie', title: 'Kara', year: 2026, originalLanguage: 'ta', popularity: 3 }] },
      { 5: detailsFor({ id: 5, title: 'Kara' }) },
    );
    seedTopic('kara-2026-tamil-1080p');

    const first = await runProviderPass(db, tmdb as never, { limit: 10 });
    const second = await runProviderPass(db, tmdb as never, { limit: 10 });

    expect(first.checked).toBe(1);
    expect(second.checked).toBe(0);
  });

  it('survives a TMDB error and leaves the topic for the next tick', async () => {
    seedTopic('broken-2026-tamil-1080p');
    const tmdb = {
      search: async () => {
        throw new Error('TMDB 500');
      },
    };
    const result = await runProviderPass(db, tmdb as never, { limit: 10 });
    expect(result.errors).toBe(1);
    expect(db.select().from(topics).all()[0]?.providerCheckedAt).toBeNull();
  });

  it('is a no-op without a client', async () => {
    seedTopic('kara-2026-tamil-1080p');
    expect(await runProviderPass(db, null)).toEqual({ checked: 0, matched: 0, ambiguous: 0, none: 0, errors: 0 });
  });
});

describe('kind correction', () => {
  it('corrects a mislabelled kind when tmdb says tv', async () => {
    // Stored as `movie` by the old season-tag heuristic: a serial posted without an episode tag.
    const topicId = seedTopic('some-serial-2026-tamil-1080p');
    const tmdb = new FakeTmdb(
      { 'some serial': [{ id: 4242, mediaType: 'tv', title: 'Some Serial', year: 2026, originalLanguage: 'ta', popularity: 5 }] },
      { 4242: detailsFor({ id: 4242, mediaType: 'tv', title: 'Some Serial', originalLanguage: 'ta', seasons: 1 }) },
      { 4242: [1] },
    );

    expect(await resolveTopicProvider(db, tmdb as never, topicId)).toBe('matched');

    const after = db.select().from(topics).get();
    expect(after?.providerStatus).toBe('matched');
    expect(after?.kind).toBe('show');
    expect(after?.kindSource).toBe('tmdb');
    expect(db.select().from(variants).get()?.categoryId).toBe(5030);
  });
});

describe('bindTopicToTmdb', () => {
  it('binds a human-chosen id regardless of scoring', async () => {
    const topicId = seedTopic('obscure-2026-tamil-1080p');
    const tmdb = new FakeTmdb(
      {},
      { 999: detailsFor({ id: 999, title: 'Obscure', originalLanguage: 'hi' }) },
      {},
      {},
    );

    const result = await bindTopicToTmdb(db, tmdb as never, topicId, 999, 'movie');
    expect(result.originalLanguage).toBe('hi');
    expect(db.select().from(variants).all()[0]?.mediaId).toBe(result.mediaId);
    expect(db.select().from(topics).all()[0]?.providerStatus).toBe('matched');
  });
});

describe('data-integrity fixes', () => {
  it('refuses to attach a TMDB id that is already stored as the other media type', async () => {
    // media.tmdb_id is UNIQUE; movie 1399 and TV 1399 are different titles in TMDB.
    db.insert(media).values({ tmdbId: 1399, type: 'movie', title: 'Movie 1399', originalLanguage: 'ta' }).run();
    const topicId = seedTopic('some-show-2026-s01-ep-01-03-1080p', 'show');
    const tmdb = new FakeTmdb(
      { 'some show': [{ id: 1399, mediaType: 'tv', title: 'Some Show', year: 2026, originalLanguage: 'ta', popularity: 2 }] },
      { 1399: detailsFor({ id: 1399, mediaType: 'tv', title: 'Some Show' }) },
    );

    await expect(resolveTopicProvider(db, tmdb as never, topicId)).rejects.toThrow(/already stored as movie/);
    // The existing row is untouched and the topic is not stamped.
    expect(db.select().from(media).all()[0]?.title).toBe('Movie 1399');
    expect(db.select().from(topics).all()[0]?.providerCheckedAt).toBeNull();
  });

  it('never blanks a known imdb id when external_ids fails', async () => {
    db.insert(media)
      .values({ tmdbId: 7, type: 'movie', title: 'Kara', originalLanguage: 'ta', imdbId: 'tt1234567' })
      .run();
    const topicId = seedTopic('kara-2026-tamil-1080p');
    const tmdb = new FakeTmdb(
      { kara: [{ id: 7, mediaType: 'movie', title: 'Kara', year: 2026, originalLanguage: 'ta', popularity: 3 }] },
      { 7: { ...detailsFor({ id: 7, title: 'Kara' }), imdbId: null, externalIdsOk: false } },
    );

    await resolveTopicProvider(db, tmdb as never, topicId);
    expect(db.select().from(media).all()[0]?.imdbId).toBe('tt1234567');
  });

  it('does not cache an empty search, so a title added later can still match', async () => {
    const topicId = seedTopic('brand-new-film-2026-tamil-1080p');
    const tmdb = new FakeTmdb({ 'brand new film': [] });
    await resolveTopicProvider(db, tmdb as never, topicId);
    expect(db.select().from(metadataCache).all()).toHaveLength(0);
  });

  it('aborts the pass on a rate-limit and reports the backoff', async () => {
    seedTopic('kara-2026-tamil-1080p');
    const rateLimited = {
      search: async () => {
        throw new TmdbRateLimitedError(90_000);
      },
    };
    const result = await runProviderPass(db, rateLimited as never, { limit: 5 });
    expect(result.rateLimitedMs).toBe(90_000);
    expect(result.checked).toBe(0);
  });

  it('does not stamp a topic when episode fetching throws', async () => {
    const topicId = seedTopic('broken-show-2026-s01-ep-01-05-1080p', 'show');
    const tmdb = new FakeTmdb(
      { 'broken show': [{ id: 55, mediaType: 'tv', title: 'Broken Show', year: 2026, originalLanguage: 'ta', popularity: 2 }] },
      { 55: detailsFor({ id: 55, mediaType: 'tv', title: 'Broken Show' }) },
    );
    // seasonNumbers resolves, seasonEpisodes throws (network failure mid-pass).
    (tmdb as unknown as { seasonNumbers: () => Promise<number[]> }).seasonNumbers = async () => [1];
    (tmdb as unknown as { seasonEpisodes: () => Promise<never[]> }).seasonEpisodes = async () => {
      throw new Error('boom');
    };

    await expect(resolveTopicProvider(db, tmdb as never, topicId)).rejects.toThrow('boom');
    expect(db.select().from(media).all()).toHaveLength(0);
    expect(db.select().from(mediaEpisodes).all()).toHaveLength(0);
    expect(db.select().from(topics).all()[0]?.providerCheckedAt).toBeNull();
  });
});

describe('bindManual', () => {
  it('delegates to the normal attach path when tmdb knows the imdb id', async () => {
    const topicId = seedTopic('inception-2010-hindi-hq-1080p');
    const found: TmdbCandidate[] = [
      { id: 27205, mediaType: 'movie', title: 'Inception', year: 2010, originalLanguage: 'en', popularity: 9 },
    ];
    const tmdb = {
      findByImdbId: async () => found,
      details: async () => detailsFor({ id: 27205, title: 'Inception', year: 2010, imdbId: 'tt1375666' }),
      seasonNumbers: async () => [],
      seasonEpisodes: async () => [],
    } as never;

    const result = await bindManual(db, tmdb, topicId, {
      imdbId: 'tt1375666',
      mediaType: 'movie',
      title: 'Inception',
      year: 2010,
      originalLanguage: 'en',
      seasons: null,
    });

    expect(result.viaTmdb).toBe(true);
    expect(db.select().from(media).get()?.tmdbId).toBe(27205);
  });

  it('stores a deterministic negative sentinel keyed by imdb when tmdb has nothing', async () => {
    const topicId = seedTopic('karthika-deepam-2017-tamil-720p');
    const tmdb = { findByImdbId: async () => [] } as never;

    const result = await bindManual(db, tmdb, topicId, {
      imdbId: 'tt9216888',
      mediaType: 'tv',
      title: 'Karthika Deepam',
      year: 2017,
      originalLanguage: 'te',
      seasons: 3,
    });

    const row = db.select().from(media).get();
    expect(row).toMatchObject({ imdbId: 'tt9216888', originalLanguage: 'te', seasons: 3 });
    expect(row?.tmdbId).toBe(-9216888);
    expect(result.viaTmdb).toBe(false);
    expect(db.select().from(topics).get()?.kindSource).toBe('human');
  });

  it('is idempotent: a second bind reuses the same media row', async () => {
    const topicId = seedTopic('karthika-deepam-2017-tamil-1080p');
    const tmdb = { findByImdbId: async () => [] } as never;
    const input = {
      imdbId: 'tt9216888',
      mediaType: 'tv' as const,
      title: 'Karthika Deepam',
      year: 2017,
      originalLanguage: 'te',
      seasons: 3,
    };

    const first = await bindManual(db, tmdb, topicId, input);
    const second = await bindManual(db, tmdb, topicId, input);

    expect(second.mediaId).toBe(first.mediaId);
    expect(db.select().from(media).all()).toHaveLength(1);
  });

  it('refuses to guess when tmdb has several titles for the imdb id', async () => {
    const topicId = seedTopic('ambiguous-2020-hindi-1080p');
    const found: TmdbCandidate[] = [
      { id: 1, mediaType: 'movie', title: 'A', year: 2000, originalLanguage: 'en', popularity: 1 },
      { id: 2, mediaType: 'tv', title: 'B', year: 2001, originalLanguage: 'en', popularity: 1 },
    ];
    const tmdb = { findByImdbId: async () => found } as never;

    await expect(
      bindManual(db, tmdb, topicId, {
        imdbId: 'tt1234567',
        mediaType: 'movie',
        title: 'A',
        year: 2000,
        originalLanguage: 'en',
        seasons: null,
      }),
    ).rejects.toBeInstanceOf(TmdbAmbiguousImdbError);
  });
});

describe('other-kind topics', () => {
  it('skips the provider ladder — a trailer is not a title to match', async () => {
    const topicId = seedTopic('some-film-2026-tamil-trailer-1080p', 'movie');
    db.update(topics).set({ kind: 'other' }).where(eq(topics.id, topicId)).run();
    const tmdb = new FakeTmdb({ 'some film': [{ id: 1, mediaType: 'movie', title: 'Some Film', year: 2026, originalLanguage: 'ta', popularity: 5 }] });

    const result = await runProviderPass(db, tmdb as never);

    expect(result.checked).toBe(0);
    expect(tmdb.searches).toEqual([]);
    expect(db.select().from(topics).get()?.providerStatus).toBe('pending');
  });

  it('also refuses a direct resolve, marking the topic skipped', async () => {
    const topicId = seedTopic('some-film-2026-tamil-songs-1080p', 'movie');
    db.update(topics).set({ kind: 'other' }).where(eq(topics.id, topicId)).run();
    const tmdb = new FakeTmdb({});

    expect(await resolveTopicProvider(db, tmdb as never, topicId)).toBe('none');
    expect(tmdb.searches).toEqual([]);
    expect(db.select().from(topics).get()?.providerStatus).toBe('skipped');
  });
});
