import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql, type SQL } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/**
 * Bumped whenever `migrate()` gains a step that changes an *existing* volume.
 * `CREATE TABLE IF NOT EXISTS` alone can never upgrade one, so this gate is what stops a
 * newer code build from silently running against an older database (or vice versa).
 */
export const SCHEMA_VERSION = 10;

/** The slice of the drizzle handle the DDL needs; both `Db` and a transaction satisfy it. */
type DdlRunner = Pick<Db, 'run' | 'all'>;

/**
 * Order matters: the busy handler must be installed *before* switching to WAL, otherwise a
 * second container starting against a fresh volume can fail journal_mode with SQLITE_BUSY.
 */
function applyPragmas(sqlite: Database.Database): void {
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
}

function openSqlite(path: string, createParentDir: boolean): Database.Database {
  if (createParentDir && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  applyPragmas(sqlite);
  return sqlite;
}

/**
 * Fails loudly if a column this build needs is absent — the alternative is a runtime
 * `no such column` in the middle of a crawl, hours later.
 */
function assertCurrentSchema(db: Db): void {
  const required: Array<[string, string]> = [
    ['variants', 'is_preferred'],
    ['topics', 'views'],
    ['variants', 'topic_views'],
    ['topics', 'provider_status'],
    ['topics', 'provider_proposal'],
    ['topics', 'provider_checked_at'],
  ];
  for (const [table, column] of required) {
    const columns = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((row) => row.name);
    if (!columns.includes(column)) {
      throw new Error(
        `database is missing ${table}.${column}; it was created by an older build that did not stamp ` +
          'user_version, so automatic migration cannot run. Back up /data and re-crawl, or ALTER it manually.',
      );
    }
  }
  // A view/virtual table cannot be probed with `PRAGMA table_info`, and its absence would only
  // surface as a `no such table` 500 on the first search, so check their existence directly.
  for (const object of ['variants_fts', 'variants_view', 'log_events']) {
    const found = db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name = '${object}'`,
    );
    if (found.length === 0) {
      throw new Error(
        `database is missing ${object}; it was created by an older build that did not stamp ` +
          'user_version, so automatic migration cannot run. Back up /data and re-crawl, or recreate the index manually.',
      );
    }
  }
}

/** Test-only entrypoint: opens a handle without touching `user_version` or the filesystem. */
export function createDb(path: string): Db {
  return drizzle(openSqlite(path, false), { schema });
}

/**
 * Production entrypoint. Creates the parent directory, applies pragmas, migrates on a fresh
 * volume and refuses to run against a database this build does not understand.
 */
export function openDb(path: string): Db {
  const sqlite = openSqlite(path, true);
  const db = drizzle(sqlite, { schema });
  const version = Number(sqlite.pragma('user_version', { simple: true }));

  if (version === 0) {
    try {
      migrate(db);
      // A database created by a build that never stamped `user_version` already has tables, so
      // `CREATE TABLE IF NOT EXISTS` is a no-op and the newest columns would be missing forever.
      assertCurrentSchema(db);
    } catch (err) {
      // A failed open must not leak the handle (and its -wal/-shm): in a container restart
      // loop over a corrupt volume that compounds into fd exhaustion.
      sqlite.close();
      throw err;
    }
  } else if (version > SCHEMA_VERSION) {
    sqlite.close();
    throw new Error(
      `database schema version ${version} is newer than this build (${SCHEMA_VERSION}); refusing to run`,
    );
  } else if (version < SCHEMA_VERSION) {
    // Upgrade ladder: each step brings the file up exactly one version, inside one transaction,
    // and stamps the new version in the same commit. Re-running is a no-op because the version
    // travels with the change.
    try {
      for (let target = version + 1; target <= SCHEMA_VERSION; target++) {
        const step = MIGRATIONS[target];
        if (!step) throw new Error(`no migration step to version ${target}`);
        db.transaction(
          (tx) => {
            step(tx);
            tx.run(sql.raw(`PRAGMA user_version = ${target}`));
          },
          { behavior: 'immediate' },
        );
      }
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }

  return db;
}

export function closeDb(db: Db): void {
  db.$client.close();
}

/**
 * The ONLY DDL authority. `schema.ts` is the typed query layer and must be kept in step by
 * the drift test in `test/schema.test.ts`; the drizzle CLI is not a dependency.
 *
 * Every statement — including the `user_version` stamp — runs inside one IMMEDIATE
 * transaction. `IF NOT EXISTS` alone can never upgrade an existing volume, so the stamp and
 * the DDL must commit together: a crash between them would otherwise leave a complete schema
 * at version 0, which is benign today but re-applies `ALTER TABLE` steps at v2.
 *
 * `behavior: 'immediate'` matters: a DEFERRED transaction that reads then writes fails with
 * SQLITE_BUSY_SNAPSHOT when another connection commits in between, and the busy handler is
 * deliberately not invoked for that case.
 */
export function migrate(db: Db): void {
  db.transaction(
    (tx) => {
      applySchema(tx);
      tx.run(sql.raw(`PRAGMA user_version = ${SCHEMA_VERSION}`));
    },
    { behavior: 'immediate' },
  );
}

/**
 * Version → step. `applySchema` creates version-2 schema from scratch; this ladder exists for
 * databases created by an older build. Keep every step idempotent-safe and small.
 */
/**
 * schema v5: the single observability table. Shared by `applySchema` (fresh volume) and
 * `MIGRATIONS[5]` (existing volume) so the two cannot drift.
 */
function createLogEvents(runner: DdlRunner): void {
  runner.run(sql`CREATE TABLE IF NOT EXISTS log_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL, class TEXT NOT NULL,
    scope TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL, url TEXT,
    task_id INTEGER, run_id INTEGER, forum_id INTEGER, variant_id INTEGER, detail TEXT)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS log_events_ts_idx ON log_events(ts DESC)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS log_events_level_idx ON log_events(level, ts DESC)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS log_events_scope_idx ON log_events(scope, ts DESC)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS log_events_class_idx ON log_events(class, ts DESC)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS log_events_url_idx ON log_events(url)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS log_events_run_idx ON log_events(run_id)`);
}

/**
 * `http_log` shipped with columns and zero writers for two schema versions. Dropping it is the
 * point of v5 — but never blind: a database that somehow gained rows is a database somebody
 * depended on, so refuse and make a human look instead of deleting evidence.
 */
function dropHttpLog(runner: DdlRunner): void {
  const exists = runner.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name = 'http_log'`,
  );
  if (exists.length === 0) return;
  const rows = runner.all<{ count: number }>(sql`SELECT count(*) AS count FROM http_log`);
  const count = rows[0]?.count ?? 0;
  if (count > 0) throw new Error(`http_log contains ${count} rows; refusing to drop it blind`);
  runner.run(sql`DROP TABLE http_log`);
}

