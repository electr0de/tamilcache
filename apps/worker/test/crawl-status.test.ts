import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { backfillState, crawlTasks, forums, links, topics, variants } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';
import { enqueue } from '../src/queue.js';
import { seedSourcesAndForums, type ForumConfig } from '../src/config.js';
import { drainQueue, runBackfillPage, type CrawlContext } from '../src/crawl.js';

const FIXTURES = join(import.meta.dirname, '../../../packages/shared/test/fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const BASE = 'https://www.1tamilmv.io';
const TOPIC = (id: number, slug: string) => `${BASE}/index.php?/forums/topic/${id}-${slug}/`;

const CONFIG: ForumConfig[] = [
  { id: 64, slug: '64-hindi-dubbed-movies', language: 'hindi' },
  { id: 27, slug: '27-hdtv-sdtv-hdtv-rips', language: 'telugu' },
];

/** A topic page shaped like the real ones: one first post, canonical link, optional links. */
function page(options: { id: number; slug: string; firstPost: string; reply?: string }): string {
  return `<html><head>
<link rel="canonical" href="${TOPIC(options.id, options.slug)}" />
<title>${options.slug} - 1TamilMV</title></head><body>
<div data-role="commentContent">${options.firstPost}</div>
${options.reply ? `<div data-role="commentContent">${options.reply}</div>` : ''}
</body></html>`;
}

class FakeHttp {
  public calls: string[] = [];
  constructor(private readonly handler: (url: string) => { status: number; body: string; url: string }) {}
  async get(url: string) {
    this.calls.push(url);
    return this.handler(url);
  }
}

let db: Db;

function ctxWith(http: FakeHttp): CrawlContext {
  const { sourceId } = seedSourcesAndForums(db, BASE, CONFIG);
  return { db, http, baseUrl: BASE, sourceId, config: CONFIG };
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
});

function enqueueTopic(url: string, forumSourceId: number): void {
  const forum = db.select().from(forums).where(eq(forums.sourceForumId, forumSourceId)).get();
  enqueue(db, { url, kind: 'topic', priority: 1, payload: { forumId: forum?.id } });
}

describe('topic status in the drain path', () => {
  it('records a deleted topic as gone and never retries it', async () => {
    const url = TOPIC(200381, 'jailer-2-2026-deleted');
    const http = new FakeHttp(() => ({ status: 404, body: '<html><title>Sorry</title></html>', url }));
    const ctx = ctxWith(http);
    enqueueTopic(url, 64);

    const stats = await drainQueue(ctx, { max: 5, nowMs: () => 0 });

    expect(stats.failed).toBe(0);
    const task = db.select().from(crawlTasks).get();
    expect(task?.state).toBe('done');
    expect(task?.attempts).toBe(0);
    const topic = db.select().from(topics).where(eq(topics.sourceTopicId, 200381)).get();
    expect(topic?.status).toBe('gone');
    expect(topic?.slug).toBe('jailer-2-2026-deleted');
  });

  it('records a magnet-less post with a real link as external, not as a failure', async () => {
    const url = TOPIC(200895, 'celebrity-master-chef-s01e17-view-online');
    const html = page({
      id: 200895,
      slug: 'celebrity-master-chef-s01e17-view-online',
      firstPost: '<strong>Celebrity Master Chef (2026) S01E17 - 1080p:</strong><br><a href="https://byseraguci.com/d/x">Stream Online</a> <a href="https://gplinks.co/THSYt">GDFlix</a>',
    });
    const http = new FakeHttp(() => ({ status: 200, body: html, url }));
    const ctx = ctxWith(http);
    enqueueTopic(url, 64);

    const stats = await drainQueue(ctx, { max: 5, nowMs: () => 0 });

    expect(stats.failed).toBe(0);
    const topic = db.select().from(topics).get();
    expect(topic?.status).toBe('external');
    // The shortener is kept so the UI can offer "open on site".
    const stored = db.select().from(links).all();
    expect(stored.some((link) => link.kind === 'shortener')).toBe(true);
  });

  it('records a magnet-less post with only site chrome as no_link', async () => {
    const url = TOPIC(200892, 'ddl-only');
    const html = page({
      id: 200892,
      slug: 'ddl-only',
      firstPost: '<strong>A Film (2026) Hindi HD - 1080p:</strong><br><a href="https://www.streamdady.com/">watch</a>',
    });
    const http = new FakeHttp(() => ({ status: 200, body: html, url }));
    const ctx = ctxWith(http);
    enqueueTopic(url, 64);

    await drainQueue(ctx, { max: 5, nowMs: () => 0 });
    expect(db.select().from(topics).get()?.status).toBe('no_link');
  });

  it('records a magnet with no anchored block as parse_failed, never as a dead letter', async () => {
    const url = TOPIC(200893, 'unanchored-block');
    const html = page({
      id: 200893,
      slug: 'unanchored-block',
      firstPost: `<p>release text without a block header</p><a href="magnet:?xt=urn:btih:${'cc'.repeat(20)}">magnet</a>`,
    });
    const http = new FakeHttp(() => ({ status: 200, body: html, url }));
    const ctx = ctxWith(http);
    enqueueTopic(url, 64);

    const stats = await drainQueue(ctx, { max: 5, nowMs: () => 0 });

    expect(stats.failed).toBe(0);
    expect(db.select().from(crawlTasks).get()?.state).toBe('done');
    expect(db.select().from(topics).get()?.status).toBe('parse_failed');
  });
});

