import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, createDb, migrate, openDb, SCHEMA_VERSION, type Db } from '../src/client.js';
import { forums, sources, topics, variants } from '../src/schema.js';

const NORM_TITLE = 'Jailer.2.2026.1080p.WEB-DL.Hindi-TMV';
const RAW_TITLE = 'Jailer 2 (2026) Tamil';

/** Minimal graph: source → forum → topic. Returns the topic id. */
function seedInto(db: Db, sourceTopicId = 1): number {
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 1, name: 'f', inScope: true }).run();
  const topic = db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId: 1,
      sourceTopicId,
      slug: 'jailer-2-2026',
      rawTitle: RAW_TITLE,
      kind: 'movie',
    })
    .returning()
    .get();
  return topic.id;
}

function seed(): { db: Db; topicId: number } {
  const db = createDb(':memory:');
  migrate(db);
  return { db, topicId: seedInto(db) };
}

function addVariant(db: Db, topicId: number, normTitle: string): number {
  return db
    .insert(variants)
    .values({
      topicId,
      resolution: '1080p',
      sourceTagRaw: 'X',
      sourceTag: 'WEB-DL',
      audioLangs: ['hindi'],
      sizeBytes: 1,
      // Distinct per call: (topic_id, infohash) is UNIQUE.
      infohash: normTitle.toLowerCase().padEnd(40, '.'),
      normTitle,
    })
    .returning()
    .get().id;
}

/** Rowids the index reports for a prefix query. `term` is a literal in every call site. */
function matchingRowids(db: Db, term: string): number[] {
  return db
    .all<{ id: number }>(`SELECT rowid AS id FROM variants_fts WHERE variants_fts MATCH '"${term}"*'`)
    .map((row) => row.id)
    .sort((a, b) => a - b);
}

describe('variants_fts', () => {
  it('indexes a variant on insert', () => {
    const { db, topicId } = seed();
    addVariant(db, topicId, NORM_TITLE);
    expect(matchingRowids(db, 'jailer')).toHaveLength(1);
  });

  it('indexes the topic raw_title too (matching either column)', () => {
    const { db, topicId } = seed();
    addVariant(db, topicId, NORM_TITLE);
    // 'tamil' appears only in topics.raw_title, never in norm_title.
    expect(matchingRowids(db, 'tamil')).toHaveLength(1);
  });

  it('removes a variant from the index on delete', () => {
    const { db, topicId } = seed();
    const id = addVariant(db, topicId, NORM_TITLE);
    db.delete(variants).where(eq(variants.id, id)).run();
    expect(matchingRowids(db, 'jailer')).toHaveLength(0);
  });

  it('follows a norm_title update', () => {
    const { db, topicId } = seed();
    const id = addVariant(db, topicId, 'Old.Name-TMV');
    db.update(variants).set({ normTitle: 'Kara.2026.1080p-TMV' }).where(eq(variants.id, id)).run();
    expect(matchingRowids(db, 'old')).toHaveLength(0);
    expect(matchingRowids(db, 'kara')).toEqual([id]);
  });

  it('drops the index entry when a topic delete cascades to its variants', () => {
    const { db, topicId } = seed();
    addVariant(db, topicId, NORM_TITLE);
    db.delete(topics).where(eq(topics.id, topicId)).run();
    expect(matchingRowids(db, 'jailer')).toHaveLength(0);
    // The external-content table must still agree with its content table.
    expect(() => db.run(`INSERT INTO variants_fts(variants_fts) VALUES('integrity-check')`)).not.toThrow();
  });

  it('reports the schema version', () => {
    const { db } = seed();
    expect(db.get<{ user_version: number }>('PRAGMA user_version')).toEqual({
      user_version: SCHEMA_VERSION,
    });
  });
});

describe('migration ladder v3 → v4', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('creates the index and populates it for variants that already existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamilcache-fts-'));
    dirs.push(dir);
    const file = join(dir, 'v3.db');

    const legacy = createDb(file);
    migrate(legacy);
    // Simulate a v3 database: everything the current schema has, minus every FTS object.
    for (const trigger of ['variants_fts_ai', 'variants_fts_ad', 'variants_fts_au']) {
      legacy.$client.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    legacy.$client.exec('DROP VIEW IF EXISTS variants_view');
    legacy.$client.exec('DROP TABLE IF EXISTS variants_fts');
    // Inserted while the triggers are gone, so only the migration's rebuild can index it.
    const topicId = seedInto(legacy);
    addVariant(legacy, topicId, NORM_TITLE);
    legacy.$client.pragma('user_version = 3');
    closeDb(legacy);

    const upgraded = openDb(file);
    try {
      expect(upgraded.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(matchingRowids(upgraded, 'jailer')).toEqual([1]);
      expect(matchingRowids(upgraded, 'tamil')).toEqual([1]);
      // Triggers must be live on the upgraded file, not just on fresh databases.
      addVariant(upgraded, topicId, 'Kara.2026.720p-TMV');
      expect(matchingRowids(upgraded, 'kara')).toHaveLength(1);
    } finally {
      closeDb(upgraded);
    }
  });
});

describe('topic rename keeps the index truthful', () => {
  it('reindexes every variant when topics.raw_title changes', () => {
    const db = createDb(':memory:');
    migrate(db);
    const topicId = seedInto(db);
    db.insert(variants)
      .values({
        topicId,
        resolution: '1080p',
        sourceTagRaw: 'X',
        sourceTag: 'WEB-DL',
        audioLangs: ['hindi'],
        sizeBytes: 1,
        infohash: 'a'.repeat(40),
        normTitle: NORM_TITLE,
      })
      .run();

    expect(db.all(`SELECT rowid FROM variants_fts WHERE variants_fts MATCH '"tamil"'`)).toHaveLength(1);

    db.update(topics).set({ rawTitle: 'Jailer 2 (2026) Telugu' }).where(eq(topics.id, topicId)).run();

    expect(db.all(`SELECT rowid FROM variants_fts WHERE variants_fts MATCH '"tamil"'`)).toHaveLength(0);
    expect(db.all(`SELECT rowid FROM variants_fts WHERE variants_fts MATCH '"telugu"'`)).toHaveLength(1);
    // The index must still be internally consistent after a delete+insert pair per row.
    expect(() => db.run(`INSERT INTO variants_fts(variants_fts) VALUES('integrity-check')`)).not.toThrow();
  });
});
