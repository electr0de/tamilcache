import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { backfillState, crawlTasks, forums, links, logEvents, topics, variants } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';
import { enqueue } from '../src/queue.js';
import { seedSourcesAndForums, type ForumConfig } from '../src/config.js';
import {
  backoffMsFor,
  backfillComplete,
  drainQueue,
  nextBackfillForums,
  runBackfillPage,
  runDelta,
  type CrawlContext,
} from '../src/crawl.js';
import { CircuitOpenError } from '../src/http-client.js';

const FIXTURES = join(import.meta.dirname, '../../../packages/shared/test/fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const BASE = 'https://www.1tamilmv.io';

const CONFIG: ForumConfig[] = [
  { id: 64, slug: '64-hindi-dubbed-movies', language: 'hindi' },
  { id: 22, slug: '22-telugu-language', language: 'telugu' },
];

class FakeHttp {
  public calls: string[] = [];
  constructor(private readonly routes: Record<string, string>, private readonly fallback: string) {}
  async get(url: string) {
    this.calls.push(url);
    return { status: 200, body: this.routes[url] ?? this.fallback, url };
  }
}

let db: Db;

function makeContext(routes: Record<string, string>, fallback = 'single-quality.html'): CrawlContext {
  const { sourceId } = seedSourcesAndForums(db, BASE, CONFIG);
  return { db, http: new FakeHttp(routes, fixture(fallback)), baseUrl: BASE, sourceId, config: CONFIG };
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
});

describe('seeding', () => {
  it('is idempotent and marks forums in scope', () => {
    const first = seedSourcesAndForums(db, BASE, CONFIG);
    const second = seedSourcesAndForums(db, BASE, CONFIG);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.forumIds.get(64)).toBe(first.forumIds.get(64));
  });
});

describe('runDelta', () => {
  it('enqueues home topics and one listing page per forum, all at priority 0', async () => {
    const ctx = makeContext({ [`${BASE}/`]: fixture('home.html') });
    const { enqueued } = await runDelta(ctx);
    expect(enqueued).toBeGreaterThan(10);
    const rows = db.select().from(crawlTasks).all();
    expect(rows.every((row) => row.priority === 0)).toBe(true);
    expect(rows.filter((row) => row.kind === 'listing')).toHaveLength(CONFIG.length);
  });

  it('re-arms already-done delta topics instead of dropping them', async () => {
    const ctx = makeContext({ [`${BASE}/`]: fixture('home.html') });
    await runDelta(ctx);
    for (const row of db.select().from(crawlTasks).all()) {
      db.update(crawlTasks).set({ state: 'done' }).run();
    }
    const before = db.select().from(crawlTasks).all().length;
    await runDelta(ctx);
    expect(db.select().from(crawlTasks).all()).toHaveLength(before);
    expect(db.select().from(crawlTasks).all().filter((row) => row.state === 'pending').length).toBeGreaterThan(10);
  });

  it('does not duplicate topics when run twice', async () => {
    const ctx = makeContext({ [`${BASE}/`]: fixture('home.html') });
    await runDelta(ctx);
    const count = db.select().from(topics).all().length;
    await runDelta(ctx);
    expect(db.select().from(topics).all().length).toBe(count);
  });
});

describe('drainQueue', () => {
  it('persists topics and variants from a listing page', async () => {
    // Topic fallback is a 1080p-bearing page: everything below 1080p is now dropped at persist.
    const ctx = makeContext(
      {
        [`${BASE}/`]: fixture('home.html'),
        [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]: fixture('pagination.html'),
        [`${BASE}/index.php?/forums/forum/22-telugu-language/`]: fixture('pagination.html'),
      },
      'multi-quality.html',
    );
    await runDelta(ctx);
    await drainQueue(ctx, { max: 5 });

    const storedTopics = db.select().from(topics).all();
    expect(storedTopics.length).toBeGreaterThan(0);
    const storedVariants = db.select().from(variants).all();
    expect(storedVariants.length).toBeGreaterThan(0);
    for (const variant of storedVariants) {
      expect(variant.infohash).toMatch(/^[0-9a-f]{40}$/);
      expect(variant.sourceTag).not.toBe('');
    }
  });

  it('is idempotent: a second drain of the same topics adds no rows', async () => {
    const routes = {
      [`${BASE}/`]: fixture('home.html'),
      [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]: fixture('pagination.html'),
      [`${BASE}/index.php?/forums/forum/22-telugu-language/`]: fixture('pagination.html'),
    };
    const ctx = makeContext(routes, 'multi-quality.html');
    await runDelta(ctx);
    await drainQueue(ctx, { max: 3 });
    const firstTopics = db.select().from(topics).all().length;
    const firstVariants = db.select().from(variants).all().length;

    const again = makeContext(routes, 'multi-quality.html');
    await runDelta(again);
    await drainQueue(again, { max: 3 });

    expect(db.select().from(topics).all().length).toBe(firstTopics);
    expect(db.select().from(variants).all().length).toBe(firstVariants);
  });

  it('stores classified links but not torrent attachments or forum-internal links', async () => {
    const topicUrl = `${BASE}/index.php?/forums/topic/200840-jailer-2/`;
    const ctx = makeContext({ [topicUrl]: fixture('multi-quality.html') });
    const forumRow = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    expect(forumRow).toBeDefined();
    enqueue(db, { url: topicUrl, kind: 'topic', priority: 1, payload: { forumId: forumRow?.id } });
    await drainQueue(ctx, { max: 1 });

    const kinds = new Set(db.select().from(links).all().map((row) => row.kind));
    expect(kinds.has('shortener') || kinds.has('stream')).toBe(true);
    expect(kinds.has('torrent')).toBe(false);
    expect(kinds.has('other')).toBe(false);
  });
});

