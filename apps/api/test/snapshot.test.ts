import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, openDb, SCHEMA_VERSION, type Db } from '@tamilcache/db';
import { exportSnapshot, importSnapshot, parseArgs } from '../src/snapshot.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tamilcache-snap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Required columns only — these tests care about row counts, not about realistic content. */
function seed(path: string, variantCount = 3): void {
  const db = openDb(path);
  db.run(sql`INSERT OR IGNORE INTO sources (base_url, label) VALUES ('https://example.test', 'fixture')`);
  // topics.forum_id is a foreign key: without a forum row the insert fails with a FK error.
  db.run(sql`INSERT OR IGNORE INTO forums (source_id, source_forum_id, name) VALUES (1, 1, 'fixture')`);
  db.run(sql`INSERT OR IGNORE INTO topics (source_id, forum_id, source_topic_id, slug, raw_title, kind)
             VALUES (1, 1, 1, 'fixture', 'Fixture', 'movie')`);
  for (let i = 1; i <= variantCount; i++) {
    db.run(sql`INSERT INTO variants (topic_id, source_tag_raw, source_tag, size_bytes, infohash, decision)
               VALUES (1, 'WEB-DL', 'WEB-DL', 1000, ${String(i).padStart(40, 'a')}, 'hindi_dubbed')`);
  }
  closeDb(db);
}

