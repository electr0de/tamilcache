import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, sources, topics, variants } from '@tamilcache/db/schema';
import { browse } from '../src/queries.js';

let db: Db;
const HASH = 'a'.repeat(40);

function seedTopic(sourceTopicId: number, decision: 'hindi_dubbed' | 'not_hindi', infohash = HASH) {
  const topic = db
    .insert(topics)
    .values({ sourceId: 1, forumId: 1, sourceTopicId, slug: `t-${sourceTopicId}`, rawTitle: 'Sigma', kind: 'movie' })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      resolution: '1080p',
      sourceTagRaw: 'TRUE WEB-DL',
      sourceTag: 'WEB-DL',
      audioLangs: decision === 'hindi_dubbed' ? ['hindi'] : ['tamil'],
      sizeBytes: 9 * 1024 ** 3,
      infohash,
      normTitle: 'Sigma.2026.1080p.WEB-DL-TMV',
      decision,
      isPreferred: true,
      categoryId: 2040,
    })
    .run();
  return topic.id;
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 1, name: 'f', inScope: true }).run();
});

describe('browse performance', () => {
  it('pages a large index without a correlated per-row subquery', () => {
    db.transaction(() => {
      for (let i = 0; i < 4_000; i += 1) seedTopic(1_000 + i, 'hindi_dubbed', i.toString(16).padStart(40, '0'));
    });

    const started = performance.now();
    const result = browse(db, { limit: 48, offset: 0 });
    const elapsed = performance.now() - started;

    expect(result.rows).toHaveLength(48);
    expect(result.total).toBe(4_000);
    expect(elapsed).toBeLessThan(250);
  });
});

describe('browse dedupe', () => {
  it('collapses one infohash cross-posted across topics', () => {
    seedTopic(1, 'hindi_dubbed');
    seedTopic(2, 'hindi_dubbed');
    seedTopic(3, 'hindi_dubbed');
    const result = browse(db, { limit: 50, offset: 0 });
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('prefers the Hindi row when an infohash appears in two decisions', () => {
    seedTopic(1, 'not_hindi');
    seedTopic(2, 'hindi_dubbed');
    expect(browse(db, { limit: 50, offset: 0 }).rows.map((row) => row.decision)).toEqual(['hindi_dubbed']);
  });
});

describe('browse decision default', () => {
  it('defaults to Hindi only', () => {
    seedTopic(1, 'hindi_dubbed', 'b'.repeat(40));
    seedTopic(2, 'not_hindi', 'c'.repeat(40));
    expect(browse(db, { limit: 50, offset: 0 }).rows).toHaveLength(1);
  });

  it('shows everything with decision=all', () => {
    seedTopic(1, 'hindi_dubbed', 'b'.repeat(40));
    seedTopic(2, 'not_hindi', 'c'.repeat(40));
    expect(browse(db, { limit: 50, offset: 0, decision: 'all' }).rows).toHaveLength(2);
  });

  it('filters to a single decision on request', () => {
    seedTopic(1, 'hindi_dubbed', 'b'.repeat(40));
    seedTopic(2, 'not_hindi', 'c'.repeat(40));
    expect(browse(db, { limit: 50, offset: 0, decision: 'not_hindi' }).rows.map((row) => row.decision)).toEqual([
      'not_hindi',
    ]);
  });
});
