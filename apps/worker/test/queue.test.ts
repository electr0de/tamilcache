import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { crawlTasks, logEvents } from '@tamilcache/db/schema';
import { claimNext, complete, enqueue, enqueueOrRearm, fail, MAX_ATTEMPTS, pendingCount, resetRunning, deadLetterCount } from '../src/queue.js';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
});

describe('two-lane queue', () => {
  it('claims P0 before P1 regardless of insertion order', () => {
    enqueue(db, { url: 'https://x/p1', kind: 'topic', priority: 1 });
    enqueue(db, { url: 'https://x/p0', kind: 'delta_page', priority: 0 });
    expect(claimNext(db)?.url).toBe('https://x/p0');
    expect(claimNext(db)?.url).toBe('https://x/p1');
  });

  it('is FIFO within a lane', () => {
    enqueue(db, { url: 'https://x/1', kind: 'topic', priority: 1 });
    enqueue(db, { url: 'https://x/2', kind: 'topic', priority: 1 });
    expect(claimNext(db)?.url).toBe('https://x/1');
    expect(claimNext(db)?.url).toBe('https://x/2');
  });

  it('dedupes by url', () => {
    enqueue(db, { url: 'https://x/1', kind: 'topic', priority: 1 });
    expect(enqueue(db, { url: 'https://x/1', kind: 'topic', priority: 1 })).toBeNull();
    expect(db.select().from(crawlTasks).all()).toHaveLength(1);
  });

  it('schedules an exponential retry in the future on failure', () => {
    const task = enqueue(db, { url: 'https://x/1', kind: 'topic', priority: 1 })!;
    claimNext(db);
    const first = fail(db, task.id, 1_000_000);
    const row = db.select().from(crawlTasks).all()[0]!;
    expect(first).toEqual({ attempts: 1, dead: false });
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBe(new Date(1_030_000).toISOString());
    expect(claimNext(db, 1_000_000)).toBeNull();
    expect(claimNext(db, 1_030_001)?.url).toBe('https://x/1');
  });

  it('dead-letters a task after MAX_ATTEMPTS instead of retrying forever', () => {
    const task = enqueue(db, { url: 'https://x/dead', kind: 'topic', priority: 1 })!;
    let outcome = { attempts: 0, dead: false };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      claimNext(db, 10_000_000);
      outcome = fail(db, task.id, 10_000_000);
    }
    expect(outcome.dead).toBe(true);
    const row = db.select().from(crawlTasks).all()[0]!;
    expect(row.state).toBe('error');
    expect(row.nextAttemptAt).toBeNull();
    expect(claimNext(db, 999_999_999)).toBeNull();

    // Dead-lettered tasks are counted for the API/dashboard.
    expect(deadLetterCount(db)).toBe(1);
  });

  it('marks a claimed task done', () => {
    const task = enqueue(db, { url: 'https://x/1', kind: 'topic', priority: 1 })!;
    claimNext(db);
    complete(db, task.id);
    expect(db.select().from(crawlTasks).all()[0]!.state).toBe('done');
  });

  it('returns in-flight tasks to pending after a crash', () => {
    enqueue(db, { url: 'https://x/1', kind: 'topic', priority: 1 });
    claimNext(db);
    expect(resetRunning(db)).toBe(1);
    expect(pendingCount(db)).toBe(1);
  });

  it('counts pending tasks per lane', () => {
    enqueue(db, { url: 'https://x/1', kind: 'topic', priority: 1 });
    enqueue(db, { url: 'https://x/2', kind: 'delta_page', priority: 0 });
    expect(pendingCount(db)).toBe(2);
    expect(pendingCount(db, 0)).toBe(1);
    expect(pendingCount(db, 1)).toBe(1);
  });
});

describe('failure reasons are recorded', () => {
  it('writes the reason on every attempt and one error-level dead letter at MAX_ATTEMPTS', () => {
    const task = enqueue(db, { url: 'https://x/f', kind: 'topic', priority: 1 })!;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fail(db, task.id, Date.now(), 'http 404');
    }
    expect(db.select().from(crawlTasks).all()[0]!.state).toBe('error');
    const events = db.select().from(logEvents).all();
    expect(events.filter((event) => event.event === 'task.failed')).toHaveLength(MAX_ATTEMPTS - 1);
    const dead = events.filter((event) => event.event === 'task.dead');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.level).toBe('error');
    expect(dead[0]!.url).toBe('https://x/f');
    expect(dead[0]!.detail).toContain('http 404');
  });

  it('keeps task.done out of the default view (debug level)', () => {
    const task = enqueue(db, { url: 'https://x/d', kind: 'topic', priority: 1 })!;
    complete(db, task.id);
    expect(db.select().from(logEvents).all().filter((event) => event.event === 'task.done')).toHaveLength(0);
  });
});

describe('enqueue and rearm telemetry', () => {
  it('records enqueue and rearm when debug is enabled for the queue scope', () => {
    process.env['LOG_DEBUG_SCOPES'] = 'queue';
    try {
      const task = enqueue(db, { url: 'https://x/r', kind: 'topic', priority: 1 })!;
      complete(db, task.id);
      expect(enqueueOrRearm(db, { url: 'https://x/r', kind: 'topic', priority: 0 })).toBe(true);
      const events = db.select().from(logEvents).all();
      expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(['enqueue', 'rearm']));
      expect(events.find((event) => event.event === 'rearm')!.detail).toContain('"previousState":"done"');
    } finally {
      delete process.env['LOG_DEBUG_SCOPES'];
    }
  });
});
