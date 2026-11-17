import { describe, expect, it, vi } from 'vitest';
import { TmdbClient } from '../src/tmdb.js';

function client(responses: Record<string, unknown>, statuses: Record<string, number> = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname.replace('/3', '');
    const body = responses[path];
    return new Response(JSON.stringify(body ?? { results: [] }), { status: statuses[path] ?? 200 });
  });
  return {
    client: new TmdbClient({ apiKey: 'k', fetchImpl, minIntervalMs: 0 }),
    calls,
    fetchImpl,
  };
}

describe('search', () => {
  it('maps movie and tv results and drops people/unknowns', async () => {
    const { client: tmdb } = client({
      '/search/multi': {
        results: [
          { id: 1, media_type: 'movie', title: 'Jailer 2', release_date: '2026-08-14', original_language: 'ta', popularity: 26 },
          { id: 2, media_type: 'tv', name: 'Jailer 2 - Rave', first_air_date: '2026-01-01', original_language: 'ta', popularity: 1 },
          { id: 3, media_type: 'person', name: 'Somebody' },
        ],
      },
    });

    const results = await tmdb.search('jailer 2', { year: 2026 });
    expect(results).toEqual([
      { id: 1, mediaType: 'movie', title: 'Jailer 2', year: 2026, originalLanguage: 'ta', popularity: 26 },
      { id: 2, mediaType: 'tv', title: 'Jailer 2 - Rave', year: 2026, originalLanguage: 'ta', popularity: 1 },
    ]);
  });

  it('sends the api key and the year filter', async () => {
    const { client: tmdb, calls } = client({ '/search/multi': { results: [] } });
    await tmdb.search('scene', { year: 2026 });
    expect(calls[0]).toContain('api_key=k');
    expect(calls[0]).toContain('year=2026');
  });

  it('throws a clear error on 429', async () => {
    const { client: tmdb } = client({ '/search/multi': {} }, { '/search/multi': 429 });
    await expect(tmdb.search('x')).rejects.toThrow(/rate limited/i);
  });

  it('throws on 401 with the status visible', async () => {
    const { client: tmdb } = client({ '/search/multi': {} }, { '/search/multi': 401 });
    await expect(tmdb.search('x')).rejects.toThrow(/TMDB 401/);
  });
});

describe('details', () => {
  it('reads imdb id, null tvdb id, seasons count and poster', async () => {
    const { client: tmdb } = client({
      '/tv/337062': { id: 337062, name: 'Panthadikkaam', first_air_date: '2026-10-01', original_language: 'ml', seasons: [{ season_number: 0 }, { season_number: 1 }], poster_path: '/p.jpg' },
      '/tv/337062/external_ids': { imdb_id: 'tt47657304', tvdb_id: null },
    });

    const details = await tmdb.details('tv', 337062);
    expect(details).toMatchObject({
      mediaType: 'tv',
      title: 'Panthadikkaam',
      year: 2026,
      originalLanguage: 'ml',
      imdbId: 'tt47657304',
      tvdbId: null,
      // Season 0 is "specials" and is excluded, so this is one real season.
      seasons: 1,
      posterPath: '/p.jpg',
    });
  });

  it('keeps genres, rating, runtime, backdrop and status from the same response', async () => {
    const { client: tmdb } = client({
      '/movie/603': {
        id: 603,
        title: 'The Matrix',
        release_date: '1999-03-30',
        original_language: 'en',
        genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
        vote_average: 8.2,
        vote_count: 24_500,
        runtime: 136,
        backdrop_path: '/b.jpg',
        status: 'Released',
        poster_path: '/p.jpg',
        overview: 'A hacker learns the truth.',
      },
      '/movie/603/external_ids': { imdb_id: 'tt0133093', tvdb_id: null },
    });

    const details = await tmdb.details('movie', 603);

    expect(details).toMatchObject({
      genres: ['Action', 'Science Fiction'],
      voteAverage: 8.2,
      voteCount: 24_500,
      runtime: 136,
      backdropPath: '/b.jpg',
      status: 'Released',
    });
  });

  it('falls back to episode_run_time for a series and tolerates missing enrichment', async () => {
    const { client: tmdb } = client({
      '/tv/9': { id: 9, name: 'Show', first_air_date: '2020-01-01', original_language: 'ta', episode_run_time: [45], seasons: [{ season_number: 1 }] },
      '/tv/9/external_ids': { imdb_id: null, tvdb_id: null },
    });

    const details = await tmdb.details('tv', 9);

    expect(details.runtime).toBe(45);
    expect(details.genres).toEqual([]);
    expect(details.voteAverage).toBeNull();
    expect(details.backdropPath).toBeNull();
  });
});

describe('episodes', () => {
  it('returns season episodes and skips malformed ones', async () => {
    const { client: tmdb } = client({
      '/tv/1/season/1': {
        episodes: [
          { episode_number: 1, air_date: '2026-10-01', name: 'One' },
          { episode_number: 2, air_date: null, name: 'Two' },
          { name: 'no number' },
        ],
      },
    });
    const episodes = await tmdb.seasonEpisodes(1, 1);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({ season: 1, episode: 1, airDate: '2026-10-01', name: 'One' });
  });

  it('lists season numbers excluding specials', async () => {
    const { client: tmdb } = client({
      '/tv/1': { seasons: [{ season_number: 0 }, { season_number: 2 }, { season_number: 1 }] },
    });
    expect(await tmdb.seasonNumbers(1)).toEqual([1, 2]);
  });
});

describe('rate limiting', () => {
  it('spaces calls by minIntervalMs', async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const tmdb = new TmdbClient({
      apiKey: 'k',
      minIntervalMs: 50,
      fetchImpl: async () => new Response('{"results":[]}', { status: 200 }),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    await tmdb.search('a');
    await tmdb.search('b');
    expect(sleeps).toContain(50);
  });
});

describe('resilience', () => {
  it('retries once on a 5xx', async () => {
    let calls = 0;
    const tmdb = new TmdbClient({
      apiKey: 'k',
      minIntervalMs: 0,
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response('bad gateway', { status: 502 })
          : new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
    });
    await expect(tmdb.search('x')).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it('keeps the match when external_ids fails', async () => {
    const tmdb = new TmdbClient({
      apiKey: 'k',
      minIntervalMs: 0,
      fetchImpl: async (url: string) => {
        if (url.includes('external_ids')) return new Response('nope', { status: 502 });
        return new Response(JSON.stringify({ id: 1, name: 'Show', first_air_date: '2026-01-01', original_language: 'ta' }), { status: 200 });
      },
    });
    const details = await tmdb.details('tv', 1);
    expect(details.title).toBe('Show');
    expect(details.imdbId).toBeNull();
    expect(details.tvdbId).toBeNull();
  });
});

describe('findByImdbId', () => {
  it('maps /find results from both namespaces into candidates', async () => {
    const client = new TmdbClient({
      apiKey: 'k',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            movie_results: [{ id: 27205, title: 'Inception', release_date: '2010-07-15', original_language: 'en', popularity: 9 }],
            tv_results: [{ id: 1399, name: 'GoT', first_air_date: '2011-04-17', original_language: 'en', popularity: 8 }],
          }),
          { status: 200 },
        ),
    });

    const found = await client.findByImdbId('tt1375666');

    expect(found).toMatchObject([
      { id: 27205, mediaType: 'movie', title: 'Inception', year: 2010 },
      { id: 1399, mediaType: 'tv', title: 'GoT', year: 2011 },
    ]);
  });
});
