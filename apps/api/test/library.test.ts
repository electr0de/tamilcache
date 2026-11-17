import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { buildApp } from '../src/server.js';
import { forums, media, mediaEpisodes, sources, topics, variants } from '@tamilcache/db/schema';
import { libraryPage, suggestTitles, titleByMediaId } from '../src/library.js';

let db: Db;
let seq = 0;

function seedMedia(overrides: Partial<typeof media.$inferInsert> = {}) {
  seq += 1;
  return db
    .insert(media)
    .values({ tmdbId: 10_000 + seq, type: 'movie', title: 'Sigma', year: 2026, ...overrides })
    .returning()
    .get();
}

function seedRelease(opts: {
  mediaId: number | null;
  decision?: 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | 'unknown';
  resolution?: string;
  infohash?: string;
  season?: number | null;
  epFrom?: number | null;
  epTo?: number | null;
  publishedAt?: string;
  isPreferred?: boolean;
}) {
  seq += 1;
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: 1,
      sourceTopicId: seq,
      slug: `t-${seq}`,
      rawTitle: 'Sigma',
      kind: 'movie',
    })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      mediaId: opts.mediaId,
      resolution: opts.resolution ?? '1080p',
      sourceTagRaw: 'WEB-DL',
      sourceTag: 'WEB-DL',
      audioLangs: ['tamil', 'hindi'],
      sizeBytes: 9 * 1024 ** 3,
      infohash: opts.infohash ?? seq.toString(16).padStart(40, 'f'),
      normTitle: 'Sigma.2026.1080p.WEB-DL-TMV',
      decision: opts.decision ?? 'hindi_dubbed',
      isPreferred: opts.isPreferred ?? true,
      season: opts.season ?? null,
      epFrom: opts.epFrom ?? null,
      epTo: opts.epTo ?? null,
      publishedAt: opts.publishedAt ?? '2026-11-01T00:00:00.000Z',
    })
    .run();
}

beforeEach(() => {
  seq = 0;
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 1, name: 'f', inScope: true }).run();
});

