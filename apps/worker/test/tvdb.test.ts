import { describe, expect, it, vi } from 'vitest';
import { TvdbClient } from '../src/tvdb.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TvdbClient', () => {
  it('logs in once and reuses the token', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/login')) return json({ data: { token: 'jwt-1' } });
      return json({ data: [] });
    });
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    await client.search('panthadikkaam');
    await client.search('thalaimai seyalagam');

    expect(fetchImpl.mock.calls.filter(([target]) => target.endsWith('/login'))).toHaveLength(1);
  });

  it('reads the fields the ladder needs from a series record', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login')
        ? json({ data: { token: 'jwt-1' } })
        : json({
            data: {
              id: 483535,
              name: 'Karthika Deepam',
              firstAired: '2017-10-16',
              originalLanguage: 'tel',
              originalCountry: 'ind',
              status: { name: 'Continuing' },
              aliases: [{ name: 'Karthika Deepam' }],
              episodes: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
            },
          }),
    );
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    const series = await client.series(483535);

    expect(series).toMatchObject({
      tvdbId: 483535,
      title: 'Karthika Deepam',
      originalLanguage: 'te',
      originalCountry: 'ind',
      episodes: 5,
    });
    expect(series.aliases).toEqual(['Karthika Deepam']);
  });

  it('maps three-letter TVDB languages to the two-letter codes the classifier compares', () => {
    expect(TvdbClient.language('tam')).toBe('ta');
    expect(TvdbClient.language('mal')).toBe('ml');
    expect(TvdbClient.language('hin')).toBe('hi');
    expect(TvdbClient.language('xyz')).toBeNull();
  });

  it('logs in again exactly once after a 401', async () => {
    let mode: 'token1' | 'token2' = 'token1';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/login')) return json({ data: { token: mode === 'token1' ? 'jwt-1' : 'jwt-2' } });
      if (mode === 'token1') {
        mode = 'token2';
        return json({ error: 'unauthorized' }, 401);
      }
      return json({ data: [] });
    });
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    await expect(client.search('x')).resolves.toEqual([]);
    expect(fetchImpl.mock.calls.filter(([target]) => target.endsWith('/login'))).toHaveLength(2);
  });

  it('seeds its token from the store so a restart does not log in again', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login') ? json({ data: { token: 'fresh' } }) : json({ data: [] }),
    );
    const client = new TvdbClient({ apiKey: 'k', fetchImpl, tokenStore: { get: () => 'stored', set: () => {} } });

    await client.search('x');

    expect(fetchImpl.mock.calls.filter(([target]) => target.endsWith('/login'))).toHaveLength(0);
  });

  it('asks for the episode list, because TVDB omits it without meta=episodes', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login') ? json({ data: { token: 'jwt-1' } }) : json({ data: {} }),
    );
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    await client.series(483535);

    const target = fetchImpl.mock.calls.map(([url]) => url).find((url) => url.includes('/series/483535'));
    expect(target).toContain('meta=episodes');
  });

  it('counts seasons from the record', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login')
        ? json({ data: { token: 'jwt-1' } })
        : json({ data: { id: 483535, name: 'Karthika Deepam', seasons: [{ id: 1 }, { id: 2 }, { id: 3 }] } }),
    );
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    await expect(client.series(483535)).resolves.toMatchObject({ seasons: 3 });
  });

  it('maps remote ids by source name, not by array position', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login')
        ? json({ data: { token: 'jwt-1' } })
        : json({
            data: {
              id: 483535,
              name: 'Karthika Deepam',
              // Deliberately TMDB-first: the live API's ordering is upstream's to change.
              remoteIds: [
                { id: '15643', type: 12, sourceName: 'TheMovieDB.com' },
                { id: 'tt0098791', type: 2, sourceName: 'IMDB' },
              ],
            },
          }),
    );
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    await expect(client.series(483535)).resolves.toMatchObject({ imdbId: 'tt0098791', tmdbId: 15643 });
  });

  it('ignores a non-numeric TMDB remote id instead of storing NaN', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login')
        ? json({ data: { token: 'jwt-1' } })
        : json({ data: { id: 1, name: 'X', remoteIds: [{ id: 'n/a', type: 12, sourceName: 'TheMovieDB.com' }] } }),
    );
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    await expect(client.series(1)).resolves.toMatchObject({ imdbId: null, tmdbId: null });
  });

  it('rejects a 200 with no data instead of returning a hollow record', async () => {
    // `body.data ?? {}` used to yield `{ tvdbId: 1, title: '' }`, which the route reported as a
    // successful lookup and the panel rendered as "no linked record".
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login') ? json({ data: { token: 'jwt-1' } }) : json({ data: null }),
    );
    const client = new TvdbClient({ apiKey: 'k', fetchImpl });

    await expect(client.series(1)).rejects.toThrow(/no series data/i);
  });
});
