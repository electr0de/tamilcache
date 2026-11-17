import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { appState, crawlTasks, forums, links, sources, topics, variants } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/server.js';

const KEY = 'k';
let db: Db;

function app() {
  return buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484' });
}

const url = (path: string) => `${path}${path.includes('?') ? '&' : '?'}apikey=${KEY}`;

function seedTopic(
  status: 'external' | 'gone' | 'parse_failed' | 'no_link',
  kind: 'shortener' | 'spam' | null = null,
  overrides: { title?: string; forumId?: number } = {},
): number {
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: overrides.forumId ?? 1,
      sourceTopicId: 100 + Math.floor(Math.random() * 10_000),
      slug: 'gated-film-2026',
      rawTitle: overrides.title ?? 'Gated Film (2026) Hindi WEB-DL',
      kind: 'movie',
      status,
      views: 4200,
    })
    .returning()
    .get();
  if (kind) {
    db.insert(links).values({ topicId: topic.id, url: `https://host/${kind}`, kind, label: 'host' }).run();
  }
  return topic.id;
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 64, name: 'Hindi dubbed', slug: 'hindi-dubbed-movies', inScope: true }).run();
});

describe('GET /api/v1/unresolved', () => {
  it('lists a topic that has no variants, with its views and post links', async () => {
    seedTopic('external', 'shortener');

    const response = await app().inject({ url: url('/api/v1/unresolved') });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { rows: Array<{ status: string; views: number; links: Array<{ kind: string; url: string }> }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ status: 'external', views: 4200 });
    expect(body.rows[0]?.links[0]).toMatchObject({ kind: 'shortener' });
  });

  it('filters by status and never lists chrome', async () => {
    seedTopic('external', 'shortener');
    seedTopic('gone', null);

    const external = (await app().inject({ url: url('/api/v1/unresolved?status=external') })).json() as { rows: unknown[] };
    const gone = (await app().inject({ url: url('/api/v1/unresolved?status=gone') })).json() as { rows: unknown[] };

    expect(external.rows).toHaveLength(1);
    expect(gone.rows).toHaveLength(1);
  });

  it('rejects an unknown status filter', async () => {
    const response = await app().inject({ url: url('/api/v1/unresolved?status=nonsense') });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/v1/topics/:id/magnet', () => {
  const body = {
    magnet: `magnet:?xt=urn:btih:${'ab'.repeat(20)}`,
    resolution: '1080p',
    sizeBytes: 6 * 1024 ** 3,
    sourceTag: 'WEB-DL',
    audioLangs: ['hindi', 'tamil'],
  };

  it('creates a feed-visible variant and marks the topic parsed', async () => {
    const topicId = seedTopic('external', 'shortener');

    const response = await app().inject({ url: url(`/api/v1/topics/${topicId}/magnet`), method: 'POST', payload: body });

    expect(response.statusCode).toBe(200);
    expect(db.select().from(topics).where(eq(topics.id, topicId)).get()?.status).toBe('parsed');
    const row = db.select().from(variants).all()[0];
    expect(row).toMatchObject({
      infohash: 'ab'.repeat(20),
      resolution: '1080p',
      decision: 'hindi_dubbed',
      decisionSource: 'human',
      isPreferred: true,
    });
    expect(row?.normTitle).toBeTruthy();
  });

  it('rejects a magnet that is not a magnet', async () => {
    const topicId = seedTopic('external', 'shortener');
    const response = await app().inject({
      url: url(`/api/v1/topics/${topicId}/magnet`),
      method: 'POST',
      payload: { ...body, magnet: 'https://gplinks.co/abc' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to duplicate an infohash that is already indexed', async () => {
    const topicId = seedTopic('external', 'shortener');
    const first = await app().inject({ url: url(`/api/v1/topics/${topicId}/magnet`), method: 'POST', payload: body });
    const second = await app().inject({ url: url(`/api/v1/topics/${topicId}/magnet`), method: 'POST', payload: body });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
  });
});

describe('POST /api/v1/topics/:id/recheck', () => {
  it('queues one fetch instead of blocking the request on the site', async () => {
    const topicId = seedTopic('gone', null);

    const response = await app().inject({ url: url(`/api/v1/topics/${topicId}/recheck`), method: 'POST' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ queued: true });
    const task = db.select().from(crawlTasks).all()[0];
    expect(task).toMatchObject({ priority: 0, state: 'pending' });
  });
});

describe('GET /api/v1/coverage', () => {
  it('returns the last audit, or null', async () => {
    const empty = await app().inject({ url: url('/api/v1/coverage') });
    expect(empty.json()).toMatchObject({ report: null });

    db.insert(appState).values({ key: 'coverage_report', value: '{"exitCode":0,"boards":[],"problems":[]}' }).run();
    const seeded = await app().inject({ url: url('/api/v1/coverage') });
    expect(seeded.json()).toMatchObject({ report: { exitCode: 0 } });
  });
});

describe('POST /topics/:id/magnet — review finding: no duplicate preferred release', () => {
  it('replaces the preferred row instead of leaving two for the same title+resolution', async () => {
    const topicId = seedTopic('external', 'shortener');
    const first = await app().inject({
      url: url(`/api/v1/topics/${topicId}/magnet`),
      method: 'POST',
      payload: { magnet: `magnet:?xt=urn:btih:${'11'.repeat(20)}`, resolution: '1080p', sizeBytes: 5 * 1024 ** 3, sourceTag: 'WEB-DL', audioLangs: ['hindi'] },
    });
    const second = await app().inject({
      url: url(`/api/v1/topics/${topicId}/magnet`),
      method: 'POST',
      payload: { magnet: `magnet:?xt=urn:btih:${'22'.repeat(20)}`, resolution: '1080p', sizeBytes: 6 * 1024 ** 3, sourceTag: 'WEB-DL', audioLangs: ['hindi'] },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const preferred = db.select().from(variants).all().filter((row) => row.isPreferred);
    // Same topic, same resolution, two magnets: exactly one may be preferred, or the *arr sees the
    // film twice at 1080p (different infohashes, so dedupeByInfohash cannot collapse them).
    expect(preferred).toHaveLength(1);
  });
});

describe('GET /api/v1/unresolved — paging, search, filters', () => {
  it('defaults to all four states and reports per-status counts', async () => {
    seedTopic('external', 'shortener', { title: 'Gated One' });
    seedTopic('no_link', null, { title: 'Nothing Linked' });
    seedTopic('gone', null, { title: 'Deleted One' });

    const body = (await app().inject({ url: url('/api/v1/unresolved') })).json() as {
      rows: unknown[];
      total: number;
      counts: Record<string, number>;
    };

    expect(body.rows).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.counts).toMatchObject({ external: 1, no_link: 1, gone: 1, parse_failed: 0 });
  });

  it('pages with a total, never more than the limit, and reports the last page short', async () => {
    for (let i = 0; i < 7; i++) seedTopic('external', 'shortener', { title: `Gated ${i}` });

    const first = (await app().inject({ url: url('/api/v1/unresolved?limit=3&page=1') })).json() as {
      rows: unknown[]; total: number; pages: number;
    };
    const last = (await app().inject({ url: url('/api/v1/unresolved?limit=3&page=3') })).json() as { rows: unknown[] };

    expect(first.rows).toHaveLength(3);
    expect(first.total).toBe(7);
    expect(first.pages).toBe(3);
    expect(last.rows).toHaveLength(1);
  });

  it('searches the title case-insensitively and escapes LIKE wildcards', async () => {
    seedTopic('external', 'shortener', { title: 'Return to the Jurassic (2025)' });
    seedTopic('external', 'shortener', { title: '100% Wolf (2025)' });

    const jurassic = (await app().inject({ url: url('/api/v1/unresolved?q=JURASSIC') })).json() as { rows: unknown[] };
    const percent = (await app().inject({ url: url('/api/v1/unresolved?q=100%25') })).json() as { rows: unknown[] };

    expect(jurassic.rows).toHaveLength(1);
    // '%' typed by a human must not match everything
    expect(percent.rows).toHaveLength(1);
  });

  it('filters by board and by one status', async () => {
    db.insert(forums).values({ sourceId: 1, sourceForumId: 12, name: 'HD-Rips', slug: 'hd-rips', inScope: true }).run();
    const other = db.select().from(forums).where(eq(forums.sourceForumId, 12)).get();
    seedTopic('external', 'shortener', { title: 'Board 12 Post', forumId: other!.id });
    seedTopic('external', 'shortener', { title: 'Board 64 Post' });

    const board = (await app().inject({ url: url(`/api/v1/unresolved?forum=${other!.id}`) })).json() as { rows: unknown[] };
    const onlyGone = (await app().inject({ url: url('/api/v1/unresolved?status=gone') })).json() as { rows: unknown[]; total: number };

    expect(board.rows).toHaveLength(1);
    expect(onlyGone.rows).toHaveLength(0);
    expect(onlyGone.total).toBe(0);
  });

  it('puts a never-looked-at row before a recently touched one when views are equal', async () => {
    const older = seedTopic('external', 'shortener', { title: 'Older Untouched' });
    const newer = seedTopic('external', 'shortener', { title: 'Newer Touched' });
    db.update(topics).set({ views: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).where(eq(topics.id, older)).run();
    db.update(topics).set({ views: null, lastSeenAt: '2026-11-01T00:00:00.000Z' }).where(eq(topics.id, newer)).run();

    const body = (await app().inject({ url: url('/api/v1/unresolved') })).json() as { rows: Array<{ id: number }> };

    expect(body.rows[0]?.id).toBe(older);
  });

  it('returns each row its own links', async () => {
    const a = seedTopic('external', 'shortener', { title: 'A' });
    const b = seedTopic('external', null, { title: 'B' });

    const body = (await app().inject({ url: url('/api/v1/unresolved') })).json() as {
      rows: Array<{ id: number; links: unknown[] }>;
    };
    const byId = new Map(body.rows.map((row) => [row.id, row.links]));

    expect(byId.get(a)).toHaveLength(1);
    expect(byId.get(b)).toHaveLength(0);
  });

  it('rejects a bad page, a bad limit and an unknown status', async () => {
    expect((await app().inject({ url: url('/api/v1/unresolved?limit=9999') })).statusCode).toBe(400);
    expect((await app().inject({ url: url('/api/v1/unresolved?page=0') })).statusCode).toBe(400);
    expect((await app().inject({ url: url('/api/v1/unresolved?status=nonsense') })).statusCode).toBe(400);
  });
});
