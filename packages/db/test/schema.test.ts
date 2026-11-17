import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { isTable } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { closeDb, createDb, migrate, openDb, SCHEMA_VERSION, type Db } from '../src/client.js';
import { safeJsonArray } from '../src/json.js';
import * as schema from '../src/schema.js';
import {
  crawlTasks,
  forums,
  links,
  media,
  mediaEpisodes,
  metadataCache,
  overrides,
  sources,
  topics,
  variants,
} from '../src/schema.js';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  // createDb() enables `foreign_keys = ON`, so topics.source_id/forum_id need real parents.
  const source = db
    .insert(sources)
    .values({ baseUrl: 'https://example.test', label: 'test' })
    .returning()
    .get();
  db.insert(forums)
    .values({ sourceId: source.id, sourceForumId: 1, name: 'Movies' })
    .run();
});

function makeTopic(sourceTopicId: number, forumId = 1) {
  return db
    .insert(topics)
    .values({
      sourceId: 1,
      forumId,
      sourceTopicId,
      slug: 'a',
      rawTitle: 'A',
      kind: 'movie' as const,
    })
    .returning()
    .get();
}

describe('schema invariants', () => {
  it('rejects duplicate (source_id, source_topic_id)', () => {
    const row = {
      sourceId: 1,
      forumId: 1,
      sourceTopicId: 100,
      slug: 'a',
      rawTitle: 'A',
      kind: 'movie' as const,
    };
    db.insert(topics).values(row).run();
    expect(() => db.insert(topics).values({ ...row, slug: 'b' }).run()).toThrow(/UNIQUE/);
  });

  it('rejects duplicate (topic_id, infohash)', () => {
    const t = makeTopic(101);
    const v = {
      topicId: t.id,
      resolution: '720p',
      sourceTagRaw: 'HQ HDTS',
      sourceTag: 'HDTS',
      audioLangs: ['hindi'],
      sizeBytes: 734003200,
      infohash: 'abc',
      decision: 'unknown' as const,
    };
    db.insert(variants).values(v).run();
    expect(() => db.insert(variants).values(v).run()).toThrow(/UNIQUE/);
  });

  it('defaults decision to unknown and classifier_version to 0', () => {
    const t = makeTopic(102);
    const v = db
      .insert(variants)
      .values({
        topicId: t.id,
        resolution: '1080p',
        sourceTagRaw: 'X',
        sourceTag: 'X',
        audioLangs: [],
        sizeBytes: 1,
        infohash: 'def',
      })
      .returning()
      .get();
    expect(v.decision).toBe('unknown');
    expect(v.classifierVersion).toBe(0);
    expect(v.reviewReason).toBeNull();
    expect(v.audioLangs).toEqual([]);
  });

  it('keeps audio_langs JSON-mode over the raw TEXT DEFAULT \'[]\'', () => {
    const t = makeTopic(107);
    // Omitted: the DB default must decode as `[]`, not `['[]']` or `null`.
    const v = db
      .insert(variants)
      .values({ topicId: t.id, sourceTagRaw: 'X', sourceTag: 'X', sizeBytes: 1, infohash: 'ghi' })
      .returning()
      .get();
    expect(v.audioLangs).toEqual([]);
    expect(db.all<{ dflt_value: string | null }>('SELECT dflt_value FROM pragma_table_info(\'variants\') WHERE name = \'audio_langs\'')[0]?.dflt_value).toBe("'[]'");
    const dv = db
      .insert(variants)
      .values({
        topicId: t.id,
        sourceTagRaw: 'X',
        sourceTag: 'X',
        audioLangs: ['hindi', 'tamil'],
        sizeBytes: 1,
        infohash: 'jkl',
      })
      .returning()
      .get();
    expect(dv.audioLangs).toEqual(['hindi', 'tamil']);
  });

  it('rejects duplicate media_episodes (media_id, season, episode)', () => {
    const m = db
      .insert(media)
      .values({ tmdbId: 603, type: 'movie', title: 'The Matrix' })
      .returning()
      .get();
    const ep = { mediaId: m.id, season: 1, episode: 1 };
    db.insert(mediaEpisodes).values(ep).run();
    expect(() => db.insert(mediaEpisodes).values(ep).run()).toThrow(/UNIQUE/);
  });

  it('rejects duplicate metadata_cache.query_key', () => {
    const row = { queryKey: 'movie:603', payload: '{}' };
    db.insert(metadataCache).values(row).run();
    expect(() => db.insert(metadataCache).values(row).run()).toThrow(/UNIQUE/);
  });

  it('rejects duplicate overrides.evidence_hash', () => {
    const row = { evidenceHash: 'deadbeef', action: 'hindi_dubbed' as const };
    db.insert(overrides).values(row).run();
    expect(() => db.insert(overrides).values({ ...row, action: 'not_hindi' }).run()).toThrow(
      /UNIQUE/,
    );
  });

  it('rejects duplicate crawl_tasks.url', () => {
    const row = { url: 'https://example.test/t/1', kind: 'topic' as const };
    db.insert(crawlTasks).values(row).run();
    expect(() => db.insert(crawlTasks).values({ ...row, kind: 'listing' }).run()).toThrow(/UNIQUE/);
  });

  it('rejects duplicate links (topic_id, url)', () => {
    const t = makeTopic(103);
    const row = { topicId: t.id, url: 'https://example.test/l/1', kind: 'stream' as const };
    db.insert(links).values(row).run();
    expect(() => db.insert(links).values(row).run()).toThrow(/UNIQUE/);
  });

  it('is idempotent: migrate() twice on a fresh database does not throw', () => {
    const fresh = createDb(':memory:');
    expect(() => {
      migrate(fresh);
      migrate(fresh);
    }).not.toThrow();
  });

  it('enforces foreign keys (unknown forum_id is rejected)', () => {
    expect(() => makeTopic(104, 999)).toThrow(/FOREIGN KEY/);
  });

  it('records who decided the kind', () => {
    const topic = makeTopic(9);
    expect(topic.kindSource).toBeDefined();
  });

  it('carries the tmdb enrichment columns and defaults genres to an empty array', () => {
    const columns = (db.$client.pragma('table_info(media)') as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining(['genres', 'vote_average', 'vote_count', 'runtime', 'backdrop_path', 'status']),
    );
    const row = db.insert(media).values({ tmdbId: 42, type: 'movie', title: 'A' }).returning().get();
    expect(row.genres).toEqual([]);
    expect(row.voteAverage).toBeNull();
  });

  it('allows one media row per imdb id but any number of nulls', () => {
    db.insert(media).values({ tmdbId: 1, type: 'movie', title: 'A', imdbId: 'tt1' }).run();
    expect(() =>
      db.insert(media).values({ tmdbId: 2, type: 'movie', title: 'B', imdbId: 'tt1' }).run(),
    ).toThrow();
    expect(() =>
      db.insert(media).values({ tmdbId: 3, type: 'movie', title: 'C', imdbId: null }).run(),
    ).not.toThrow();
    expect(() =>
      db.insert(media).values({ tmdbId: 4, type: 'movie', title: 'D', imdbId: null }).run(),
    ).not.toThrow();
  });
});

