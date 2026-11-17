import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { backfillState, crawlRuns, forums, logEvents, topics, variants } from '@tamilcache/db/schema';
import type { Logger } from 'pino';
import { seedSourcesAndForums, type ForumConfig } from '../src/config.js';
import type { CrawlContext } from '../src/crawl.js';
import { getState, setState } from '../src/state.js';
import { enqueue } from '../src/queue.js';
import { runTick, type TickDeps } from '../src/tick.js';

const FIXTURES = join(import.meta.dirname, '../../../packages/shared/test/fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const BASE = 'https://www.1tamilmv.io';
const NOW = 1_700_000_000_000;
const CONFIG: ForumConfig[] = [{ id: 64, slug: '64-hindi-dubbed-movies', language: 'hindi' }];

class FakeHttp {
  constructor(private readonly body: string) {}
  async get(url: string) {
    return { status: 200, body: this.body, url };
  }
}

let db: Db;

function deps(http: { get: (url: string) => Promise<{ status: number; body: string; url: string }> } = new FakeHttp(fixture('single-quality.html'))): TickDeps {
  const { sourceId } = seedSourcesAndForums(db, BASE, CONFIG);
  const ctx: CrawlContext = { db, http, baseUrl: BASE, sourceId, config: CONFIG };
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Pick<Logger, 'info' | 'warn' | 'debug' | 'error'>;
  return { ctx, tmdb: null, log, backfillPagesPerTick: 1, state: { deltaFailures: 0, lastPruneAt: 0, lastIdleAt: 0 } };
}

function events() {
  return db.select().from(logEvents).all().map((row) => row.event);
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
});

describe('runTick', () => {
  it('prunes once per hour, not on every tick', async () => {
    const d = deps();
    await runTick(NOW, d);
    expect(events().filter((event) => event === 'prune')).toHaveLength(1);
    await runTick(NOW + 60_000, d);
    expect(events().filter((event) => event === 'prune')).toHaveLength(1);
    await runTick(NOW + 3_600_000, d);
    expect(events().filter((event) => event === 'prune')).toHaveLength(2);
  });

  it('idles while the breaker is open instead of starting a delta', async () => {
    const d = deps();
    setState(db, 'circuit_open_until', String(NOW + 60_000));
    await runTick(NOW, d);
    expect(events()).not.toContain('delta.start');
  });

  it('runs the delta when due and records the run', async () => {
    const d = deps();
    await runTick(NOW, d);
    expect(events()).toEqual(expect.arrayContaining(['delta.start', 'delta.finish']));
    expect(getState(db, 'last_delta_at')).not.toBeNull();
  });

  it('backs off and records the reason when the delta throws', async () => {
    const d = deps({
      get: async () => {
        throw new Error('mirror down');
      },
    });
    await runTick(NOW, d);
    expect(d.state.deltaFailures).toBe(1);
    expect(getState(db, 'delta_retry_at')).not.toBeNull();
    const failed = db.select().from(logEvents).all().find((row) => row.event === 'delta.failed');
    expect(failed?.detail).toContain('mirror down');
  });
});

describe('runTick scheduling and evidence', () => {
  it('runs an overdue delta even though last_delta_at is set', async () => {
    const d = deps();
    setState(db, 'last_delta_at', new Date(NOW - 27 * 3_600_000).toISOString());
    await runTick(NOW, d);
    expect(events()).toContain('delta.start');
  });

  it('does not run a delta that is less than a day old', async () => {
    const d = deps();
    setState(db, 'last_delta_at', new Date(NOW - 20 * 3_600_000).toISOString());
    await runTick(NOW, d);
    expect(events()).not.toContain('delta.start');
  });

  it('records why it is idle, once an hour', async () => {
    const d = deps();
    setState(db, 'last_delta_at', new Date(NOW).toISOString());
    await runTick(NOW, d);
    const idle = () => db.select().from(logEvents).all().filter((row) => row.event === 'idle');
    expect(idle()).toHaveLength(1);
    expect(idle()[0]?.detail).toContain('backfillArmed');
    expect(idle()[0]?.level).toBe('info');
    await runTick(NOW + 60_000, d);
    expect(idle()).toHaveLength(1);
    await runTick(NOW + 3_600_000, d);
    expect(idle()).toHaveLength(2);
  });

  it('leaves a log row when the breaker holds it back', async () => {
    const d = deps();
    setState(db, 'circuit_open_until', String(NOW + 60_000));
    await runTick(NOW, d);
    const row = db.select().from(logEvents).all().find((entry) => entry.event === 'circuit_open');
    expect(row?.scope).toBe('crawl');
    expect(row?.detail).toContain('circuitOpenUntil');
  });

  it('closes the crawl run it opened', async () => {
    const d = deps();
    await runTick(NOW, d);
    const run = db.select().from(crawlRuns).all()[0]!;
    expect(run.finishedAt).not.toBeNull();
  });

  it('records backfill completion once every forum is done', async () => {
    const d = deps();
    setState(db, 'backfill_armed', '1');
    const forum = db.select().from(forums).all()[0]!;
    db.insert(backfillState).values({ forumId: forum.id, nextPage: 2, done: true }).run();
    await runTick(NOW, d);
    expect(getState(db, 'backfill_complete_at')).not.toBeNull();
    await runTick(NOW + 60_000, d);
    expect(events().filter((event) => event === 'backfill.complete')).toHaveLength(1);
  });
});