/**
 * A post whose body carries no magnet at all (shortener-only uploads, Google-Drive gates) parses
 * to zero variants. That page is *not* broken — the markup is exactly what it always is — so it
 * must be recorded and moved on from, not retried into the dead-letter queue. Verified live on
 * topic 190630 (gplinks `.zip` links, zero magnets).
 */
describe('posts with no magnet at all', () => {
  it('records a shortener-only topic as external and completes the task', async () => {
    const topicUrl = `${BASE}/index.php?/forums/topic/200900-shortener-only-film/`;
    const ctx = makeContext({ [topicUrl]: fixture('gdrive-only.html') });
    const forumRow = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    enqueue(db, { url: topicUrl, kind: 'topic', priority: 1, payload: { forumId: forumRow?.id } });

    const result = await drainQueue(ctx, { max: 1 });

    expect(result.failed).toBe(0);
    expect(result.dead).toBe(0);
    expect(db.select().from(crawlTasks).all()[0]?.state).toBe('done');
    const topic = db.select().from(topics).all()[0];
    // `gdrive-only.html` carries adrinolinks gates and no magnet: resolvable by a human.
    expect(topic?.status).toBe('external');
    const events = db.select().from(logEvents).all();
    expect(events.some((event) => event.event === 'topic.external')).toBe(true);
  });

  it('records a magnet with no anchored block as parse_failed instead of failing the task', async () => {
    // Markup drift: the page has a magnet, so the block rule *should* have matched something.
    const topicUrl = `${BASE}/index.php?/forums/topic/200901-drifted-markup/`;
    const html = [
      '<html><head><meta property="og:title" content="Drift (2026)"></head><body>',
      '<div data-role="commentContent">',
      '<a href="/index.php?/forums/topic/200901-drifted-markup/">self</a>',
      `<p>Watch online<br><a href="magnet:?xt=urn:btih:${'c'.repeat(40)}">MAGNET</a></p>`,
      '</div></body></html>',
    ].join('');
    const ctx = makeContext({ [topicUrl]: html });
    const forumRow = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    enqueue(db, { url: topicUrl, kind: 'topic', priority: 1, payload: { forumId: forumRow?.id } });

    const result = await drainQueue(ctx, { max: 1 });

    // The download is there, so this is a parser defect, not the uploader's problem: count it and
    // retry on the next pass instead of burning five attempts and dead-lettering the page.
    expect(result.failed).toBe(0);
    expect(db.select().from(crawlTasks).all()[0]?.state).toBe('done');
    expect(db.select().from(topics).all()[0]?.status).toBe('parse_failed');
    const events = db.select().from(logEvents).all();
    expect(events.some((event) => event.event === 'topic.parse_failed')).toBe(true);
  });
});

describe('runBackfillPage', () => {
  it('enqueues topics at priority 1 and advances the cursor', async () => {
    const ctx = makeContext({
      [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]: fixture('pagination.html'),
    });
    seedSourcesAndForums(db, BASE, CONFIG);
    const result = await runBackfillPage(ctx, 64);
    expect(result.page).toBe(1);
    const state = db.select().from(backfillState).all()[0]!;
    expect(state.nextPage).toBe(2);
    expect(state.totalPages).toBeGreaterThan(1);
    expect(db.select().from(crawlTasks).all().every((row) => row.priority === 1)).toBe(true);
  });

  it('marks a forum done on its last page', async () => {
    db = createDb(':memory:');
    migrate(db);
    const ctx = makeContext({
      [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]:
        '<html><ol class="cTopicList"><a href="/index.php?/forums/topic/999-last-film/">Last</a></ol> Page 1 of 1</html>',
    });
    const result = await runBackfillPage(ctx, 64);
    expect(result.done).toBe(true);
    expect(db.select().from(backfillState).all()[0]!.done).toBe(true);
  });

  it('refuses a forum that is not in the scope allowlist', async () => {
    const ctx = makeContext({});
    await expect(runBackfillPage(ctx, 999)).rejects.toThrow(/not seeded/);
  });
});