describe('schema.ts ↔ migrate() drift', () => {
  type ColumnInfo = { name: string };
  type IndexList = { name: string };
  type IndexInfo = { name: string | null };
  /** Runtime-only flags on a column's config; not all are part of drizzle's public types. */
  type ColumnFlags = { isUnique?: boolean; primaryKey?: boolean; dataType?: string };

  const tables: SQLiteTable[] = Object.values(schema)
    .filter(isTable)
    .map((t) => t as SQLiteTable);

  function pragmaColumnNames(tableName: string): string[] {
    return db
      .all<ColumnInfo>(`PRAGMA table_info("${tableName}")`)
      .map((c) => c.name)
      .sort();
  }

  /**
   * Column-set signature of every index SQLite built for the table, including the
   * `sqlite_autoindex_*` artefacts of inline UNIQUE / non-rowid PRIMARY KEY clauses.
   * Only the column sets are compared (never index names), so an inline `UNIQUE(a, b)` and
   * a `CREATE UNIQUE INDEX foo ON t(a, b)` compare equal.
   */
  function pragmaIndexSets(tableName: string): string[] {
    const sets = db.all<IndexList>(`PRAGMA index_list("${tableName}")`).map((idx) =>
      db
        .all<IndexInfo>(`PRAGMA index_info("${idx.name}")`)
        .map((c) => c.name)
        .filter((name): name is string => name !== null)
        .sort()
        .join(','),
    );
    return [...new Set(sets)].sort();
  }

  function drizzleIndexSets(table: SQLiteTable): string[] {
    const config = getTableConfig(table);
    const sets = config.indexes.map((idx) =>
      idx.config.columns
        .map((c) => ('name' in c ? c.name : '<expression>'))
        .sort()
        .join(','),
    );
    // `getTableConfig()` only reports index-builder output; column-level `.unique()` and
    // `.primaryKey()` are invisible there (only the drizzle CLI reads them, off the column).
    for (const column of config.columns) {
      // `config` is `protected` on `Column`, so it needs a structural cast to read.
      const flags = (column as unknown as { config: ColumnFlags }).config;
      // `INTEGER PRIMARY KEY` *is* the rowid and gets no index; anything else needs one.
      const rowidAlias = flags.primaryKey === true && flags.dataType === 'number';
      if (flags.isUnique === true || (flags.primaryKey === true && !rowidAlias)) {
        sets.push(column.name);
      }
    }
    sets.push(
      ...config.uniqueConstraints.map((u) =>
        u.columns
          .map((c) => c.name)
          .sort()
          .join(','),
      ),
    );
    return [...new Set(sets)].sort();
  }

  /**
   * Names of the *real* tables `migrate()` creates. This test walks `schema.ts` exports, and the
   * database now also contains objects `schema.ts` deliberately does not model:
   *
   * - `type = 'table'` drops `variants_view`, a plain view (it only exists because an
   *   external-content FTS5 table must read its columns back out of a same-named table).
   * - `variants_fts%` drops the FTS5 virtual table *and* its shadow tables (`variants_fts_data`,
   *   `_idx`, `_content`, `_docsize`, `_config`). A virtual table's `PRAGMA table_info` reports
   *   every column as untyped, so the type/affinity assertions below cannot hold for it, and its
   *   shadow tables are an FTS5 implementation detail, not part of the typed layer.
   * - `sqlite_%` drops `sqlite_sequence`, which `AUTOINCREMENT` creates.
   *
   * The FTS5 objects are covered by `test/fts.test.ts` instead.
   */
  function migrateTableNames(): string[] {
    return db
      .all<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'variants\\_fts%' ESCAPE '\\'
            AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          ORDER BY name`,
      )
      .map((row) => row.name);
  }

  it('exports every table from schema.ts', () => {
    expect(tables).toHaveLength(15);
  });

  it('declares every table migrate() creates in schema.ts', () => {
    expect(migrateTableNames()).toEqual(tables.map((t) => getTableConfig(t).name).sort());
  });

  it('has identical column names in schema.ts and migrate()', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(
        config.columns.map((c) => c.name).sort(),
        `columns of ${config.name} diverge between schema.ts and migrate()`,
      ).toEqual(pragmaColumnNames(config.name));
    }
  });

  it('has identical index column sets in schema.ts and migrate()', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(
        drizzleIndexSets(table),
        `indexes of ${config.name} diverge between schema.ts and migrate()`,
      ).toEqual(pragmaIndexSets(config.name));
    }
  });

  type ColumnTypeInfo = { name: string; type: string; notnull: number };

  /** SQLite column affinity for a drizzle column type. */
  function affinity(columnType: string): string {
    if (columnType === 'SQLiteReal' || columnType === 'SQLiteNumeric') return 'REAL';
    if (columnType.startsWith('SQLiteText')) return 'TEXT';
    if (columnType === 'SQLiteBlob') return 'BLOB';
    // SQLiteInteger, SQLiteBoolean, SQLiteTimestamp (stored as text but declared INTEGER by us)
    return columnType === 'SQLiteTimestamp' ? 'TEXT' : 'INTEGER';
  }

  it('has identical column types and NOT NULL flags in schema.ts and migrate()', () => {
    // A drifted type is not cosmetic: a TEXT-affinity `size_bytes` silently coerces
    // 734003200 to '734003200' and every size/quality comparison downstream breaks.
    for (const table of tables) {
      const config = getTableConfig(table);
      const actual = new Map(
        db
          .all<ColumnTypeInfo>(`PRAGMA table_info("${config.name}")`)
          .map((c) => [c.name, c] as const),
      );
      for (const column of config.columns) {
        const row = actual.get(column.name);
        expect(row, `${config.name}.${column.name} missing from migrate()`).toBeDefined();
        if (!row) continue;
        expect(
          row.type.toUpperCase(),
          `${config.name}.${column.name} type diverges (${row.type} vs ${affinity(column.columnType)})`,
        ).toBe(affinity(column.columnType));
        // `INTEGER PRIMARY KEY` reports notnull=0 in sqlite even though it can never be NULL.
        if (!column.primary) {
          expect(
            row.notnull,
            `${config.name}.${column.name} NOT NULL diverges between schema.ts and migrate()`,
          ).toBe(column.notNull ? 1 : 0);
        }
      }
    }
  });

  it('keeps variants_review_idx partial in migrate()', () => {
    type IndexList = { name: string; partial: number };
    const idx = db
      .all<IndexList>('PRAGMA index_list("variants")')
      .find((i) => i.name === 'variants_review_idx');
    expect(idx, 'variants_review_idx missing from migrate()').toBeDefined();
    expect(idx?.partial, 'dropping the WHERE clause makes it index 100k NULL rows').toBe(1);
  });
});

describe('migrate() version stamp', () => {
  it('stamps user_version inside the same transaction as the DDL', () => {
    const fresh = createDb(':memory:');
    expect(fresh.$client.pragma('user_version', { simple: true })).toBe(0);
    migrate(fresh);
    expect(fresh.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});

describe('timestamps', () => {
  it('defaults to ISO-8601 with milliseconds', () => {
    const t = makeTopic(105);
    expect(t.firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(t.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Sorts after a `CURRENT_TIMESTAMP`-style value, which is the whole point.
    expect('2026-11-09 18:00:00' < t.firstSeenAt).toBe(true);
  });
});

describe('openDb', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function tempFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'tamilcache-db-'));
    dirs.push(dir);
    return join(dir, 'nested', name);
  }

  it('creates the parent directory, applies pragmas and stamps the schema version', () => {
    const file = tempFile('test.db');
    const fileDb = openDb(file);
    try {
      expect(fileDb.$client.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(fileDb.$client.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(fileDb.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(fileDb.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const columnNames = fileDb
        .all<{ name: string }>('PRAGMA table_info("topics")')
        .map((c) => c.name);
      expect(columnNames).toContain('first_seen_at');
    } finally {
      closeDb(fileDb);
    }
  });

  it('reopens an existing database without re-running the migration', () => {
    const file = tempFile('reopen.db');
    closeDb(openDb(file));
    const reopened = openDb(file);
    expect(reopened.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    closeDb(reopened);
  });

  it('refuses a database whose schema version is newer than this build', () => {
    const file = tempFile('future.db');
    const fileDb = openDb(file);
    fileDb.$client.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    closeDb(fileDb);
    expect(() => openDb(file)).toThrow(/newer than this build/);
  });
});

describe('safeJsonArray', () => {
  it('passes through arrays of strings and drops non-strings', () => {
    expect(safeJsonArray(['hindi', 'tamil'])).toEqual(['hindi', 'tamil']);
    expect(safeJsonArray(['hindi', 7, null])).toEqual(['hindi']);
  });

  it('parses JSON arrays stored as text', () => {
    expect(safeJsonArray('["hindi"]')).toEqual(['hindi']);
    expect(safeJsonArray('[]')).toEqual([]);
  });

  it('returns [] for corrupt, non-array or non-string values instead of throwing', () => {
    expect(safeJsonArray('not json')).toEqual([]);
    expect(safeJsonArray('{"a":1}')).toEqual([]);
    expect(safeJsonArray(null)).toEqual([]);
    expect(safeJsonArray(undefined)).toEqual([]);
    expect(safeJsonArray(42)).toEqual([]);
  });
});

describe('migration ladder', () => {
  it('upgrades a version-1 database to the current schema in one step', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tamilcache-migrate-')), 'v1.db');
    // Build a version-1 database by hand: current schema minus the v2 column.
    const legacy = createDb(file);
    migrate(legacy);
    legacy.$client.pragma('user_version = 1');
    // Drop the index first, then the column — exactly the reverse of the v2 step.
    legacy.$client.exec('DROP INDEX IF EXISTS variants_preferred_idx');
    legacy.$client.exec('ALTER TABLE variants DROP COLUMN is_preferred');
    closeDb(legacy);

    const upgraded = openDb(file);
    try {
      expect(upgraded.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const columns = upgraded.all<{ name: string }>('PRAGMA table_info("variants")').map((c) => c.name);
      expect(columns).toContain('is_preferred');
    } finally {
      closeDb(upgraded);
    }
  });
});

describe('migration ladder v2 → v3', () => {
  it('adds the provider columns to a version-2 database', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tamilcache-migrate3-')), 'v2.db');
    const legacy = createDb(file);
    migrate(legacy);
    // Simulate a v2 database: current schema minus the provider columns.
    legacy.$client.pragma('user_version = 2');
    for (const column of ['provider_status', 'provider_proposal', 'provider_checked_at']) {
      legacy.$client.exec(`ALTER TABLE topics DROP COLUMN ${column}`);
    }
    closeDb(legacy);

    const upgraded = openDb(file);
    try {
      expect(upgraded.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const columns = upgraded.all<{ name: string }>('PRAGMA table_info("topics")').map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['provider_status', 'provider_proposal', 'provider_checked_at']));
    } finally {
      closeDb(upgraded);
    }
  });
});

describe('migration ladder v4 → v5', () => {
  it('creates log_events and drops the empty http_log', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tamilcache-migrate5-')), 'v4.db');
    const legacy = createDb(file);
    migrate(legacy);
    // Emulate the v4 world: current build ships log_events, v4 shipped the unwired http_log.
    legacy.$client.exec('DROP TABLE log_events');
    legacy.$client.exec(
      'CREATE TABLE http_log (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, status INTEGER, ms INTEGER, mirror TEXT, run_id INTEGER, error TEXT, created_at TEXT NOT NULL)',
    );
    legacy.$client.pragma('user_version = 4');
    closeDb(legacy);

    const upgraded = openDb(file);
    try {
      expect(upgraded.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const names = upgraded
        .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)
        .map((row) => row.name);
      expect(names).toContain('log_events');
      expect(names).not.toContain('http_log');
    } finally {
      closeDb(upgraded);
    }
  });

  it('refuses to drop http_log when it unexpectedly has rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tamilcache-migrate5b-')), 'v4.db');
    const legacy = createDb(file);
    migrate(legacy);
    legacy.$client.exec('DROP TABLE log_events');
    legacy.$client.exec('CREATE TABLE http_log (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL)');
    legacy.$client.exec("INSERT INTO http_log (url) VALUES ('https://example.invalid/x')");
    legacy.$client.pragma('user_version = 4');
    closeDb(legacy);

    expect(() => openDb(file)).toThrow(/http_log contains 1 rows/);
  });
});

describe('migration ladder v5 → v6', () => {
  it('adds audio_source_count to a version-5 database, defaulting to 0', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tamilcache-migrate6-')), 'v5.db');
    const legacy = createDb(file);
    migrate(legacy);
    // Emulate the v5 world: current build ships the column, v5 did not.
    legacy.$client.exec('ALTER TABLE variants DROP COLUMN audio_source_count');
    legacy.$client.pragma('user_version = 5');
    closeDb(legacy);

    const upgraded = openDb(file);
    try {
      expect(upgraded.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const columns = upgraded.all<{ name: string }>('PRAGMA table_info("variants")').map((c) => c.name);
      expect(columns).toContain('audio_source_count');
    } finally {
      closeDb(upgraded);
    }
  });
});

describe('migration ladder v6 → v7', () => {
  it('adds the backfill failure columns to a version-6 database', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tamilcache-migrate7-')), 'v6.db');
    const legacy = createDb(file);
    migrate(legacy);
    // Emulate the v6 world: the current build ships these columns, v6 did not.
    legacy.$client.exec('ALTER TABLE backfill_state DROP COLUMN failures');
    legacy.$client.exec('ALTER TABLE backfill_state DROP COLUMN last_error');
    legacy.$client.exec('ALTER TABLE backfill_state DROP COLUMN retry_after');
    legacy.$client.pragma('user_version = 6');
    closeDb(legacy);

    const upgraded = openDb(file);
    try {
      expect(upgraded.$client.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const columns = upgraded
        .all<{ name: string }>('PRAGMA table_info("backfill_state")')
        .map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(['failures', 'last_error', 'retry_after']));
    } finally {
      closeDb(upgraded);
    }
  });
});

describe('migration v8 imdb uniqueness guard', () => {
  it('names the duplicate imdb ids instead of surfacing a raw SQLite error', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tamilcache-migrate8-')), 'v7.db');
    const legacy = createDb(file);
    migrate(legacy);
    // Emulate the v7 world: no unique imdb index, and two rows that now collide.
    legacy.$client.exec('DROP INDEX IF EXISTS media_imdb_uq');
    legacy.$client.exec("INSERT INTO media (tmdb_id, type, title, imdb_id) VALUES (1, 'movie', 'A', 'tt1')");
    legacy.$client.exec("INSERT INTO media (tmdb_id, type, title, imdb_id) VALUES (2, 'movie', 'B', 'tt1')");
    legacy.$client.pragma('user_version = 7');
    closeDb(legacy);

    // This is the boot path: `openDb` runs the migration ladder, so the guard must fire there
    // rather than in a caller that would have to interpret a raw SQLite error code.
    expect(() => openDb(file)).toThrow(/duplicate media\.imdb_id values: tt1/i);
  });
});
