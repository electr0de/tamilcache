import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, links, logEvents, sources, topics, variants } from '@tamilcache/db/schema';
import { pruneRetention } from '../src/retention.js';

let db: Db;
let seeded = false;
let counter = 0;

function seedTopic(decision: 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | 'unknown', reviewReason: string | null = null) {
  if (!seeded) {
    db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
    db.insert(forums).values({ sourceId: 1, sourceForumId: 9, name: 'Tamil', inScope: true }).run();
    seeded = true;
  }
  counter += 1;
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: 1,
      sourceTopicId: counter,
      slug: `x-${counter}-tamil-hq`,
      rawTitle: 'X Tamil HQ',
      kind: 'movie',
    })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      sourceTagRaw: 'HQ HDRip',
      sourceTag: 'WEBRip',
      sizeBytes: 1,
      infohash: `${counter}`.padStart(40, '0'),
      decision,
      reviewReason,
    })
    .run();
  db.insert(links).values({ topicId: topic.id, url: `https://gate.test/${counter}`, kind: 'shortener' }).run();
  return topic.id;
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  seeded = false;
  counter = 0;
});

describe('pruneRetention', () => {
  it('keeps Hindi originals, Hindi dubbed and anything still under review', () => {
    seedTopic('hindi_dubbed');
    seedTopic('hindi_original');
    seedTopic('unknown');
    seedTopic('not_hindi', 'NO_AUDIO_TAG');

    const result = pruneRetention(db);

    expect(result).toEqual({ variants: 0, topics: 0 });
    expect(db.select().from(variants).all()).toHaveLength(4);
    expect(db.select().from(topics).all()).toHaveLength(4);
  });

  it('deletes a non-Hindi variant and the topic it leaves empty', () => {
    const doomed = seedTopic('not_hindi');
    const kept = seedTopic('hindi_dubbed');

    const result = pruneRetention(db);

    expect(result).toEqual({ variants: 1, topics: 1 });
    expect(db.select().from(variants).all().map((row) => row.topicId)).toEqual([kept]);
    expect(db.select().from(topics).all().map((row) => row.id)).toEqual([kept]);
    expect(db.select().from(topics).all().some((row) => row.id === doomed)).toBe(false);
    // links cascade with the topic
    expect(db.select().from(links).all()).toHaveLength(1);
  });

  it('keeps a topic that still has one Hindi variant', () => {
    const topicId = seedTopic('not_hindi');
    db.insert(variants)
      .values({
        topicId,
        sourceTagRaw: 'TRUE WEB-DL',
        sourceTag: 'WEB-DL',
        sizeBytes: 2,
        infohash: 'f'.repeat(40),
        decision: 'hindi_dubbed',
      })
      .run();

    expect(pruneRetention(db)).toEqual({ variants: 1, topics: 0 });
    expect(db.select().from(variants).all()).toHaveLength(1);
    expect(db.select().from(topics).all()).toHaveLength(1);
  });

  it('is idempotent and records what it removed', () => {
    seedTopic('not_hindi');
    pruneRetention(db);
    expect(pruneRetention(db)).toEqual({ variants: 0, topics: 0 });
    const rows = db.select().from(logEvents).all().filter((row) => row.event === 'retention');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain('"variants":1');
  });
});