describe('1080p+ selection', () => {
  it('drops everything below 1080p and keeps one preferred 1080p per topic', async () => {
    const topicUrl = `${BASE}/index.php?/forums/topic/200840-jailer-2/`;
    const ctx = makeContext({ [topicUrl]: fixture('multi-quality.html') });
    const forumRow = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    enqueue(db, { url: topicUrl, kind: 'topic', priority: 1, payload: { forumId: forumRow?.id } });
    await drainQueue(ctx, { max: 1 });

    const stored = db.select().from(variants).all();
    expect(stored.length).toBeGreaterThan(0);
    for (const variant of stored) {
      expect(['1080p', '1440p', '2160p']).toContain(variant.resolution);
    }

    // Jailer 2's 1080p encodes are 2.8GB (x264) and 1.7GB (x265): the larger one is preferred.
    const preferred = stored.filter((variant) => variant.isPreferred);
    const at1080 = preferred.filter((variant) => variant.resolution === '1080p');
    expect(at1080).toHaveLength(1);
    const sizes = stored.filter((variant) => variant.resolution === '1080p').map((variant) => variant.sizeBytes);
    expect(at1080[0]?.sizeBytes).toBe(Math.max(...sizes));
  });

  it('prefers the smallest 4K encode when a topic carries several', async () => {
    const topicUrl = `${BASE}/index.php?/forums/topic/100001-space/`;
    const html = `<html><head><title>Space</title><link rel="canonical" href="${BASE}/index.php?/forums/topic/100001-space/"></head>
      <body><div data-role="commentContent">
      <strong>Space (2026) Tamil TRUE WEB-DL - [4K &amp; 1080p - HEVC - 23GB - 9GB - 2.8GB] - ESub</strong><br>
      <strong>Space (2026) Tamil TRUE WEB-DL - 2160p - HEVC - 23GB :</strong><br>
      <a href="magnet:?xt=urn:btih:${'a'.repeat(40)}">MAGNET</a><br>
      <strong>Space (2026) Tamil TRUE WEB-DL - 2160p - HEVC - 9GB :</strong><br>
      <a href="magnet:?xt=urn:btih:${'b'.repeat(40)}">MAGNET</a><br>
      <strong>Space (2026) Tamil TRUE WEB-DL - 1080p - AVC - 2.8GB :</strong><br>
      <a href="magnet:?xt=urn:btih:${'c'.repeat(40)}">MAGNET</a><br>
      </div></body></html>`;

    const ctx = makeContext({ [topicUrl]: html });
    const forumRow = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    enqueue(db, { url: topicUrl, kind: 'topic', priority: 1, payload: { forumId: forumRow?.id } });
    await drainQueue(ctx, { max: 1 });

    const fourK = db.select().from(variants).all().filter((variant) => variant.resolution === '2160p');
    expect(fourK).toHaveLength(2);
    const preferred4k = fourK.filter((variant) => variant.isPreferred);
    expect(preferred4k).toHaveLength(1);
    expect(preferred4k[0]?.sizeBytes).toBe(Math.min(...fourK.map((variant) => variant.sizeBytes)));
  });
});

describe('crawl telemetry', () => {
  it('records a parse miss and carries the reason onto the failed task', async () => {
    const listingUrl = `${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`;
    enqueue(db, { url: listingUrl, kind: 'listing', priority: 0, payload: { forumId: 1, page: 1 } });
    const ctx = makeContext({ [listingUrl]: '' });
    const result = await drainQueue(ctx, { max: 1 });
    expect(result.failed).toBe(1);
    const events = db.select().from(logEvents).all();
    expect(events.some((event) => event.event === 'miss' && event.scope === 'parse')).toBe(true);
    const failed = events.find((event) => event.event === 'task.failed')!;
    expect(failed.detail).toContain('yielded no topics');
    expect(failed.url).toBe(listingUrl);
  });

  it('logs delta start and finish under one run id', async () => {
    const ctx = makeContext({});
    await runDelta(ctx);
    const events = db.select().from(logEvents).all();
    const start = events.find((event) => event.event === 'delta.start')!;
    const finish = events.find((event) => event.event === 'delta.finish')!;
    expect(start.level).toBe('info');
    expect(finish.runId).toBe(start.runId);
    expect(finish.detail).toContain('enqueued');
  });

  it('logs a backfill page with its topic count', async () => {
    const ctx = makeContext({
      [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]: fixture('pagination.html'),
    });
    await runBackfillPage(ctx, 64);
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get()!;
    const page = db.select().from(logEvents).all().find((event) => event.event === 'backfill.page')!;
    expect(page.forumId).toBe(forum.id);
    expect(page.detail).toContain('"page":1');
  });
});

