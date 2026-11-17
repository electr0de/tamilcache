import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { backfillState, crawlTasks, forums, logEvents, sources, topics } from '@tamilcache/db/schema';
import { auditCoverage, parseBoardIndex } from '../src/coverage-audit.js';
import type { ScopeEntry } from '../src/config.js';

const BASE = 'https://www.1tamilmv.io';

/** The forum index: it lists the language hubs only. */
const INDEX = `
<a href="${BASE}/index.php?/forums/forum/9-tamil-language/">Tamil</a>
<a href="${BASE}/index.php?/forums/forum/56-hindi-language/">Hindi</a>`;

/** A hub page: it lists its sub-boards, each a `data-forumID` row with a link. */
const HUB = `
<div data-forumID="11">
  <a href="${BASE}/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/">WEB-HD / iTunes-HD / BluRay</a>
  <dl><dt class="ipsDataItem_stats_number">10.9k</dt><dd>posts</dd></dl>
</div>
<div data-forumID="15">
  <a href="${BASE}/index.php?/forums/forum/15-mp3-songs/">MP3 Songs</a>
  <dl><dt class="ipsDataItem_stats_number">629</dt><dd>posts</dd></dl>
</div>`;

/** A board page that states its page count. */
const BOARD = `<a href="${BASE}/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/">WEB-HD / iTunes-HD / BluRay</a>${'<li data-rowID="1"><a href="/topic/1-x/">x</a></li>'.repeat(25)}<span>Page 1 of 10</span>`;

class FakeHttp {
  public calls: string[] = [];
  constructor(private readonly routes: Record<string, string>) {}
  async get(url: string) {
    this.calls.push(url);
    const body = this.routes[url];
    if (body === undefined) throw new Error(`no route for ${url}`);
    return { status: 200, body, url };
  }
}

let db: Db;

const scope = new Map<number, ScopeEntry>([
  [9, { id: 9, include: false, reason: 'hub' }],
  [56, { id: 56, include: false, reason: 'hub' }],
  [11, { id: 11, include: true, reason: 'Tamil WEB-HD' }],
  [15, { id: 15, include: false, reason: 'MP3 songs' }],
]);

function seedForum(sourceForumId: number, slug: string, options: { done?: boolean } = {}): number {
  const row = db
    .insert(forums)
    .values({ sourceId: 1, sourceForumId, name: slug, slug, inScope: true })
    .returning()
    .get();
  db.insert(backfillState)
    .values({ forumId: row.id, nextPage: options.done ? 11 : 5, totalPages: 10, done: options.done ?? false })
    .run();
  return row.id;
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: BASE, label: 'x' }).run();
});

describe('parseBoardIndex', () => {
  it('reads every board the page links, with its id and slug', () => {
    expect(parseBoardIndex(HUB)).toEqual([
      { id: 11, slug: 'web-hd-itunes-hd-bluray' },
      { id: 15, slug: 'mp3-songs' },
    ]);
  });
});

describe('board titles and hubs', () => {
  it('carries the display title and the hub a board was found under', async () => {
    seedForum(11, 'web-hd-itunes-hd-bluray', { done: true });
    const http = new FakeHttp({
      [`${BASE}/index.php?/forums/`]: INDEX,
      [`${BASE}/index.php?/forums/forum/9-tamil-language/`]: HUB,
      [`${BASE}/index.php?/forums/forum/56-hindi-language/`]: '',
      [`${BASE}/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/`]: BOARD,
    });

    const report = await auditCoverage(db, scope, http, {
      config: [{ id: 11, slug: 'web-hd-itunes-hd-bluray', language: 'tamil' }],
    });

    // The title is read from the board's own breadcrumb; the section comes from config, because the
    // page a board was *listed on* is unreliable (the index links boards from its widgets too).
    expect(report.boards.find((board) => board.id === 11)).toMatchObject({
      title: 'WEB-HD / iTunes-HD / BluRay',
      hub: { title: 'Tamil' },
    });
  });
});