describe('libraryPage', () => {
  it('returns one row per media title with release aggregates', () => {
    const movie = seedMedia({ title: 'Sigma', posterPath: '/p.jpg', backdropPath: '/b.jpg', voteAverage: 7.9 });
    seedRelease({ mediaId: movie.id, resolution: '2160p' });
    seedRelease({ mediaId: movie.id, resolution: '1080p' });

    const page = libraryPage(db, { limit: 48, offset: 0 });

    expect(page.total).toBe(1);
    expect(page.titles).toHaveLength(1);
    expect(page.titles[0]).toMatchObject({
      mediaId: movie.id,
      type: 'movie',
      title: 'Sigma',
      releases: 2,
      poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w780/b.jpg',
      voteAverage: 7.9,
    });
    expect([...page.titles[0]!.resolutions].sort()).toEqual(['1080p', '2160p']);
    expect([...page.titles[0]!.audioLangs].sort()).toEqual(['hindi', 'tamil']);
  });

  it('excludes releases with no metadata match', () => {
    const movie = seedMedia();
    seedRelease({ mediaId: movie.id });
    seedRelease({ mediaId: null });
    expect(libraryPage(db, { limit: 48, offset: 0 }).total).toBe(1);
  });

  it('keeps a matched release whose cross-posted twin is unmatched', () => {
    const movie = seedMedia({ title: 'Twin' });
    // The unmatched copy ranks higher, so a dedupe that runs before the media_id filter would
    // elect it and drop the only release that can form a card.
    seedRelease({ mediaId: null, infohash: 'c'.repeat(40) });
    seedRelease({ mediaId: movie.id, infohash: 'c'.repeat(40) });

    const page = libraryPage(db, { limit: 48, offset: 0 });

    expect(page.titles.map((title) => title.title)).toEqual(['Twin']);
    expect(page.titles[0]?.releases).toBe(1);
  });

  it('counts a cross-posted infohash once', () => {
    const movie = seedMedia();
    seedRelease({ mediaId: movie.id, infohash: 'f'.repeat(40) });
    seedRelease({ mediaId: movie.id, infohash: 'f'.repeat(40) });
    expect(libraryPage(db, { limit: 48, offset: 0 }).titles[0]?.releases).toBe(1);
  });

  it('leaves poster null when the provider had no poster', () => {
    const movie = seedMedia({ posterPath: null });
    seedRelease({ mediaId: movie.id });
    expect(libraryPage(db, { limit: 48, offset: 0 }).titles[0]?.poster).toBeNull();
  });

  it('filters by type, quality and title query', () => {
    const movie = seedMedia({ title: 'Sigma' });
    const show = seedMedia({ title: 'Sigma Show', type: 'tv' });
    seedRelease({ mediaId: movie.id, resolution: '2160p' });
    seedRelease({ mediaId: show.id, resolution: '1080p' });

    expect(libraryPage(db, { limit: 48, offset: 0, type: 'tv' }).titles.map((t) => t.title)).toEqual(['Sigma Show']);
    expect(libraryPage(db, { limit: 48, offset: 0, quality: '2160p' }).titles.map((t) => t.title)).toEqual(['Sigma']);
    expect(libraryPage(db, { limit: 48, offset: 0, q: 'SHOW' }).titles.map((t) => t.title)).toEqual(['Sigma Show']);
  });

  it('sorts by latest release and by title', () => {
    const old = seedMedia({ title: 'Old' });
    const fresh = seedMedia({ title: 'Fresh' });
    seedRelease({ mediaId: old.id, publishedAt: '2026-01-01T00:00:00.000Z' });
    seedRelease({ mediaId: fresh.id, publishedAt: '2026-11-01T00:00:00.000Z' });

    expect(libraryPage(db, { limit: 48, offset: 0, sort: 'latest' }).titles.map((t) => t.title)).toEqual(['Fresh', 'Old']);
    expect(libraryPage(db, { limit: 48, offset: 0, sort: 'title' }).titles.map((t) => t.title)).toEqual(['Fresh', 'Old']);
  });

  it('clamps an offset past the end instead of returning an empty page', () => {
    const movie = seedMedia();
    seedRelease({ mediaId: movie.id });

    const beyond = libraryPage(db, { limit: 48, offset: 500 });

    expect(beyond.total).toBe(1);
    expect(beyond.titles).toHaveLength(1);
    expect(beyond.offset).toBe(0);
  });

  it('caps limit at 100', () => {
    expect(libraryPage(db, { limit: 9_999, offset: 0 }).limit).toBe(100);
  });

  it('reports aired and covered episode counts for a show', () => {
    const show = seedMedia({ type: 'tv', title: 'Sigma Show' });
    db.insert(mediaEpisodes).values({ mediaId: show.id, season: 1, episode: 1, airDate: '2024-01-01' }).run();
    db.insert(mediaEpisodes).values({ mediaId: show.id, season: 1, episode: 2, airDate: '2024-01-08' }).run();
    seedRelease({ mediaId: show.id, season: 1, epFrom: 1, epTo: 1 });

    expect(libraryPage(db, { limit: 48, offset: 0 }).titles[0]?.coverage).toEqual({
      aired: 2,
      covered: 1,
      missing: 1,
    });
  });
});

const KEY = 'k';
const url = (path: string) => `${path}${path.includes('?') ? '&' : '?'}apikey=${KEY}`;

describe('library routes', () => {
  it('serves a title page, a suggestion list and a detail page', async () => {
    const movie = seedMedia({ title: 'Sigma', posterPath: '/p.jpg' });
    seedRelease({ mediaId: movie.id });
    const app = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484' });

    const list = await app.inject({ url: url('/api/v1/library?limit=48') });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { total: number }).total).toBe(1);

    const suggest = await app.inject({ url: url('/api/v1/library/suggest?q=sig') });
    expect(suggest.statusCode).toBe(200);
    expect((suggest.json() as { titles: Array<{ title: string }> }).titles[0]?.title).toBe('Sigma');

    const detail = await app.inject({ url: url(`/api/v1/library/${movie.id}`) });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { media: { title: string } }).media.title).toBe('Sigma');
  });

  it('rejects or truncates a non-integer limit instead of crashing SQLite', async () => {
    const movie = seedMedia({ title: 'Sigma' });
    seedRelease({ mediaId: movie.id });
    const app = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484' });

    for (const limit of ['2.5', 'abc', '-3', '1e9']) {
      const response = await app.inject({ url: url(`/api/v1/library?limit=${limit}`) });
      expect(response.statusCode, `limit=${limit}`).toBe(200);
      expect((response.json() as { limit: number }).limit).toBeGreaterThanOrEqual(1);
      expect((response.json() as { limit: number }).limit).toBeLessThanOrEqual(100);
    }
  });

  it('404s an unknown media id and requires the api key', async () => {
    const app = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484' });
    expect((await app.inject({ url: url('/api/v1/library/999999') })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/library' })).statusCode).toBe(401);
  });
});

