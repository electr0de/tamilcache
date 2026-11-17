import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, sources, topics, variants } from '@tamilcache/db/schema';
import type { TmdbCandidate } from '@tamilcache/shared';
import { rescore } from '../src/rescore.js';
import type { TmdbDetails, TmdbEpisode } from '../src/tmdb.js';

/** Stand-in for `TmdbClient`: only the calls the provider pass makes. */
class FakeTmdb {
  public searches: string[] = [];
  constructor(private readonly searchResults: Record<string, TmdbCandidate[]>, private readonly detailsById: Record<number, TmdbDetails> = {}) {}

  async search(query: string): Promise<TmdbCandidate[]> {
    this.searches.push(query);
    return this.searchResults[query] ?? [];
  }

  async details(_kind: 'movie' | 'tv', id: number): Promise<TmdbDetails> {
    const found = this.detailsById[id];
    if (!found) throw new Error(`no fixture details for ${id}`);
    return found;
  }

  async seasonNumbers(): Promise<number[]> {
    return [];
  }

  async seasonEpisodes(): Promise<TmdbEpisode[]> {
    return [];
  }
}

let db: Db;

/** A topic the old parser parked as `none`, whose film TMDB does actually know. */
function seedParkedTopic(): number {
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: 1,
      sourceTopicId: 7,
      slug: 'ramayana-2026-tamil-hq-predvd-1080p',
      rawTitle: 'Ramayana (2026) Tamil HQ PreDVD 1080p',
      kind: 'movie',
      status: 'parsed',
      providerStatus: 'none',
      providerCheckedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      resolution: '1080p',
      sourceTagRaw: 'HQ PreDVD',
      sourceTag: 'PreDVD',
      audioLangs: ['tamil'],
      sizeBytes: 3 * 1024 ** 3,
      infohash: 'b'.repeat(40),
      decision: 'unknown',
      reviewReason: 'NO_PROVIDER_MATCH',
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

const tmdbWithRamayana = () =>
  new FakeTmdb(
    { ramayana: [{ id: 656908, mediaType: 'movie', title: 'Ramayana: Rise of a Legend', year: 2026, originalLanguage: 'hi', popularity: 154 }] },
    { 656908: detailsFor({ id: 656908, title: 'Ramayana: Rise of a Legend', originalLanguage: 'hi' }) },
  );

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 64, name: 'Hindi Dubbed', inScope: true }).run();
});

describe('rescore', () => {
  it('re-judges parked rows with the corrected parser and empties the queue', async () => {
    seedParkedTopic();

    const summary = await rescore(db, tmdbWithRamayana() as never, { dryRun: false });

    expect(summary).toMatchObject({ scanned: 1, matched: 1, stillStuck: 0, dryRun: false });
    expect(db.select().from(topics).all()[0]?.providerStatus).toBe('matched');
    expect(db.select().from(variants).all()[0]?.decision).not.toBe('unknown');
  });

  it('dry-run changes nothing', async () => {
    seedParkedTopic();

    const summary = await rescore(db, tmdbWithRamayana() as never, { dryRun: true });

    expect(summary).toMatchObject({ dryRun: true, stillStuck: 1 });
    expect(db.select().from(topics).all()[0]?.providerStatus).toBe('none');
    expect(db.select().from(variants).all()[0]?.decision).toBe('unknown');
  });
});