describe('auditCoverage', () => {
  it('reports a board that is only partly covered and fails the run', async () => {
    const forumId = seedForum(11, 'web-hd-itunes-hd-bluray');
    for (const page of [1, 2, 3, 4]) {
      db.insert(logEvents)
        .values({
          ts: new Date().toISOString(),
          source: 'worker',
          level: 'info',
          class: 'diag',
          scope: 'crawl',
          event: 'backfill.page',
          message: 'x',
          forumId,
          detail: JSON.stringify({ page }),
        })
        .run();
    }
    for (let i = 0; i < 30; i++) {
      db.insert(crawlTasks)
        .values({ url: `${BASE}/topic/${i}-x/`, kind: 'topic', priority: 1, state: 'done', payload: JSON.stringify({ forumId }) })
        .run();
    }
    db.insert(topics)
      .values({ sourceId: 1, forumId, sourceTopicId: 1, slug: 'x', rawTitle: 'x', kind: 'movie', status: 'external' })
      .run();

    const http = new FakeHttp({
      [`${BASE}/index.php?/forums/`]: INDEX,
      [`${BASE}/index.php?/forums/forum/9-tamil-language/`]: HUB,
      [`${BASE}/index.php?/forums/forum/56-hindi-language/`]: '',
      [`${BASE}/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/`]: BOARD,
    });

    const report = await auditCoverage(db, scope, http);

    const board = report.boards.find((entry) => entry.id === 11);
    expect(board).toMatchObject({ scope: 'include', pagesOnSite: 10, pagesCovered: 4 });
    expect(report.problems.join(' ')).toMatch(/board 11: 4 of 10 pages/);
    expect(report.exitCode).toBe(1);
  });

  it('fails when the site serves a board with no scope decision', async () => {
    seedForum(11, 'web-hd-itunes-hd-bluray', { done: true });
    const http = new FakeHttp({
      [`${BASE}/index.php?/forums/`]: INDEX,
      [`${BASE}/index.php?/forums/forum/9-tamil-language/`]: HUB.replace('11-web-hd-itunes-hd-bluray', '77-new-board').replace(
        'data-forumID="11"',
        'data-forumID="77"',
      ),
      [`${BASE}/index.php?/forums/forum/56-hindi-language/`]: '',
      [`${BASE}/index.php?/forums/forum/77-new-board/`]: BOARD,
    });

    const report = await auditCoverage(db, scope, http);

    expect(report.problems.join(' ')).toMatch(/board 77 has no scope decision/);
    expect(report.exitCode).toBe(1);
  });

  it('passes a fully covered board and never fetches an excluded one', async () => {
    const forumId = seedForum(11, 'web-hd-itunes-hd-bluray', { done: true });
    for (let page = 1; page <= 10; page++) {
      db.insert(logEvents)
        .values({
          ts: new Date().toISOString(),
          source: 'worker',
          level: 'info',
          class: 'diag',
          scope: 'crawl',
          event: 'backfill.page',
          message: 'x',
          forumId,
          detail: JSON.stringify({ page }),
        })
        .run();
    }
    for (let i = 0; i < 250; i++) {
      db.insert(crawlTasks)
        .values({ url: `${BASE}/topic/${i}-x/`, kind: 'topic', priority: 1, state: 'done', payload: JSON.stringify({ forumId }) })
        .run();
    }
    const http = new FakeHttp({
      [`${BASE}/index.php?/forums/`]: INDEX,
      [`${BASE}/index.php?/forums/forum/9-tamil-language/`]: HUB,
      [`${BASE}/index.php?/forums/forum/56-hindi-language/`]: '',
      [`${BASE}/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/`]: BOARD,
    });

    const report = await auditCoverage(db, scope, http);

    expect(report.problems).toEqual([]);
    expect(report.exitCode).toBe(0);
    // 10 pages × 25 slots; 250 fetched; the 10-page board is complete.
    expect(report.boards.find((entry) => entry.id === 11)).toMatchObject({ fetched: 250, slots: 250, pagesCovered: 10 });
    // The excluded songs board is never requested.
    expect(http.calls.some((call) => call.includes('15-mp3-songs'))).toBe(false);
  });
});

describe('empty and single-page boards', () => {
  it('does not treat a one-page board as missing topic pages', async () => {
    seedForum(15, 'mp3-songs', { done: true });
    const http = new FakeHttp({
      [`${BASE}/index.php?/forums/`]: INDEX,
      [`${BASE}/index.php?/forums/forum/9-tamil-language/`]: HUB.replace('11-web-hd-itunes-hd-bluray', '15-mp3-songs').replace('data-forumID="11"', 'data-forumID="15"'),
      [`${BASE}/index.php?/forums/forum/56-hindi-language/`]: '',
    });

    const report = await auditCoverage(db, scope, http);

    expect(report.problems.join(' ')).not.toMatch(/board 15: .*topic pages/);
  });
});

describe('page counting', () => {
  it('counts page 1 as covered when the cursor has moved past it, even with no log line', async () => {
    const forumId = seedForum(11, 'web-hd-itunes-hd-bluray', { done: true }); // next_page 11, total 10
    for (let page = 2; page <= 10; page++) {
      db.insert(logEvents)
        .values({
          ts: new Date().toISOString(),
          source: 'worker',
          level: 'info',
          class: 'diag',
          scope: 'crawl',
          event: 'backfill.page',
          message: 'x',
          forumId,
          detail: JSON.stringify({ page }),
        })
        .run();
    }
    const http = new FakeHttp({
      [`${BASE}/index.php?/forums/`]: INDEX,
      [`${BASE}/index.php?/forums/forum/9-tamil-language/`]: HUB,
      [`${BASE}/index.php?/forums/forum/56-hindi-language/`]: '',
      [`${BASE}/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/`]: BOARD,
    });

    const report = await auditCoverage(db, scope, http);

    expect(report.boards.find((board) => board.id === 11)?.pagesCovered).toBe(10);
    expect(report.problems.join(' ')).not.toMatch(/board 11: 9 of 10 pages/);
  });
});
