import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { backfillState, crawlTasks, forums, media, sources } from '@tamilcache/db/schema';
import { buildApp } from '../src/server.js';

const KEY = 'k';
let db: Db;

const app = () => buildApp({ db, apiKey: KEY, dataDir: '/tmp/none', webDist: '/nonexistent' });

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 11, name: '11-web-hd', inScope: true }).run();
});

describe('crawl health', () => {
  it('reports how much metadata enrichment is left', async () => {
    db.insert(media).values([
      { tmdbId: 1, type: 'movie', title: 'Unenriched' },
      { tmdbId: 2, type: 'movie', title: 'Enriched', voteAverage: 7.2 },
      { tmdbId: -9, type: 'movie', title: 'Manual bind' },
    ]).run();

    const body = (await app().inject({ url: `/api/v1/crawl?apikey=${KEY}` })).json() as {
      enrichment: { remaining: number };
    };

    // The manual bind has no TMDB id to ask about, so it is not "remaining work".
    expect(body.enrichment.remaining).toBe(1);
  });

  it('reports dead-lettered tasks with their URLs', async () => {
    db.insert(crawlTasks).values([
      { url: 'https://x/pending', kind: 'topic', priority: 1, state: 'pending' },
      { url: 'https://x/broken', kind: 'topic', priority: 1, state: 'error', attempts: 5 },
      { url: 'https://x/done', kind: 'topic', priority: 1, state: 'done' },
    ]).run();

    const body = (await app().inject({ url: `/api/v1/crawl?apikey=${KEY}` })).json() as {
      dead: { count: number; sample: Array<{ url: string; attempts: number }> };
      pending: { p0: number; p1: number };
    };

    expect(body.dead.count).toBe(1);
    expect(body.dead.sample[0]).toMatchObject({ url: 'https://x/broken', attempts: 5 });
    expect(body.pending).toEqual({ p0: 0, p1: 1 });
  });

  it('reports per-forum backfill progress with a percentage', async () => {
    db.insert(backfillState).values({ forumId: 1, nextPage: 3, totalPages: 107, done: false }).run();

    const body = (await app().inject({ url: `/api/v1/crawl?apikey=${KEY}` })).json() as {
      backfill: Array<{ forum: string; nextPage: number; totalPages: number; done: boolean; percent: number }>;
    };

    expect(body.backfill).toHaveLength(1);
    expect(body.backfill[0]).toMatchObject({
      forum: '11-web-hd',
      nextPage: 3,
      totalPages: 107,
      done: false,
      percent: 3,
    });
  });

  it('reports the failure state so a stuck forum is not mistaken for a slow one', async () => {
    db.insert(backfillState)
      .values({
        forumId: 1,
        nextPage: 1,
        totalPages: null,
        done: false,
        failures: 3,
        lastError: 'backfill page 1 of forum 26 yielded no topics',
        retryAfter: '2026-11-11T12:05:00.000Z',
      })
      .run();

    const body = (await app().inject({ url: `/api/v1/crawl?apikey=${KEY}` })).json() as {
      backfill: Array<{ failures: number; lastError: string | null; retryAfter: string | null }>;
    };

    expect(body.backfill[0]).toMatchObject({
      failures: 3,
      lastError: 'backfill page 1 of forum 26 yielded no topics',
      retryAfter: '2026-11-11T12:05:00.000Z',
    });
  });

  it('caps a finished forum at 100% instead of page+1 over the last page', async () => {
    // An empty forum completes at page 1: nextPage 2, totalPages 1. Uncapped that is 200%.
    db.insert(backfillState).values({ forumId: 1, nextPage: 2, totalPages: 1, done: true }).run();
    const body = (await app().inject({ url: `/api/v1/crawl?apikey=${KEY}` })).json() as {
      backfill: Array<{ percent: number | null }>;
    };
    expect(body.backfill[0]?.percent).toBe(100);
  });

  it('reports a null percentage while the page count is unknown', async () => {
    db.insert(backfillState).values({ forumId: 1, nextPage: 1, totalPages: null, done: false }).run();
    const body = (await app().inject({ url: `/api/v1/crawl?apikey=${KEY}` })).json() as {
      backfill: Array<{ percent: number | null }>;
    };
    expect(body.backfill[0]?.percent).toBeNull();
  });

  it('keeps the existing lane flags in the same payload', async () => {
    const body = (await app().inject({ url: `/api/v1/crawl?apikey=${KEY}` })).json() as Record<string, unknown>;
    expect(body).toHaveProperty('armed');
    expect(body).toHaveProperty('paused');
    expect(body).toHaveProperty('lastDeltaAt');
    expect(body).toHaveProperty('dead');
  });
});