/**
 * v8 creates a UNIQUE index on `media(imdb_id)`. A volume that already holds two rows with the
 * same non-null id cannot be upgraded, and the raw SQLite `UNIQUE constraint failed` error is
 * unactionable at 3am. Name the offenders, and say both ways out, before the index is attempted.
 */
function assertNoDuplicateImdbIds(runner: DdlRunner): void {
  const rows = runner.all<{ imdb_id: string; n: number }>(
    'SELECT imdb_id, COUNT(*) AS n FROM media WHERE imdb_id IS NOT NULL GROUP BY imdb_id HAVING n > 1',
  );
  if (rows.length === 0) return;
  const ids = rows.map((row) => `${row.imdb_id} (${row.n}x)`).join(', ');
  throw new Error(
    `schema v8 cannot create the unique media.imdb_id index: duplicate media.imdb_id values: ${ids}. ` +
      'Back up /data, then either null the losing rows or merge them, and restart.',
  );
}

const MIGRATIONS: Record<number, (runner: DdlRunner) => void> = {
  2: (runner) => {
    addColumnIfMissing(runner, 'variants', 'is_preferred', 'INTEGER NOT NULL DEFAULT 0');
  },
  3: (runner) => {
    addColumnIfMissing(runner, 'topics', 'provider_status', "TEXT NOT NULL DEFAULT 'pending'");
    addColumnIfMissing(runner, 'topics', 'provider_proposal', 'TEXT');
    addColumnIfMissing(runner, 'topics', 'provider_checked_at', 'TEXT');
  },
  /**
   * v6: how many distinct places on the page named audio languages. Existing rows read back 0,
   * which `classify()` treats as "one place" when `audio_langs` is non-empty — exactly the
   * pre-v6 semantics, so replaying an old volume changes nothing until the topic is re-crawled.
   */
  6: (runner) => {
    addColumnIfMissing(runner, 'variants', 'audio_source_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(runner, 'variants', 'topic_audio_langs', "TEXT NOT NULL DEFAULT '[]'");
  },
  /**
   * v7: backfill failure accounting. Existing rows read back 0/NULL — healthy and due — which is
   * exactly the pre-v7 behaviour, so an upgraded volume keeps crawling unchanged.
   */
  7: (runner) => {
    addColumnIfMissing(runner, 'backfill_state', 'failures', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(runner, 'backfill_state', 'last_error', 'TEXT');
    addColumnIfMissing(runner, 'backfill_state', 'retry_after', 'TEXT');
  },
  /**
   * v8: who decided `topics.kind`, plus the IMDb identity key manual/media rows are filed under.
   * Additive on purpose — a table rebuild is unsafe here: `PRAGMA foreign_keys=OFF` is a no-op
   * inside the migration's IMMEDIATE transaction, so dropping `media` would cascade.
   */
  8: (runner) => {
    addColumnIfMissing(runner, 'topics', 'kind_source', 'TEXT');
    assertNoDuplicateImdbIds(runner);
    runner.run(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS media_imdb_uq ON media(imdb_id) WHERE imdb_id IS NOT NULL`,
    );
  },
  /**
   * v9: the fields the TMDB detail call already returned and the parser threw away. Additive and
   * nullable on purpose — existing rows read back as NULL/[] until `enrichBatch()` fills them, so
   * an upgraded volume keeps serving a library grid (without ratings) instead of failing to boot.
   */
  /**
   * v10: the listing's view count, used only as a dedupe tie-break at equal quality. Additive and
   * nullable: an upgraded volume reads NULL until the next listing fetch fills it, which changes no
   * decision — `selectPreferredAcrossTitles` treats NULL as 0.
   */
  10: (runner) => {
    addColumnIfMissing(runner, 'topics', 'views', 'INTEGER');
    addColumnIfMissing(runner, 'variants', 'topic_views', 'INTEGER');
  },
  9: (runner) => {
    addColumnIfMissing(runner, 'media', 'genres', "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(runner, 'media', 'vote_average', 'REAL');
    addColumnIfMissing(runner, 'media', 'vote_count', 'INTEGER');
    addColumnIfMissing(runner, 'media', 'runtime', 'INTEGER');
    addColumnIfMissing(runner, 'media', 'backdrop_path', 'TEXT');
    addColumnIfMissing(runner, 'media', 'status', 'TEXT');
  },
  4: createFtsIndex,
  5: (runner) => {
    createLogEvents(runner);
    dropHttpLog(runner);
  },
};

/**
 * FTS5 external-content index over `variants.norm_title` + `topics.raw_title` (schema v4).
 *
 * External content keeps one source of truth (no backfill, no sync job), but it constrains the
 * shape: SQLite reads the indexed values back out of a *table* whose columns are named exactly
 * like the FTS columns, and `raw_title` lives on `topics` — hence the view. Deletes must use the
 * special `'delete'` row form fed with the *old* values, otherwise the index keeps a phantom
 * document; `AFTER UPDATE OF norm_title, topic_id` covers both columns the index stores.
 *
 * Shared by `applySchema` (fresh volume) and `MIGRATIONS[4]` (existing volume) so the two cannot
 * drift. Every statement is `IF NOT EXISTS`, so re-running is harmless.
 */
const FTS_DDL: SQL[] = [
  sql`CREATE VIEW IF NOT EXISTS variants_view AS
    SELECT v.id AS id, v.norm_title AS norm_title, t.raw_title AS raw_title
    FROM variants v JOIN topics t ON t.id = v.topic_id`,
  sql`CREATE VIRTUAL TABLE IF NOT EXISTS variants_fts USING fts5(
    norm_title, raw_title, content='variants_view', content_rowid='id')`,
  sql`CREATE TRIGGER IF NOT EXISTS variants_fts_ai AFTER INSERT ON variants BEGIN
    INSERT INTO variants_fts(rowid, norm_title, raw_title)
    VALUES (new.id, new.norm_title, (SELECT raw_title FROM topics WHERE id = new.topic_id));
  END`,
  sql`CREATE TRIGGER IF NOT EXISTS variants_fts_ad AFTER DELETE ON variants BEGIN
    INSERT INTO variants_fts(variants_fts, rowid, norm_title, raw_title)
    VALUES ('delete', old.id, old.norm_title, (SELECT raw_title FROM topics WHERE id = old.topic_id));
  END`,
  sql`CREATE TRIGGER IF NOT EXISTS variants_fts_au AFTER UPDATE OF norm_title, topic_id ON variants BEGIN
    INSERT INTO variants_fts(variants_fts, rowid, norm_title, raw_title)
    VALUES ('delete', old.id, old.norm_title, (SELECT raw_title FROM topics WHERE id = old.topic_id));
    INSERT INTO variants_fts(rowid, norm_title, raw_title)
    VALUES (new.id, new.norm_title, (SELECT raw_title FROM topics WHERE id = new.topic_id));
  END`,
  // A topic rename changes the indexed `raw_title` for every variant under it. Without this the
  // index keeps the old title (stale matches) and misses the new one.
  sql`CREATE TRIGGER IF NOT EXISTS variants_fts_tt AFTER UPDATE OF raw_title ON topics BEGIN
    INSERT INTO variants_fts(variants_fts, rowid, norm_title, raw_title)
      SELECT 'delete', v.id, v.norm_title, old.raw_title FROM variants v WHERE v.topic_id = new.id;
    INSERT INTO variants_fts(rowid, norm_title, raw_title)
      SELECT v.id, v.norm_title, new.raw_title FROM variants v WHERE v.topic_id = new.id;
  END`,
  // The triggers only see rows changed from now on, so anything already in the table needs an
  // explicit rebuild — a no-op on a fresh volume, and the whole point of the v3 → v4 step.
  sql`INSERT INTO variants_fts(variants_fts) VALUES('rebuild')`,
];

function createFtsIndex(runner: DdlRunner): void {
  for (const statement of FTS_DDL) runner.run(statement);
}

/**
 * `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS`, and a half-applied migration (crash, or a
 * hand-edited database) would otherwise abort the whole ladder on the next boot.
 */
function addColumnIfMissing(runner: DdlRunner, table: string, column: string, definition: string): void {
  const existing = runner.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((row) => row.name);
  if (existing.includes(column)) return;
  runner.run(sql.raw(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`));
}

function applySchema(runner: DdlRunner): void {
  runner.run(sql`CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT, base_url TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown',
    last_ok_at TEXT, fail_count INTEGER NOT NULL DEFAULT 0)`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS forums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    source_forum_id INTEGER NOT NULL, name TEXT NOT NULL, slug TEXT,
    in_scope INTEGER NOT NULL DEFAULT 0, language_hint TEXT, category TEXT,
    CONSTRAINT forums_uq UNIQUE (source_id, source_forum_id))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tmdb_id INTEGER NOT NULL UNIQUE,
    type TEXT NOT NULL, title TEXT NOT NULL, year INTEGER,
    original_language TEXT, imdb_id TEXT, tvdb_id INTEGER, seasons INTEGER,
    poster_path TEXT, overview TEXT, genres TEXT NOT NULL DEFAULT '[]',
    vote_average REAL, vote_count INTEGER, runtime INTEGER,
    backdrop_path TEXT, status TEXT)`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    forum_id INTEGER NOT NULL REFERENCES forums(id),
    source_topic_id INTEGER NOT NULL, slug TEXT NOT NULL, raw_title TEXT NOT NULL,
    poster TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    content_hash TEXT,
    kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', parse_error TEXT,
    provider_status TEXT NOT NULL DEFAULT 'pending', provider_proposal TEXT,
    provider_checked_at TEXT, kind_source TEXT, views INTEGER,
    CONSTRAINT topics_uq UNIQUE (source_id, source_topic_id))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    quality_label TEXT, resolution TEXT,
    source_tag_raw TEXT NOT NULL, source_tag TEXT NOT NULL,
    codec TEXT, audio_codecs TEXT, audio_langs TEXT NOT NULL DEFAULT '[]',
    topic_audio_langs TEXT NOT NULL DEFAULT '[]',
    audio_source_count INTEGER NOT NULL DEFAULT 0, topic_views INTEGER,
    size_bytes INTEGER NOT NULL, infohash TEXT NOT NULL, magnet TEXT,
    torrent_url TEXT, torrent_local_path TEXT, norm_title TEXT,
    media_id INTEGER REFERENCES media(id), season INTEGER,
    ep_from INTEGER, ep_to INTEGER, is_pack INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER, published_at TEXT,
    decision TEXT NOT NULL DEFAULT 'unknown', decision_source TEXT,
    confidence REAL, classifier_version INTEGER NOT NULL DEFAULT 0,
    review_reason TEXT, quality_rank INTEGER NOT NULL DEFAULT 0,
    is_preferred INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT variants_uq UNIQUE (topic_id, infohash))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id INTEGER REFERENCES variants(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    url TEXT NOT NULL, kind TEXT NOT NULL, label TEXT,
    resolved_url TEXT, resolver_status TEXT)`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS media_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    season INTEGER NOT NULL, episode INTEGER NOT NULL, air_date TEXT, name TEXT,
    CONSTRAINT media_episodes_uq UNIQUE (media_id, season, episode))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS metadata_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT, query_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, priority INTEGER NOT NULL DEFAULT 100,
    predicate TEXT NOT NULL, action TEXT NOT NULL, note TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT, evidence_hash TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL, note TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS crawl_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT, payload TEXT, run_id INTEGER)`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS crawl_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at TEXT,
    tasks_total INTEGER NOT NULL DEFAULT 0, tasks_done INTEGER NOT NULL DEFAULT 0,
    tasks_failed INTEGER NOT NULL DEFAULT 0)`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS backfill_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    forum_id INTEGER NOT NULL UNIQUE REFERENCES forums(id),
    next_page INTEGER NOT NULL DEFAULT 1, total_pages INTEGER,
    done INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, retry_after TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  runner.run(sql`CREATE TABLE IF NOT EXISTS app_state (
    key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)`);
  createLogEvents(runner);

  runner.run(sql`CREATE INDEX IF NOT EXISTS topics_forum_idx ON topics(forum_id)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS variants_hash_idx ON variants(infohash)`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS variants_decision_idx ON variants(decision)`);
  runner.run(
    sql`CREATE INDEX IF NOT EXISTS crawl_tasks_pick_idx ON crawl_tasks(state, priority, id)`,
  );
  // persist.ts probes `WHERE topic_id=? AND url=?` once per link on a table that only grows.
  runner.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS links_topic_url_idx ON links(topic_id, url)`,
  );
  // Review queue: `WHERE review_reason IS NOT NULL`.
  runner.run(sql`CREATE INDEX IF NOT EXISTS variants_preferred_idx
    ON variants(is_preferred) WHERE is_preferred = 1`);
  runner.run(sql`CREATE INDEX IF NOT EXISTS variants_review_idx
    ON variants(review_reason) WHERE review_reason IS NOT NULL`);
  // `links.variant_id` cascades on variant delete; without this, deleting one topic scans
  // the whole links table once per variant.
  runner.run(sql`CREATE INDEX IF NOT EXISTS links_variant_idx ON links(variant_id)`);
  // Manual and media rows are keyed by IMDb id; partial so any number of NULLs is allowed.
  runner.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS media_imdb_uq ON media(imdb_id) WHERE imdb_id IS NOT NULL`,
  );
  // Search index last: it depends on `variants` and `topics` existing.
  createFtsIndex(runner);
}
