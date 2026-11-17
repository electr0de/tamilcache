import { describe, expect, it, vi } from 'vitest';
import { OmdbClient, OmdbQuotaExceededError } from '../src/omdb.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('OmdbClient.search', () => {
  it('maps a series hit into a candidate with the imdb id attached', async () => {
    const client = new OmdbClient({
      apiKey: 'k',
      fetchImpl: async () =>
        json({ Search: [{ Title: 'Karthika Deepam', Year: '2017–', imdbID: 'tt9216888', Type: 'series' }] }),
    });

    const hits = await client.search('karthika deepam', 2017);

    expect(hits).toEqual([
      { imdbId: 'tt9216888', title: 'Karthika Deepam', year: 2017, mediaType: 'tv', poster: null },
    ]);
  });

  it('drops episodes — they are not attachable titles', async () => {
    const client = new OmdbClient({
      apiKey: 'k',
      fetchImpl: async () =>
        json({
          Search: [
            { Title: 'Show', Year: '2020', imdbID: 'tt1', Type: 'series' },
            { Title: 'Show Ep 1', Year: '2020', imdbID: 'tt2', Type: 'episode' },
          ],
        }),
    });

    expect((await client.search('show')).map((hit) => hit.imdbId)).toEqual(['tt1']);
  });

  it('treats Response: "False" as an empty result, not a failure', async () => {
    const client = new OmdbClient({
      apiKey: 'k',
      fetchImpl: async () => json({ Response: 'False', Error: 'Movie not found!' }),
    });

    await expect(client.search('nothing')).resolves.toEqual([]);
  });

  it('refuses to search once the daily budget is spent, without a network call', async () => {
    const fetchImpl = vi.fn();
    const client = new OmdbClient({
      apiKey: 'k',
      fetchImpl,
      quota: { used: async () => 1000, increment: async () => 1001 },
    });

    await expect(client.search('anything')).rejects.toBeInstanceOf(OmdbQuotaExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('increments the quota once per search, after the guard', async () => {
    const increment = vi.fn(async () => 1);
    const client = new OmdbClient({
      apiKey: 'k',
      fetchImpl: async () => json({ Search: [] }),
      quota: { used: async () => 0, increment },
    });

    await client.search('x');

    expect(increment).toHaveBeenCalledTimes(1);
  });

  it('retries once on a 5xx and then gives up', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({ Search: [{ Title: 'A', Year: '2020', imdbID: 'tt9', Type: 'movie' }] }));

    const client = new OmdbClient({ apiKey: 'k', fetchImpl, sleep: async () => {} });

    expect(await client.search('a')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
