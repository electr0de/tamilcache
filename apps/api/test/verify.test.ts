import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, media, sources, topics, variants } from '@tamilcache/db/schema';
import { runChecks } from '../src/verify.js';

let db: Db;

function seedVariant(overrides: Partial<typeof variants.$inferInsert> = {}) {
  const topic = db
    .insert(topics)
    .values({ sourceId: 1, forumId: 1, sourceTopicId: Math.floor(Math.random() * 1e6), slug: `t-${Math.random()}`, rawTitle: 'T', kind: 'movie' })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      sourceTagRaw: 'HQ HDRip',
      sourceTag: 'WEBRip',
      audioLangs: [],
      sizeBytes: 1,
      infohash: 'a'.repeat(40),
      decision: 'unknown',
      ...overrides,
    })
    .run();
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 64, name: 'Hindi Dubbed', inScope: true }).run();
});

const byName = (name: string) => runChecks(db).find((check) => check.name === name);

describe('verification checks', () => {
  it('fails when a hindi_dubbed variant has no Hindi evidence', () => {
    seedVariant({ decision: 'hindi_dubbed', audioLangs: ['tamil'] });
    expect(byName('hindi_dubbed decisions have evidence')?.pass).toBe(false);
  });

  it('passes when the Hindi audio token backs the decision', () => {
    seedVariant({ decision: 'hindi_dubbed', audioLangs: ['hindi'] });
    expect(byName('hindi_dubbed decisions have evidence')?.pass).toBe(true);
  });

  it('passes when the provider backs a hindi_original decision', () => {
    db.insert(media).values({ tmdbId: 1, type: 'movie', title: 'T', originalLanguage: 'hi' }).run();
    seedVariant({ decision: 'hindi_original', mediaId: 1 });
    expect(byName('hindi_original decisions come from the provider')?.pass).toBe(true);
  });

  it('fails when a hindi_original decision has no provider backing', () => {
    seedVariant({ decision: 'hindi_original' });
    expect(byName('hindi_original decisions come from the provider')?.pass).toBe(false);
  });

  it('fails on a bad infohash', () => {
    seedVariant({ infohash: 'short' });
    expect(byName('every variant has a 40-char infohash')?.pass).toBe(false);
  });

  it('fails when an emitted variant has an unmapped source', () => {
    seedVariant({ decision: 'hindi_dubbed', audioLangs: ['hindi'], sourceTag: 'UNKNOWN' });
    expect(byName('no emitted variant with an unmapped source')?.pass).toBe(false);
  });

  it('passes when the same infohash is cross-posted, because the serialiser collapses it', () => {
    seedVariant({ normTitle: 'X.2025.1080p-TMV', decision: 'hindi_dubbed', audioLangs: ['hindi'], isPreferred: true });
    seedVariant({ normTitle: 'X.2025.1080p-TMV', decision: 'hindi_dubbed', audioLangs: ['hindi'], isPreferred: true });
    const check = byName('duplicate infohashes collapsed at emit');
    expect(check?.pass).toBe(true);
    expect(check?.detail).toContain('1 item(s), 1 unique');
  });

  it('passes on a clean database with one emitted release', () => {
    seedVariant({ decision: 'hindi_dubbed', audioLangs: ['hindi'] });
    const checks = runChecks(db);
    expect(checks.filter((check) => !check.pass)).toEqual([]);
  });
});

describe('provider checks', () => {
  it('fails when a matched topic has variants with no media', () => {
    seedVariant();
    db.update(topics).set({ providerStatus: 'matched' }).run();
    expect(byName('matched topics have media attached to their variants')?.pass).toBe(false);
  });

  it('passes when the media is attached', () => {
    seedVariant();
    db.insert(media).values({ tmdbId: 7, type: 'movie', title: 'T', originalLanguage: 'hi' }).run();
    db.update(topics).set({ providerStatus: 'matched' }).run();
    db.update(variants).set({ mediaId: 1 }).run();
    expect(byName('matched topics have media attached to their variants')?.pass).toBe(true);
  });

  it('reports provider progress without failing the run', () => {
    seedVariant();
    db.update(topics).set({ providerStatus: 'ambiguous', providerCheckedAt: '2026-11-09T00:00:00.000Z' }).run();
    const check = byName('provider pass progress');
    expect(check?.pass).toBe(true);
    expect(check?.detail).toContain('1 ambiguous');
  });

  it('asserts the caps do not advertise tvdbid', () => {
    expect(byName('caps advertises only ids we can resolve')?.pass).toBe(true);
  });
});

describe('search index invariant', () => {
  it('fails when the index is desynchronised from the content table', () => {
    seedVariant({ normTitle: 'Missing.From.Index-TMV' });
    // External-content tables cannot be truncated; removing a row the FTS5 way is the only way
    // to reproduce the desync a broken migration would leave behind.
    db.run(
      `INSERT INTO variants_fts(variants_fts, rowid, norm_title, raw_title)
       VALUES('delete', 1, 'Missing.From.Index-TMV', 'T')`,
    );
    expect(byName('search index matches the variants table')?.pass).toBe(false);
  });

  it('passes when the index matches the table', () => {
    seedVariant({ normTitle: 'Present.In.Index-TMV' });
    expect(byName('search index matches the variants table')?.pass).toBe(true);
  });
});
