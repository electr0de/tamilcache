import { describe, expect, it } from 'vitest';
import { decideMatch } from '@tamilcache/shared';
import { TmdbClient } from '../src/tmdb.js';

/**
 * Live probe. Skipped unless TMDB_API_KEY is present, so CI stays offline and deterministic,
 * but a developer with a key gets a real signal that the client, the query builder and the
 * scoring thresholds still agree with production TMDB data.
 */
const apiKey = process.env['TMDB_API_KEY']?.trim() ?? '';
const live = apiKey ? describe : describe.skip;

if (!apiKey) {
  // Vitest still imports the file; constructing the client above must not run without a key.
  describe('live TMDB probes (skipped: TMDB_API_KEY not set)', () => {
    it('is skipped', () => expect(true).toBe(true));
  });
}

live('live TMDB probes', () => {
  // Constructed per test, not at collection time: `describe` callbacks run even when the whole
  // suite is skipped, and the client throws without a key.
  const client = (): TmdbClient => new TmdbClient({ apiKey, minIntervalMs: 100 });

  it('finds Jailer 2 (2026) as a Tamil movie and accepts it', async () => {
    const candidates = await client().search('jailer 2', { year: 2026 });
    const outcome = decideMatch(candidates, { query: 'jailer 2', kind: 'movie', year: 2026 });
    expect(outcome.status).toBe('matched');
    if (outcome.status === 'matched') {
      expect(outcome.candidate.originalLanguage).toBe('ta');
      expect(outcome.candidate.mediaType).toBe('movie');
    }
  }, 30_000);

  it('binds Ramayana to the Hindi-original film (title differs, language decides)', async () => {
    const candidates = await client().search('ramayana', { year: 2026 });
    const outcome = decideMatch(candidates, { query: 'ramayana', kind: 'movie', year: 2026 });
    expect(outcome.status).toBe('matched');
    if (outcome.status === 'matched') expect(outcome.candidate.originalLanguage).toBe('hi');
  }, 30_000);

  it('returns real episode data for a regional show', async () => {
    const candidates = await client().search('panthadikkaam', { year: 2026 });
    const tv = candidates.find((candidate) => candidate.mediaType === 'tv');
    expect(tv).toBeDefined();
    if (!tv) return;

    const seasons = await client().seasonNumbers(tv.id);
    expect(seasons.length).toBeGreaterThan(0);
    const episodes = await client().seasonEpisodes(tv.id, seasons[0] as number);
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes[0]?.episode).toBe(1);
  }, 60_000);

  it('reports no tvdb id for that show, which is why caps must not advertise tvdbid', async () => {
    const candidates = await client().search('panthadikkaam', { year: 2026 });
    const tv = candidates.find((candidate) => candidate.mediaType === 'tv');
    if (!tv) return;
    const details = await client().details('tv', tv.id);
    expect(details.tvdbId).toBeNull();
    expect(details.imdbId).toMatch(/^tt\d+$/);
  }, 30_000);
});
