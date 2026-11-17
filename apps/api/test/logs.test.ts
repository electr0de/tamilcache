import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { logEvents } from '@tamilcache/db/schema';
import { buildApp } from '../src/server.js';

const KEY = 'k';
let db: Db;

function app() {
  return buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484' });
}

const url = (path: string) => `${path}${path.includes('?') ? '&' : '?'}apikey=${KEY}`;

function seed() {
  const rows = [
    { ts: '2026-11-10T00:00:01.000Z', source: 'worker' as const, level: 'info' as const, class: 'diag' as const, scope: 'crawl', event: 'delta.start', message: 'delta started', url: null, taskId: null, runId: 7 },
    { ts: '2026-11-10T00:00:02.000Z', source: 'worker' as const, level: 'warn' as const, class: 'diag' as const, scope: 'parse', event: 'miss', message: 'no topics', url: 'https://x/1', taskId: 3, runId: 7 },
    { ts: '2026-11-10T00:00:03.000Z', source: 'worker' as const, level: 'error' as const, class: 'diag' as const, scope: 'queue', event: 'task.dead', message: 'gave up: http 404', url: 'https://x/1', taskId: 3, runId: 7 },
    { ts: '2026-11-10T00:00:04.000Z', source: 'api' as const, level: 'info' as const, class: 'audit' as const, scope: 'review', event: 'decide', message: 'marked hindi', url: null, taskId: null, runId: null },
    { ts: '2026-11-10T00:00:05.000Z', source: 'api' as const, level: 'debug' as const, class: 'diag' as const, scope: 'api', event: 'request', message: 'GET /api/v1/logs', url: null, taskId: null, runId: null },
  ];
  for (const row of rows) {
    db.insert(logEvents).values({ ...row, detail: null }).run();
  }
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  seed();
});

describe('GET /api/v1/logs', () => {
  it('returns newest first with a total', async () => {
    const res = await app().inject({ url: url('/api/v1/logs') });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ ts: string; event: string }>; total: number };
    expect(body.total).toBe(5);
    expect(body.rows[0]!.event).toBe('request');
    expect(body.rows.map((row) => row.ts)).toEqual([...body.rows.map((row) => row.ts)].sort().reverse());
  });

  it('treats level as a minimum', async () => {
    const res = await app().inject({ url: url('/api/v1/logs?level=warn') });
    const rows = (res.json() as { rows: Array<{ level: string }> }).rows;
    expect(rows.map((row) => row.level).sort()).toEqual(['error', 'warn']);
  });

  it('filters by class, scope, source, url and runId', async () => {
    const audit = await app().inject({ url: url('/api/v1/logs?class=audit') });
    expect((audit.json() as { rows: unknown[] }).rows).toHaveLength(1);

    const scope = await app().inject({ url: url('/api/v1/logs?scope=parse,queue') });
    expect((scope.json() as { rows: Array<{ scope: string }> }).rows.map((row) => row.scope).sort()).toEqual([
      'parse',
      'queue',
    ]);

    const byUrl = await app().inject({ url: url(`/api/v1/logs?url=${encodeURIComponent('https://x/1')}`) });
    expect((byUrl.json() as { rows: unknown[] }).rows).toHaveLength(2);

    const byRun = await app().inject({ url: url('/api/v1/logs?runId=7') });
    expect((byRun.json() as { rows: unknown[] }).rows).toHaveLength(3);

    const bySource = await app().inject({ url: url('/api/v1/logs?source=api') });
    expect((bySource.json() as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it('searches message, event and url text', async () => {
    const res = await app().inject({ url: url('/api/v1/logs?q=404') });
    const rows = (res.json() as { rows: Array<{ event: string }> }).rows;
    expect(rows.map((row) => row.event)).toEqual(['task.dead']);
  });

  it('paginates with limit and offset', async () => {
    const page = await app().inject({ url: url('/api/v1/logs?limit=2&offset=1') });
    const body = page.json() as { rows: unknown[]; nextOffset: number | null };
    expect(body.rows).toHaveLength(2);
    expect(body.nextOffset).toBe(3);
  });

  it('clamps an absurd limit instead of returning everything', async () => {
    const res = await app().inject({ url: url('/api/v1/logs?limit=99999') });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(500);
  });
});

describe('GET /api/v1/logs/summary', () => {
  it('counts by level and by class', async () => {
    const res = await app().inject({ url: url('/api/v1/logs/summary?since=all') });
    const body = res.json() as {
      byLevel: Record<string, number>;
      byScope: Record<string, number>;
      diagRows: number;
      auditRows: number;
    };
    expect(body.byLevel['error']).toBe(1);
    expect(body.byLevel['warn']).toBe(1);
    expect(body.diagRows).toBe(4);
    expect(body.auditRows).toBe(1);
    expect(body.byScope['queue']).toBe(1);
  });
});

describe('request hook scope', () => {
  it('does not log non-api paths, so the SPA does not fill the table with asset requests', async () => {
    const previousLevel = process.env['LOG_LEVEL'];
    const previousScopes = process.env['LOG_DEBUG_SCOPES'];
    process.env['LOG_LEVEL'] = 'debug';
    process.env['LOG_DEBUG_SCOPES'] = 'api';
    try {
      const before = db.select().from(logEvents).all().length;
      await app().inject({ url: '/assets/index-abc123.js' });
      expect(db.select().from(logEvents).all().length).toBe(before);
    } finally {
      if (previousLevel === undefined) delete process.env['LOG_LEVEL'];
      else process.env['LOG_LEVEL'] = previousLevel;
      if (previousScopes === undefined) delete process.env['LOG_DEBUG_SCOPES'];
      else process.env['LOG_DEBUG_SCOPES'] = previousScopes;
    }
  });
});
