import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, sources, topics, variants } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';
import { selectPreferredAcrossTitles } from '../src/select.js';

let db: Db;
let seed = 0;

function topic(rawTitle: string, normTitle: string): number {
  seed += 1;
  return db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: 1,
      sourceTopicId: seed,
      slug: `slug-${seed}`,
      rawTitle,
      kind: 'movie',
      status: 'parsed',
    })
    .returning()
    .get().id;
}

function variant(topicId: number, resolution: string, sizeGb: number, views: number | null, hashSeed: string) {
  return db
    .insert(variants)
    .values({
      topicId,
      resolution,
      sourceTagRaw: 'WEB-DL',
      sourceTag: 'WEB-DL',
      sizeBytes: sizeGb * 1024 ** 3,
      infohash: hashSeed.repeat(40).slice(0, 40),
      magnet: `magnet:?xt=urn:btih:${hashSeed.repeat(40).slice(0, 40)}`,
      normTitle: 'some film 2026',
      topicViews: views,
      qualityRank: 1,
    })
    .returning()
    .get().id;
}

function preferred(): number[] {
  return db.select().from(variants).all().filter((row) => row.isPreferred).map((row) => row.id).sort((a, b) => a - b);
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 64, name: 'Hindi', slug: 'hindi', inScope: true }).run();
});

describe('selectPreferredAcrossTitles', () => {
  it('keeps the largest 1080p of one title and the smallest 2160p', () => {
    const a = topic('Some Film (2026) 1080p', 'some film 2026');
    const small = variant(a, '1080p', 4, 10, 'a');
    const large = variant(a, '1080p', 8, 5, 'b');
    const huge = variant(a, '2160p', 20, 1, 'c');
    const tiny4k = variant(a, '2160p', 12, 1, 'd');

    const summary = selectPreferredAcrossTitles(db);

    expect(summary.preferred).toBe(2);
    expect(preferred()).toEqual([large, tiny4k].sort((x, y) => x - y));
    expect([small, huge].some((id) => preferred().includes(id))).toBe(false);
  });

  it('breaks an equal-size tie with the higher view count', () => {
    const a = topic('Some Film (2026) B', 'some film 2026');
    const quiet = variant(a, '1080p', 6, 400, 'e');
    const popular = variant(a, '1080p', 6, 900, 'f');

    selectPreferredAcrossTitles(db);

    expect(preferred()).toEqual([popular]);
    expect(preferred()).not.toContain(quiet);
  });

  it('ranks the same film posted in two boards as one title', () => {
    const first = topic('Some Film (2026) Tamil', 'some film 2026');
    const second = topic('Some Film (2026) Hindi', 'some film 2026');
    const smaller = variant(first, '1080p', 5, 100, 'g');
    const bigger = variant(second, '1080p', 9, 1, 'h');

    selectPreferredAcrossTitles(db);

    expect(preferred()).toEqual([bigger]);
    expect(preferred()).not.toContain(smaller);
  });

  it('never collapses across resolutions', () => {
    const a = topic('Some Film (2026) C', 'some film 2026');
    const hd = variant(a, '1080p', 6, 1, 'i');
    const uhd = variant(a, '2160p', 12, 1, 'j');

    selectPreferredAcrossTitles(db);

    expect(preferred()).toEqual([hd, uhd].sort((x, y) => x - y));
  });

  it('ignores a variant whose infohash is missing, which the feed cannot serve anyway', () => {
    const a = topic('Some Film (2026) D', 'some film 2026');
    const ok = variant(a, '1080p', 6, 1, 'k');
    db.update(variants).set({ infohash: '' }).where(eq(variants.id, variant(a, '1080p', 9, 999, 'l'))).run();

    selectPreferredAcrossTitles(db);

    expect(preferred()).toEqual([ok]);
  });
});

describe('title key', () => {
  it('treats two encodes of the same unmatched film as one title', () => {
    const a = topic('Some Film (2026) Tamil', 'some.film.2026.1080p.web-dl.x264-hindi.5gb-tmv');
    const b = topic('Some Film (2026) Hindi', 'some.film.2026.1080p.web-dl.x265-hindi.8gb-tmv');
    // Same film, same resolution, different encode (different size in the release name).
    const small = variant(a, '1080p', 5, 10, 'm');
    const large = variant(b, '1080p', 8, 2, 'n');

    selectPreferredAcrossTitles(db);

    // One title × one resolution → exactly one preferred row, and it is the larger 1080p encode.
    expect(preferred()).toEqual([large]);
    expect(preferred()).not.toContain(small);
  });

  it('still keeps one row per resolution for that film', () => {
    const a = topic('Some Film (2026) Tamil', 'some.film.2026.1080p.web-dl.x264-hindi.5gb-tmv');
    const hd = variant(a, '1080p', 5, 1, 'o');
    const uhd = variant(a, '2160p', 12, 1, 'p');

    selectPreferredAcrossTitles(db);

    expect(preferred()).toEqual([hd, uhd].sort((x, y) => x - y));
  });
});