describe('suggestTitles', () => {
  beforeEach(() => {
    for (const title of ['Spider-Man: Homecoming', 'Avatar: The Way of Water', 'RRR', 'Spider-Man 2']) {
      const row = seedMedia({ title });
      seedRelease({ mediaId: row.id });
    }
  });

  it('matches every typed token at a word start', () => {
    expect(suggestTitles(db, 'spid').map((row) => row.title)).toEqual(['Spider-Man 2', 'Spider-Man: Homecoming']);
    expect(suggestTitles(db, 'avatar way').map((row) => row.title)).toEqual(['Avatar: The Way of Water']);
    expect(suggestTitles(db, 'rrr').map((row) => row.title)).toEqual(['RRR']);
  });

  it('does not match a token in the middle of a word', () => {
    expect(suggestTitles(db, 'ider')).toEqual([]);
    expect(suggestTitles(db, 'vatar')).toEqual([]);
    expect(suggestTitles(db, 'oming')).toEqual([]);
  });

  it('returns nothing below two characters', () => {
    expect(suggestTitles(db, 's')).toEqual([]);
    expect(suggestTitles(db, '   ')).toEqual([]);
  });

  it('caps the list at eight results and builds the poster url', () => {
    for (let index = 0; index < 10; index += 1) {
      const row = seedMedia({ title: `Sigma ${index}`, posterPath: `/p${index}.jpg` });
      seedRelease({ mediaId: row.id });
    }
    const results = suggestTitles(db, 'sig');
    expect(results).toHaveLength(8);
    expect(results[0]?.poster).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/w342\/p/);
  });

  it('does not treat LIKE wildcards as wildcards', () => {
    expect(suggestTitles(db, '%%')).toEqual([]);
    expect(suggestTitles(db, '_p')).toEqual([]);
  });
});

describe('variantsForMedia', () => {
  it('lists a cross-posted infohash once, matching the grid count', () => {
    const movie = seedMedia({ title: 'Twin' });
    seedRelease({ mediaId: movie.id, infohash: 'd'.repeat(40) });
    seedRelease({ mediaId: movie.id, infohash: 'd'.repeat(40) });

    const detail = titleByMediaId(db, movie.id)!;

    expect(detail.releases).toHaveLength(1);
    expect(libraryPage(db, { limit: 48, offset: 0 }).titles[0]?.releases).toBe(1);
  });
});

describe('health filters', () => {
  it('returns only shows with aired-uncovered episodes for health=missing', () => {
    const movie = seedMedia({ title: 'Film' });
    seedRelease({ mediaId: movie.id });
    const complete = seedMedia({ title: 'Complete', type: 'tv' });
    db.insert(mediaEpisodes).values({ mediaId: complete.id, season: 1, episode: 1, airDate: '2024-01-01' }).run();
    seedRelease({ mediaId: complete.id, season: 1, epFrom: 1, epTo: 1 });
    const gap = seedMedia({ title: 'Gap', type: 'tv' });
    db.insert(mediaEpisodes).values({ mediaId: gap.id, season: 1, episode: 5, airDate: '2024-01-01' }).run();
    seedRelease({ mediaId: gap.id, season: 1, epFrom: 1, epTo: 4 });

    const page = libraryPage(db, { limit: 48, offset: 0, health: 'missing' });

    expect(page.titles.map((title) => title.title)).toEqual(['Gap']);
    expect(page.total).toBe(1);
  });

  it('returns unmatched releases instead of cards for health=unmatched', () => {
    const movie = seedMedia();
    seedRelease({ mediaId: movie.id });
    seedRelease({ mediaId: null, infohash: 'e'.repeat(40) });

    const page = libraryPage(db, { limit: 48, offset: 0, health: 'unmatched' });

    expect(page.titles).toEqual([]);
    expect(page.total).toBe(1);
    expect(page.unmatched).toHaveLength(1);
    expect(page.unmatched?.[0]?.slug).toMatch(/^t-/);
  });
});

