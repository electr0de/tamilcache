import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, sources, topics, variants } from '@tamilcache/db/schema';
import { parseTopicPage } from '@tamilcache/shared';
import { persistTopic } from '../src/persist.js';

const FIXTURES = join(import.meta.dirname, '../../../packages/shared/test/fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const BASE = 'https://www.1tamilmv.io';
const EPISODE_URL = `${BASE}/index.php?/forums/topic/193386-it-welcome-to-derry-2025-s01-ep01-true-web-dl-1080p-720p-avc-hindi-eng-dd51-192kbps-13gb-600mb-250mb-esub/`;

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: BASE, label: 'x' }).run();
  db.insert(forums)
    .values({ sourceId: 1, sourceForumId: 64, name: 'Web Series TV Shows', slug: 'web-series-tv-shows', inScope: true })
    .run();
});

const ctx = { sourceId: 1, forumId: 1, forumSlug: 'web-series-tv-shows' };

describe('persistTopic kind', () => {
  it('files an S01E05 episode as a show, in the tv category', () => {
    persistTopic(db, fixture('single-episode.html'), EPISODE_URL, BASE, ctx);

    const topic = db.select().from(topics).get();
    expect(topic?.kind).toBe('show');
    expect(topic?.kindSource).toBe('parse');

    const stored = db.select().from(variants).all();
    expect(stored.length).toBeGreaterThan(0);
    for (const variant of stored) {
      expect(variant.categoryId).toBe(5030);
      expect(variant.season).toBe(1);
    }
  });

  it('does not let a re-crawl undo a provider kind correction', () => {
    persistTopic(db, fixture('single-episode.html'), EPISODE_URL, BASE, ctx);

    // Simulate what the provider pass writes, and force the next persist down the changed-content
    // branch by making the stored hash stale.
    db.update(topics).set({ kind: 'movie', kindSource: 'tmdb', contentHash: 'stale' }).run();

    persistTopic(db, fixture('single-episode.html'), EPISODE_URL, BASE, ctx);

    const after = db.select().from(topics).get();
    expect(after?.kind).toBe('movie');
    expect(after?.kindSource).toBe('tmdb');
    expect(after?.contentHash).not.toBe('stale');
  });
});

describe('persistTopic torrent-only blocks', () => {
  const URL = `${BASE}/index.php?/forums/topic/193386-it-welcome-to-derry-2025-s01-ep01-true-web-dl-1080p-720p-avc-hindi-eng-dd51-192kbps-13gb-600mb-250mb-esub/`;

  /** The only attachment-only block in the daily-show fixture that survives the 1080p floor. */
  function attachmentOnly1080(): string {
    const parsed = parseTopicPage(fixture('daily-show-episodes.html'), BASE);
    const block = parsed.variants.find((variant) => variant.infohash === null && variant.resolution === '1080p');
    expect(block?.torrentUrl).toBeTruthy();
    return block!.torrentUrl!;
  }

  it('writes a torrent-only variant with the hash resolved for its attachment', () => {
    const attachment = attachmentOnly1080();
    const hashes = new Map([[attachment, 'ab'.repeat(20)]]);

    const result = persistTopic(db, fixture('daily-show-episodes.html'), URL, BASE, ctx, { torrentHashes: hashes });

    expect(result.variantsUnresolved).toBe(0);
    const row = db.select().from(variants).all().find((candidate) => candidate.torrentUrl === attachment);
    expect(row?.infohash).toBe('ab'.repeat(20));
    expect(row?.magnet).toBe(`magnet:?xt=urn:btih:${'ab'.repeat(20)}`);
  });

  it('counts a torrent-only block with no resolved hash instead of writing a null infohash', () => {
    const attachment = attachmentOnly1080();

    const result = persistTopic(db, fixture('daily-show-episodes.html'), URL, BASE, ctx);

    expect(result.variantsUnresolved).toBe(1);
    const rows = db.select().from(variants).all();
    expect(rows.some((candidate) => candidate.torrentUrl === attachment)).toBe(false);
    expect(rows.every((candidate) => candidate.infohash.length === 40)).toBe(true);
  });
});

describe('persistTopic keeps a block whose source is unknown', () => {
  it('writes it as UNKNOWN_SOURCE with an unknown decision, so it can be reviewed', () => {
    const html = [
      '<html><head><link rel="canonical" href="https://www.1tamilmv.io/index.php?/forums/topic/210001-unknown-source-film/" /></head><body>',
      '<div data-role="commentContent">',
      '<strong>Unknown Source Film (2026) HQ XYZ-Rip - 1080p - x264 - 6GB :</strong><br>',
      `<a href="magnet:?xt=urn:btih:${'ab'.repeat(20)}">MAGNET</a>`,
      '</div></body></html>',
    ].join('');
    const url = `${BASE}/index.php?/forums/topic/210001-unknown-source-film/`;

    const result = persistTopic(db, html, url, BASE, ctx);

    expect(result.variantsInserted).toBe(1);
    const row = db.select().from(variants).get();
    expect(row?.sourceTag).toBe('UNKNOWN');
    expect(row?.reviewReason).toBe('UNKNOWN_SOURCE');
    expect(row?.decision).toBe('unknown');
  });
});
