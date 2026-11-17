import { describe, expect, it, vi } from 'vitest';
import { createDb, migrate } from '../src/client.js';
import { levelEnabled, logEvent, pruneLogs, redact } from '../src/log.js';
import { logEvents } from '../src/schema.js';

function freshDb() {
  const db = createDb(':memory:');
  migrate(db);
  return db;
}

describe('levelEnabled', () => {
  it('defaults to info and lets error through', () => {
    expect(levelEnabled('debug', 'http', {})).toBe(false);
    expect(levelEnabled('info', 'http', {})).toBe(true);
    expect(levelEnabled('error', 'http', {})).toBe(true);
  });

  it('treats LOG_LEVEL as a minimum', () => {
    expect(levelEnabled('info', 'queue', { LOG_LEVEL: 'warn' })).toBe(false);
    expect(levelEnabled('warn', 'queue', { LOG_LEVEL: 'warn' })).toBe(true);
    expect(levelEnabled('error', 'queue', { LOG_LEVEL: 'warn' })).toBe(true);
  });

  it('enables debug for the listed scopes only', () => {
    const env = { LOG_DEBUG_SCOPES: 'http,torznab' };
    expect(levelEnabled('debug', 'http', env)).toBe(true);
    expect(levelEnabled('debug', 'torznab', env)).toBe(true);
    expect(levelEnabled('debug', 'queue', env)).toBe(false);
  });
});

describe('redact', () => {
  it('replaces secret-ish keys and scrubs apikey query params', () => {
    const out = redact({
      torznabApiKey: 'abc',
      note: 'GET /api/v1/search?apikey=deadbeef&t=1',
      infohash: '0123456789abcdef',
    });
    expect(out['torznabApiKey']).toBe('[redacted]');
    expect(out['note']).toBe('GET /api/v1/search?apikey=[redacted]&t=1');
    expect(out['infohash']).toBe('0123456789abcdef');
  });
});

describe('logEvent', () => {
  it('writes one row with its correlation ids', () => {
    const db = freshDb();
    logEvent(db, {
      source: 'worker',
      level: 'error',
      class: 'audit',
      scope: 'queue',
      event: 'task.dead',
      message: 'gave up',
      url: 'https://example.test/t/1',
      taskId: 4,
      runId: 2,
    });
    const rows = db.select().from(logEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'task.dead', taskId: 4, runId: 2, class: 'audit' });
    db.$client.close();
  });

  it('skips a debug row that the level gate rejects', () => {
    const db = freshDb();
    logEvent(db, {
      source: 'worker',
      level: 'debug',
      class: 'diag',
      scope: 'http',
      event: 'request',
      message: 'noise',
    });
    expect(db.select().from(logEvents).all()).toHaveLength(0);
    db.$client.close();
  });

  it('truncates the message but never the url', () => {
    const db = freshDb();
    const longUrl = `https://example.test/${'a'.repeat(400)}`;
    logEvent(db, {
      source: 'worker',
      level: 'error',
      class: 'diag',
      scope: 'parse',
      event: 'miss',
      message: 'm'.repeat(500),
      url: longUrl,
    });
    const row = db.select().from(logEvents).all()[0]!;
    expect(row.message.length).toBe(200);
    expect(row.url).toBe(longUrl);
    db.$client.close();
  });

  it('serialises and redacts detail', () => {
    const db = freshDb();
    logEvent(db, {
      source: 'api',
      level: 'warn',
      class: 'audit',
      scope: 'auth',
      event: 'reject',
      message: 'refused',
      detail: { condition: 'host', apiKey: 'secret' },
    });
    const row = db.select().from(logEvents).all()[0]!;
    expect(row.detail).toContain('"condition":"host"');
    expect(row.detail).not.toContain('secret');
    db.$client.close();
  });

  it('never throws when the write fails', () => {
    const db = freshDb();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.run('DROP TABLE log_events');
    expect(() =>
      logEvent(db, {
        source: 'api',
        level: 'error',
        class: 'diag',
        scope: 'api',
        event: 'error',
        message: 'x',
      }),
    ).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    db.$client.close();
  });
});

describe('pruneLogs', () => {
  it('deletes old diagnostic rows but never audit rows', () => {
    const db = freshDb();
    const old = '2020-01-01T00:00:00.000Z';
    db.run(`INSERT INTO log_events (ts, source, level, class, scope, event, message) VALUES
      ('${old}','worker','info','diag','queue','a','old diag'),
      ('${old}','api','info','audit','review','b','old audit'),
      ('${old}','worker','error','diag','queue','c','old error diag')`);
    const result = pruneLogs(db, { keepDays: 14, now: new Date('2026-11-10T00:00:00Z') });
    const remaining = db.select().from(logEvents).all();
    expect(result.deleted).toBe(2);
    expect(result.auditKept).toBe(1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.class).toBe('audit');
    db.$client.close();
  });

  it('caps diagnostic rows, deleting the oldest first', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      db.run(`INSERT INTO log_events (ts, source, level, class, scope, event, message)
        VALUES ('2026-11-10T00:00:0${i}.000Z','worker','info','diag','queue','e','m${i}')`);
    }
    const result = pruneLogs(db, { maxRows: 4, now: new Date('2026-11-10T00:00:09Z') });
    const remaining = db.select().from(logEvents).all();
    expect(result.deleted).toBe(6);
    expect(remaining).toHaveLength(4);
    expect(remaining.map((row) => row.message).sort()).toEqual(['m6', 'm7', 'm8', 'm9']);
    db.$client.close();
  });
});

describe('redaction precision', () => {
  it('keeps an identifier-shaped key field but scrubs credential-shaped ones', () => {
    const out = redact({ key: 'backfill_armed', apiKey: 'x', torznabApiKey: 'y', accessToken: 'z' });
    expect(out['key']).toBe('backfill_armed');
    expect(out['apiKey']).toBe('[redacted]');
    expect(out['torznabApiKey']).toBe('[redacted]');
    expect(out['accessToken']).toBe('[redacted]');
  });
});

describe('detail cap', () => {
  it('keeps detail parseable when it exceeds the 2 KB cap', () => {
    const db = freshDb();
    logEvent(db, {
      source: 'worker',
      level: 'error',
      class: 'diag',
      scope: 'parse',
      event: 'miss',
      message: 'oversized',
      detail: { reason: 'x'.repeat(5000), quotes: '"'.repeat(200) },
    });
    const row = db.select().from(logEvents).all()[0]!;
    expect(row.detail!.length).toBeLessThanOrEqual(2048);
    const parsed = JSON.parse(row.detail!) as { truncated?: boolean; text?: string };
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.text).toBe('string');
    db.$client.close();
  });
});