function variantCount(path: string): number {
  const db = openDb(path);
  const row = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM variants`);
  closeDb(db);
  return Number(row?.n ?? 0);
}

describe('exportSnapshot', () => {
  it('writes a gzipped database that can be imported again', async () => {
    const live = join(dir, 'live.db');
    seed(live);
    const out = join(dir, 'out.db.gz');
    await exportSnapshot(live, out, {});
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
    // gzip magic bytes: a plain .db copied by mistake would start with "SQLite format"
    expect(readFileSync(out).subarray(0, 2).toString('hex')).toBe('1f8b');
  });

  it('scrubs credentials and logs by default', async () => {
    const live = join(dir, 'live.db');
    seed(live);
    const db = openDb(live);
    db.run(sql`INSERT INTO app_state (key, value) VALUES ('torznab_api_key', 'SECRET')`);
    db.run(sql`INSERT INTO log_events (ts, source, level, class, scope, event, message)
               VALUES ('2026-01-01T00:00:00Z', 'api', 'info', 'diag', 'test', 'x', 'y')`);
    closeDb(db);

    const out = join(dir, 'out.db.gz');
    await exportSnapshot(live, out, {});

    const restored = join(dir, 'restored.db');
    await importSnapshot(out, restored, { force: true });
    const check = openDb(restored);
    const key = check.get<{ value: string }>(sql`SELECT value FROM app_state WHERE key = 'torznab_api_key'`);
    const logs = check.get<{ n: number }>(sql`SELECT count(*) AS n FROM log_events`);
    closeDb(check);
    expect(key).toBeUndefined();
    expect(Number(logs?.n)).toBe(0);
  });

  it('keeps secrets when asked to', async () => {
    const live = join(dir, 'live.db');
    seed(live);
    const db = openDb(live);
    db.run(sql`INSERT INTO app_state (key, value) VALUES ('torznab_api_key', 'SECRET')`);
    closeDb(db);

    const out = join(dir, 'out.db.gz');
    await exportSnapshot(live, out, { keepSecrets: true });

    const restored = join(dir, 'restored.db');
    await importSnapshot(out, restored, { force: true });
    const check = openDb(restored);
    const key = check.get<{ value: string }>(sql`SELECT value FROM app_state WHERE key = 'torznab_api_key'`);
    closeDb(check);
    expect(key?.value).toBe('SECRET');
  });

  it('refuses to export a database that does not exist', async () => {
    // openDb() would happily create an empty one, and the export would report success — a 30-byte
    // "backup" of nothing, discovered only when someone tries to restore it.
    await expect(exportSnapshot(join(dir, 'nope.db'), join(dir, 'out.db.gz'), {})).rejects.toThrow(
      /does not exist/,
    );
  });

  it('leaves the live database intact', async () => {
    const live = join(dir, 'live.db');
    seed(live, 4);
    await exportSnapshot(live, join(dir, 'out.db.gz'), {});
    expect(variantCount(live)).toBe(4);
  });
});

describe('importSnapshot', () => {
  it('refuses to overwrite a database that already holds variants', async () => {
    const live = join(dir, 'live.db');
    seed(live);
    const out = join(dir, 'out.db.gz');
    await exportSnapshot(live, out, {});
    await expect(importSnapshot(out, live, {})).rejects.toThrow(/already holds/);
  });

  it('overwrites when forced', async () => {
    const live = join(dir, 'live.db');
    seed(live, 3);
    const other = join(dir, 'other.db');
    seed(other, 1);
    const otherGz = join(dir, 'other.db.gz');
    await exportSnapshot(other, otherGz, {});
    await importSnapshot(otherGz, live, { force: true });
    expect(variantCount(live)).toBe(1);
  });

  it('rejects a database from a newer build', async () => {
    const future = join(dir, 'future.db');
    seed(future, 1);
    const db = openDb(future);
    db.$client.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    closeDb(db);
    const gz = join(dir, 'future.db.gz');
    writeFileSync(gz, gzipSync(readFileSync(future)));
    await expect(importSnapshot(gz, join(dir, 'target.db'), { force: true })).rejects.toThrow(
      /newer than this build/,
    );
  });

  it('removes the previous database\'s WAL sidecars, which would otherwise resurrect old rows', async () => {
    const target = join(dir, 'target.db');
    seed(target, 1);
    // A stale WAL beside a freshly renamed database is applied on next open: the import looks
    // successful and the old contents come back.
    writeFileSync(`${target}-wal`, Buffer.from('stale wal bytes that must never be applied'));
    writeFileSync(`${target}-shm`, Buffer.from('stale shm'));

    const source = join(dir, 'source.db');
    seed(source, 3);
    const gz = join(dir, 'source.db.gz');
    await exportSnapshot(source, gz, {});
    await importSnapshot(gz, target, { force: true });

    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
    expect(variantCount(target)).toBe(3);
  });

  it('imports from an http URL', async () => {
    const live = join(dir, 'live.db');
    seed(live, 2);
    const out = join(dir, 'out.db.gz');
    await exportSnapshot(live, out, {});
    const payload = readFileSync(out);

    // Regression: `fetch` + `Readable.fromWeb` tripped an undici assertion on Node 24 and killed
    // the process mid-restore. The download path must stream over node:http(s) instead.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    try {
      const target = join(dir, 'from-url.db');
      await importSnapshot(`http://127.0.0.1:${port}/snapshot.db.gz`, target, { force: true });
      expect(variantCount(target)).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a file that is not a database', async () => {
    const junk = join(dir, 'junk.db.gz');
    writeFileSync(junk, gzipSync(Buffer.from('not a database at all')));
    await expect(importSnapshot(junk, join(dir, 'target.db'), { force: true })).rejects.toThrow();
  });
});

describe('parseArgs', () => {
  it('treats --flags as flags, not as the source path', () => {
    expect(parseArgs(['export', '--keep-secrets'])).toEqual({
      command: 'export',
      source: undefined,
      keepSecrets: true,
      force: false,
    });
  });

  it('accepts a path before or after the flag', () => {
    expect(parseArgs(['export', '/tmp/out.db.gz', '--keep-secrets']).source).toBe('/tmp/out.db.gz');
    expect(parseArgs(['export', '--keep-secrets', '/tmp/out.db.gz']).source).toBe('/tmp/out.db.gz');
  });

  it('parses import with --force', () => {
    expect(parseArgs(['import', 'https://x/y.db.gz', '--force'])).toEqual({
      command: 'import',
      source: 'https://x/y.db.gz',
      keepSecrets: false,
      force: true,
    });
  });

  it('reports a missing command', () => {
    expect(parseArgs([]).command).toBeUndefined();
  });
});
