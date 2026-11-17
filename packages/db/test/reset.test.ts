import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate, openDb, type Db } from '../src/index.js';
import { appState, forums, logEvents, rules, sources, topics, variants } from '../src/schema.js';

const ROOT = join(import.meta.dirname, '../../..');
let dir: string;
let db: Db;

function seed(): string {
  dir = mkdtempSync(join(tmpdir(), 'tamilcache-reset-'));
  const path = join(dir, 'test.db');
  db = openDb(path);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 9, name: 'Tamil', inScope: true }).run();
  const topic = db
    .insert(topics)
    .values({ sourceId: 1, forumId: 1, sourceTopicId: 1, slug: 'x', rawTitle: 'X', kind: 'movie' })
    .returning()
    .get();
  db.insert(variants)
    .values({ topicId: topic.id, sourceTagRaw: 'HQ HDRip', sourceTag: 'WEBRip', sizeBytes: 1, infohash: 'a'.repeat(40) })
    .run();
  db.insert(rules).values({ action: 'hindi_dubbed', predicate: '{}', enabled: true, priority: 1 }).run();
  db.insert(appState).values({ key: 'torznab_api_key', value: 'keep-me' }).run();
  db.insert(appState).values({ key: 'last_delta_at', value: '2026-11-09T00:00:00.000Z' }).run();
  db.$client.close();
  return path;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('db:reset', () => {
  it('clears crawl output and keeps taught data', () => {
    const path = seed();
    execFileSync('node', ['scripts/reset-db.mjs', path, '--yes'], { cwd: ROOT, encoding: 'utf8' });

    db = openDb(path);
    expect(db.select().from(topics).all()).toHaveLength(0);
    expect(db.select().from(variants).all()).toHaveLength(0);
    expect(db.select().from(logEvents).all()).toHaveLength(0);
    // taught + reference data survives
    expect(db.select().from(rules).all()).toHaveLength(1);
    expect(db.select().from(forums).all()).toHaveLength(1);
    expect(db.select().from(sources).all()).toHaveLength(1);
    const state = db.select().from(appState).all();
    expect(state).toHaveLength(1);
    expect(state[0]?.key).toBe('torznab_api_key');
    expect(db.select().from(appState).where(eq(appState.key, 'torznab_api_key')).get()?.value).toBe('keep-me');
    db.$client.close();
  });

  it('refuses to run without --yes', () => {
    const path = seed();
    expect(() => execFileSync('node', ['scripts/reset-db.mjs', path], { cwd: ROOT, stdio: 'pipe' })).toThrow();
  });
});