describe('circuit breaker interaction', () => {
  it('releases the task untouched and propagates a breaker trip instead of burning an attempt', async () => {
    const url = `${BASE}/index.php?/forums/topic/1-x/`;
    enqueue(db, { url, kind: 'topic', priority: 0, payload: { forumId: 1 } });
    const ctx = makeContext({});
    ctx.http = {
      get: async () => {
        throw new CircuitOpenError(Date.now() + 60_000);
      },
    };
    await expect(drainQueue(ctx, { max: 1 })).rejects.toBeInstanceOf(CircuitOpenError);
    const row = db.select().from(crawlTasks).all()[0]!;
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(db.select().from(logEvents).all().some((event) => event.event === 'task.failed')).toBe(false);
  });
});

describe('backfill scheduling', () => {
  const THREE: ForumConfig[] = [
    { id: 9, slug: 'tamil-language', language: 'tamil', hub: true },
    { id: 11, slug: 'web-hd-itunes-hd-bluray', language: 'tamil' },
    { id: 24, slug: 'web-hd-itunes-hd-bluray', language: 'telugu' },
    { id: 58, slug: 'web-hd-itunes-hd-bluray', language: 'hindi' },
  ];

  function threeContext(): CrawlContext {
    db = createDb(':memory:');
    migrate(db);
    const { sourceId } = seedSourcesAndForums(db, BASE, THREE);
    return { db, http: new FakeHttp({}, fixture('multi-quality.html')), baseUrl: BASE, sourceId, config: THREE };
  }

  it('never enqueues a listing for a language hub', async () => {
    const ctx = threeContext();
    ctx.http = new FakeHttp({ [`${BASE}/`]: fixture('home.html') }, fixture('multi-quality.html'));
    await runDelta(ctx);
    const listings = db.select().from(crawlTasks).all().filter((row) => row.kind === 'listing');
    expect(listings).toHaveLength(3);
    expect(listings.some((row) => row.url.includes('forum/9-'))).toBe(false);
  });

  it('sweeps page 1 of every forum before page 2 of any', () => {
    const ctx = threeContext();
    const forumRow = (sourceForumId: number) =>
      db.select().from(forums).where(eq(forums.sourceForumId, sourceForumId)).get()!;

    // 11 has already done page 1; 24 and 58 have never started.
    db.insert(backfillState).values({ forumId: forumRow(11).id, nextPage: 2, updatedAt: '2026-11-11T10:00:00.000Z' }).run();

    expect(nextBackfillForums(ctx, 2)).toEqual([24, 58]);

    // After both advance, the page-2 forum comes before any page-3 work.
    db.insert(backfillState).values({ forumId: forumRow(24).id, nextPage: 2, updatedAt: '2026-11-11T11:00:00.000Z' }).run();
    db.insert(backfillState).values({ forumId: forumRow(58).id, nextPage: 2, updatedAt: '2026-11-11T12:00:00.000Z' }).run();
    expect(nextBackfillForums(ctx, 2)).toEqual([11, 24]);
  });

  it('reports completion only once every non-hub forum is done', () => {
    const ctx = threeContext();
    const forumRow = (sourceForumId: number) =>
      db.select().from(forums).where(eq(forums.sourceForumId, sourceForumId)).get()!;
    db.insert(backfillState).values({ forumId: forumRow(11).id, nextPage: 2, done: true }).run();
    db.insert(backfillState).values({ forumId: forumRow(24).id, nextPage: 2, done: true }).run();
    expect(backfillComplete(ctx)).toBe(false);
    db.insert(backfillState).values({ forumId: forumRow(58).id, nextPage: 2, done: true }).run();
    expect(backfillComplete(ctx)).toBe(true);
  });

  it('skips a forum until its retry window opens, so a failure cannot starve the others', () => {
    const ctx = threeContext();
    const forumRow = (sourceForumId: number) =>
      db.select().from(forums).where(eq(forums.sourceForumId, sourceForumId)).get()!;
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    const retryAfter = new Date(now + 5 * 60_000).toISOString();
    // 11 is failing at page 1; without the retry filter it outranks both page-2 forums.
    db.insert(backfillState)
      .values({ forumId: forumRow(11).id, nextPage: 1, failures: 2, lastError: 'boom', retryAfter })
      .run();
    db.insert(backfillState).values({ forumId: forumRow(24).id, nextPage: 2 }).run();
    db.insert(backfillState).values({ forumId: forumRow(58).id, nextPage: 2 }).run();

    expect(nextBackfillForums(ctx, 2, now)).toEqual([24, 58]);
    expect(nextBackfillForums(ctx, 2, now + 6 * 60_000)).toContain(11);
  });
});