describe('end of board', () => {
  it('marks a single-page board done when a later page redirects to its root', async () => {
    const board = `${BASE}/index.php?/forums/forum/27-hdtv-sdtv-hdtv-rips/`;
    const http = new FakeHttp((url) => ({
      status: 200,
      body: fixture('forum-listing.html'),
      // The site 303-redirects a page past the end back to the board root.
      url: url.includes('/page/') ? board : url,
    }));
    const ctx = ctxWith(http);
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 27)).get();
    expect(forum).toBeDefined();
    db.insert(backfillState).values({ forumId: forum!.id, nextPage: 2131, totalPages: null, done: false }).run();

    const result = await runBackfillPage(ctx, 27);

    expect(result.done).toBe(true);
    const state = db.select().from(backfillState).where(eq(backfillState.forumId, forum!.id)).get();
    expect(state?.done).toBe(true);
  });

  it('does not mark a mid-board page done just because it has no page count', async () => {
    const http = new FakeHttp((url) => ({ status: 200, body: fixture('forum-listing.html'), url }));
    const ctx = ctxWith(http);
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 27)).get();
    // page 1 of a board whose listing page carries "Page 1 of N"
    const result = await runBackfillPage(ctx, 27);
    expect(result.done).toBe(false);
    expect(db.select().from(backfillState).where(eq(backfillState.forumId, forum!.id)).get()?.done).toBe(false);
  });
});

describe('empty boards in the delta lane', () => {
  it('treats an empty board as done instead of a parse miss', async () => {
    const url = `${BASE}/index.php?/forums/forum/64-64-hindi-dubbed-movies/`;
    const http = new FakeHttp(() => ({ status: 200, body: fixture('empty-forum.html'), url }));
    const ctx = ctxWith(http);
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    enqueue(db, { url, kind: 'listing', priority: 0, payload: { forumId: forum?.id, page: 1 } });

    const stats = await drainQueue(ctx, { max: 1, nowMs: () => 0 });

    expect(stats.failed).toBe(0);
    expect(db.select().from(crawlTasks).get()?.state).toBe('done');
  });
});

describe('deleted topic with no forum payload', () => {
  it('marks a topic we already know as gone even when the 404 body has no breadcrumb', async () => {
    // Building the context is what seeds the forum rows.
    const ctxForSeed = ctxWith(new FakeHttp(() => ({ status: 200, body: '', url: '' })));
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    db.insert(topics)
      .values({ sourceId: 1, forumId: forum!.id, sourceTopicId: 200381, slug: 'jailer-2-deleted', rawTitle: 'Jailer 2', kind: 'movie', status: 'external' })
      .run();
    const url = TOPIC(200381, 'jailer-2-deleted');
    // A home-page (delta) task carries no forumId, and a 404 body has no breadcrumb.
    db.insert(crawlTasks).values({ url, kind: 'delta_page', priority: 0, state: 'pending' }).run();
    const ctx = { ...ctxForSeed, http: new FakeHttp(() => ({ status: 404, body: '<html><title>Sorry</title></html>', url })) };

    await drainQueue(ctx, { max: 5, nowMs: () => 0 });

    expect(db.select().from(topics).where(eq(topics.sourceTopicId, 200381)).get()?.status).toBe('gone');
  });
});

describe('a post whose only releases are below the 1080p floor', () => {
  it('is recorded as below_floor, not as a parser failure', async () => {
    const url = TOPIC(199999, 'dvd9-480p-only');
    const html = page({
      id: 199999,
      slug: 'dvd9-480p-only',
      firstPost: '<strong>Old Film (1972) Telugu DVD9 - 480p - x264 - 4.5GB :</strong><br><a href="magnet:?xt=urn:btih:' + 'dd'.repeat(20) + '">MAGNET</a>',
    });
    const http = new FakeHttp(() => ({ status: 200, body: html, url }));
    const ctx = ctxWith(http);
    enqueueTopic(url, 64);

    await drainQueue(ctx, { max: 5, nowMs: () => 0 });

    expect(db.select().from(topics).get()?.status).toBe('below_floor');
    expect(db.select().from(crawlTasks).get()?.state).toBe('done');
  });
});

describe('a post whose only link is a shortener we do not know', () => {
  it('is external, not no_link — a person can follow that link', async () => {
    const url = TOPIC(200900, 'unknown-shortener-post');
    const html = page({
      id: 200900,
      slug: 'unknown-shortener-post',
      firstPost:
        '<strong>Some Film (2026) Hindi WEB-DL - 1080p:</strong><br><a href="https://shrinkme.click/abc">DOWNLOAD</a>',
    });
    const http = new FakeHttp(() => ({ status: 200, body: html, url }));
    const ctx = ctxWith(http);
    enqueueTopic(url, 64);

    await drainQueue(ctx, { max: 5, nowMs: () => 0 });

    expect(db.select().from(topics).get()?.status).toBe('external');
    const stored = db.select().from(links).all();
    expect(stored.some((link) => link.kind === 'download')).toBe(true);
  });
});
