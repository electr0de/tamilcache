import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { crawlTasks, forums, links, sources, topics, variants } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';
import { recheckDead, reclassifyLinks, reclassifyStatuses } from '../src/reclassify.js';

const BASE = 'https://www.1tamilmv.io';
let db: Db;

function seedTopic(status: 'no_magnet' | 'parsed' | 'external', kinds: string[]): number {
  const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: forum!.id,
      sourceTopicId: 100 + Math.floor(Math.random() * 1000),
      slug: 'x',
      rawTitle: 'x',
      kind: 'movie',
      status,
    })
    .returning()
    .get();
  for (const kind of kinds) {
    db.insert(links).values({ topicId: topic.id, url: `https://host/${kind}`, kind: kind as never, label: kind }).run();
  }
  return topic.id;
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: BASE, label: 'x' }).run();
  db.insert(forums)
    .values({ sourceId: 1, sourceForumId: 64, name: 'Hindi dubbed', slug: 'hindi-dubbed-movies', inScope: true })
    .run();
});

describe('reclassifyStatuses', () => {
  it('splits legacy no_magnet rows into external and no_link', () => {
    const external = seedTopic('no_magnet', ['shortener']);
    const chromeOnly = seedTopic('no_magnet', ['spam']);

    const summary = reclassifyStatuses(db);

    expect(summary).toEqual({ external: 1, no_link: 1, below_floor: 0 });
    expect(db.select().from(topics).where(eq(topics.id, external)).get()?.status).toBe('external');
    expect(db.select().from(topics).where(eq(topics.id, chromeOnly)).get()?.status).toBe('no_link');
  });

  it('re-derives a row that was classified external on the strength of chrome alone', () => {
    const topicId = seedTopic('external', ['stream']);
    db.update(links).set({ kind: 'spam' as never }).where(eq(links.topicId, topicId)).run();

    reclassifyStatuses(db);

    expect(db.select().from(topics).where(eq(topics.id, topicId)).get()?.status).toBe('no_link');
  });

  it('does not turn a parsed row with a variant into external on the strength of a link', () => {
    // The parsed row needs a variant now that "parsed with none" means below_floor.
    const parsed = seedTopic('parsed', ['shortener']);
    db.insert(variants)
      .values({ topicId: parsed, resolution: '1080p', sourceTagRaw: 'WEB-DL', sourceTag: 'WEB-DL', sizeBytes: 1, infohash: 'b'.repeat(40) })
      .run();

    reclassifyStatuses(db);

    expect(db.select().from(topics).where(eq(topics.id, parsed)).get()?.status).toBe('parsed');
  });
});

describe('recheckDead', () => {
  function seedDead(url: string): void {
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    db.insert(crawlTasks)
      .values({ url, kind: 'topic', priority: 1, state: 'error', attempts: 5, payload: JSON.stringify({ forumId: forum!.id }) })
      .run();
  }

  it('marks a topic gone when the page is still 404', async () => {
    const url = `${BASE}/index.php?/forums/topic/200381-jailer-2-deleted/`;
    seedDead(url);

    const summary = await recheckDead(db, { get: async () => ({ status: 404, body: '', url }) });

    expect(summary.gone).toBe(1);
    expect(db.select().from(topics).where(eq(topics.sourceTopicId, 200381)).get()?.status).toBe('gone');
    expect(db.select().from(crawlTasks).get()?.state).toBe('done');
  });

  it('re-queues a page that answers 200 so the crawler re-derives its status', async () => {
    const url = `${BASE}/index.php?/forums/topic/200895-celebrity-master-chef/`;
    seedDead(url);

    const summary = await recheckDead(db, { get: async () => ({ status: 200, body: '<html></html>', url }) });

    expect(summary.revived).toBe(1);
    const task = db.select().from(crawlTasks).get();
    expect(task?.state).toBe('pending');
    expect(task?.nextAttemptAt).toBeNull();
  });
});

describe('reclassifyLinks', () => {
  it('re-derives stored link kinds, because the classifier changed after they were written', () => {
    const topicId = seedTopic('no_magnet', []);
    // Rows written before `streamdady` became chrome still say `stream`.
    db.insert(links).values({ topicId, url: 'https://www.streamdady.com/', kind: 'stream' as never, label: 'streamdady.com' }).run();

    const changed = reclassifyLinks(db);

    expect(changed).toBe(1);
    expect(db.select().from(links).get()?.kind).toBe('spam');
    // And the topic is not "external" on the strength of site chrome.
    reclassifyStatuses(db);
    expect(db.select().from(topics).where(eq(topics.id, topicId)).get()?.status).toBe('no_link');
  });

  it('leaves a genuine shortener alone', () => {
    const topicId = seedTopic('no_magnet', []);
    db.insert(links).values({ topicId, url: 'https://gplinks.co/abc', kind: 'shortener' as never, label: 'gplinks.co' }).run();
    expect(reclassifyLinks(db)).toBe(0);
  });
});

describe('parsed rows that have no variants', () => {
  it('relabels them below_floor: the old code left a sub-1080p-only post as parsed', () => {
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    const topic = db
      .insert(topics)
      .values({
        sourceId: 1,
        forumId: forum!.id,
        sourceTopicId: 173309,
        slug: 'arahan-2004-bluray-original-audios-720p',
        rawTitle: 'Arahan (2004) - [720p - x264 - 1GB]',
        kind: 'movie',
        status: 'parsed',
      })
      .returning()
      .get();

    const summary = reclassifyStatuses(db);

    expect(summary.below_floor).toBe(1);
    expect(db.select().from(topics).where(eq(topics.id, topic.id)).get()?.status).toBe('below_floor');
  });

  it('leaves a parsed row that really has a variant alone', () => {
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, 64)).get();
    const topic = db
      .insert(topics)
      .values({ sourceId: 1, forumId: forum!.id, sourceTopicId: 9, slug: 'x', rawTitle: 'X', kind: 'movie', status: 'parsed' })
      .returning()
      .get();
    db.insert(variants)
      .values({ topicId: topic.id, resolution: '1080p', sourceTagRaw: 'WEB-DL', sourceTag: 'WEB-DL', sizeBytes: 1, infohash: 'a'.repeat(40) })
      .run();

    reclassifyStatuses(db);

    expect(db.select().from(topics).where(eq(topics.id, topic.id)).get()?.status).toBe('parsed');
  });
});

describe('reclassifyLinks keeps an unknown shortener actionable', () => {
  it('re-derives an external unknown host as download, not other', () => {
    const topicId = seedTopic('no_magnet', []);
    db.insert(links).values({ topicId, url: 'https://shrinkme.click/abc', kind: 'other' as never, label: 'shrinkme.click' }).run();

    reclassifyLinks(db);

    expect(db.select().from(links).get()?.kind).toBe('download');
  });
});