describe('titleByMediaId', () => {
  function seedShow() {
    const show = db
      .insert(media)
      .values({ tmdbId: 555, type: 'tv', title: 'Sigma Show', year: 2024, seasons: 2, posterPath: '/p.jpg' })
      .returning()
      .get();
    const episodes = [
      { season: 1, episode: 1, airDate: '2024-01-01' },
      { season: 1, episode: 2, airDate: '2024-01-08' },
      { season: 2, episode: 0, airDate: '2099-01-01' },
      { season: 0, episode: 1, airDate: '2023-12-01' },
    ];
    for (const episode of episodes) {
      db.insert(mediaEpisodes)
        .values({ mediaId: show.id, season: episode.season, episode: episode.episode, airDate: episode.airDate, name: null })
        .run();
    }
    return show;
  }

  it('marks aired episodes covered by a kept release and lists the missing ones', () => {
    const show = seedShow();
    seedRelease({ mediaId: show.id, season: 1, epFrom: 1, epTo: 1 });

    const detail = titleByMediaId(db, show.id);
    expect(detail).not.toBeNull();
    const season1 = detail!.seasons!.find((season) => season.season === 1)!;
    expect(season1.episodes.map((episode) => [episode.episode, episode.aired, episode.covered])).toEqual([
      [1, true, true],
      [2, true, false],
    ]);
    // Specials (season 0) are listed in `seasons` but never counted as missing coverage: an
    // aired special is not an episode of the show's run, and treating it as one would make every
    // series with a featurette look permanently incomplete.
    expect(detail!.missing).toEqual([{ season: 1, episode: 2, airDate: '2024-01-08', name: null }]);
    expect(detail!.seasons!.at(-1)?.season).toBe(0);
    expect(detail!.coverage).toEqual({ aired: 2, covered: 1 });
  });

  it('does not count coverage claimed by a non-preferred release', () => {
    const show = seedShow();
    seedRelease({ mediaId: show.id, season: 1, epFrom: 1, epTo: 2, isPreferred: false });
    expect(titleByMediaId(db, show.id)!.coverage).toEqual({ aired: 2, covered: 0 });
  });

  it('covers a >500-episode season from one pack without inventing missing episodes', () => {
    const soap = seedMedia({ type: 'tv', title: 'Daily Soap', seasons: 1 });
    for (let episode = 1; episode <= 600; episode += 1) {
      db.insert(mediaEpisodes)
        .values({ mediaId: soap.id, season: 1, episode, airDate: '2024-01-01', name: null })
        .run();
    }
    seedRelease({ mediaId: soap.id, season: 1, epFrom: 1, epTo: 600 });

    const detail = titleByMediaId(db, soap.id);

    expect(detail!.coverage).toEqual({ aired: 600, covered: 600 });
    expect(detail!.missing).toEqual([]);
    expect(libraryPage(db, { limit: 48, offset: 0 }).titles[0]?.coverage).toEqual({ aired: 600, covered: 600, missing: 0 });
  });

  it('returns seasons: null when the provider supplied no episodes', () => {
    const movie = seedMedia({ type: 'movie' });
    seedRelease({ mediaId: movie.id });
    expect(titleByMediaId(db, movie.id)!.seasons).toBeNull();
  });

  it('hides the negative manual-bind sentinel from the tmdb link', () => {
    const manual = seedMedia({ tmdbId: -9216888, type: 'tv', title: 'Manual Show' });
    seedRelease({ mediaId: manual.id });
    expect(titleByMediaId(db, manual.id)!.media.tmdbId).toBeNull();
  });

  it('returns null for an unknown media id', () => {
    expect(titleByMediaId(db, 999_999)).toBeNull();
  });
});