describe('backfill completion from a real page', () => {
  it('marks a forum done when its last page was captured, and keeps the count', async () => {
    const ctx = makeContext({
      [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/page/46/`]: fixture('forum-listing-last.html'),
    });
    const forumRow = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get()!;
    db.insert(backfillState).values({ forumId: forumRow.id, nextPage: 46 }).run();

    const result = await runBackfillPage(ctx, 64);
    expect(result.page).toBe(46);
    expect(result.done).toBe(true);
    const state = db.select().from(backfillState).all()[0]!;
    expect(state.done).toBe(true);
    expect(state.totalPages).toBe(46);
    expect(db.select().from(crawlTasks).all().filter((row) => row.kind === 'topic')).toHaveLength(6);
  });
});

describe('empty forums', () => {
  it('completes an empty forum instead of dead-lettering its listing page', async () => {
    const emptyForum = '<html><ol class="cTopicList"></ol><span>Page 1 of 1</span></html>';
    const ctx = makeContext({ [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]: emptyForum });
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get()!;
    db.insert(backfillState).values({ forumId: forum.id, nextPage: 1 }).run();

    const result = await runBackfillPage(ctx, 64);
    expect(result.done).toBe(true);
    expect(db.select().from(crawlTasks).all()).toHaveLength(0);
  });

  it('completes a board that renders the empty state instead of the topic list', async () => {
    // Real IPS empty page (forum 26): no cTopicList at all, only the empty-state sentence.
    const ctx = makeContext({ [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]: fixture('empty-forum.html') });
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get()!;

    const result = await runBackfillPage(ctx, 64);

    expect(result.done).toBe(true);
    expect(db.select().from(crawlTasks).all()).toHaveLength(0);
    expect(db.select().from(backfillState).where(eq(backfillState.forumId, forum.id)).get()?.done).toBe(true);
  });

  it('still fails loudly when the page is not a listing at all', async () => {
    const ctx = makeContext({ [`${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`]: fixture('home.html') });
    await expect(runBackfillPage(ctx, 64)).rejects.toThrow(/yielded no topics/);
  });
});

describe('backfill failures', () => {
  const NOW = Date.parse('2026-11-11T12:00:00.000Z');
  const pageOne = `${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`;
  const forumRow = (sourceForumId: number) =>
    db.select().from(forums).where(eq(forums.sourceForumId, sourceForumId)).get()!;

  it('records the failure and schedules the first retry a minute out', async () => {
    const ctx = makeContext({ [pageOne]: fixture('home.html') }); // not a listing at all

    await expect(runBackfillPage(ctx, 64, NOW)).rejects.toThrow(/yielded no topics/);

    const row = db.select().from(backfillState).where(eq(backfillState.forumId, forumRow(64).id)).get();
    expect(row).toMatchObject({ failures: 1, nextPage: 1 });
    expect(row?.lastError).toContain('yielded no topics');
    expect(Date.parse(row!.retryAfter!)).toBe(NOW + 60_000);
  });

  it('doubles the wait per consecutive failure and caps it at an hour', () => {
    expect([1, 2, 3, 4, 7, 12].map(backoffMsFor)).toEqual([
      60_000, 120_000, 240_000, 480_000, 3_600_000, 3_600_000,
    ]);
  });

  it('clears the failure record once a page parses', async () => {
    const ctx = makeContext({ [pageOne]: fixture('pagination.html') });
    db.insert(backfillState)
      .values({
        forumId: forumRow(64).id,
        nextPage: 1,
        failures: 3,
        lastError: 'boom',
        retryAfter: new Date(NOW).toISOString(),
      })
      .run();

    await runBackfillPage(ctx, 64, NOW);

    const row = db.select().from(backfillState).where(eq(backfillState.forumId, forumRow(64).id)).get();
    expect(row).toMatchObject({ failures: 0, lastError: null, retryAfter: null });
  });
});
