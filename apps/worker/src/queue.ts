import { and, asc, eq, sql } from 'drizzle-orm';
import { logEvent, type Db } from '@tamilcache/db';
import { crawlTasks } from '@tamilcache/db/schema';

export interface EnqueueInput {
  url: string;
  kind: 'listing' | 'topic' | 'delta_page';
  priority: 0 | 1;
  payload?: unknown;
  runId?: number | null;
}

export interface TaskRow {
  id: number;
  url: string;
  kind: 'listing' | 'topic' | 'delta_page';
  priority: number;
  payload: string | null;
  attempts: number;
  runId: number | null;
}

/** After this many failures a task is dead-lettered instead of retried forever. */
export const MAX_ATTEMPTS = 5;

function immediate<T>(db: Db, fn: () => T): T {
  return db.transaction(fn, { behavior: 'immediate' });
}

/**
 * Two lanes in one table. `priority` 0 is the daily delta, 1 is the backfill; `claimNext`
 * always takes the lowest priority number first, so a three-minute delta drains ahead of a
 * multi-day backfill without either lane holding a lock.
 */
export function enqueue(db: Db, input: EnqueueInput): TaskRow | null {
  const task = immediate(db, () => {
    const existing = db.select().from(crawlTasks).where(eq(crawlTasks.url, input.url)).get();
    if (existing) return null;
    return db
      .insert(crawlTasks)
      .values({
        url: input.url,
        kind: input.kind,
        priority: input.priority,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
        runId: input.runId ?? null,
      })
      .returning()
      .get() as TaskRow;
  });
  if (task) {
    logEvent(db, {
      source: 'worker',
      level: 'debug',
      class: 'diag',
      scope: 'queue',
      event: 'enqueue',
      message: `queued ${input.kind} p${input.priority}: ${input.url}`,
      url: input.url,
      taskId: task.id,
      runId: input.runId ?? null,
      detail: { kind: input.kind, priority: input.priority },
    });
  }
  return task;
}

/**
 * Delta topics must be re-read every day to notice edits (a magnet added hours after posting).
 * Re-arming also *promotes* the lane: a topic still queued for backfill becomes P0, otherwise a
 * fresh release could sit behind 20k old pages.
 */
export function enqueueOrRearm(db: Db, input: EnqueueInput): boolean {
  const outcome = immediate(db, () => {
    const existing = db.select().from(crawlTasks).where(eq(crawlTasks.url, input.url)).get();
    if (!existing) {
      enqueue(db, input);
      return { changed: true, previous: null as string | null };
    }
    if (existing.state === 'done' || existing.state === 'error' || existing.priority > input.priority) {
      db.update(crawlTasks)
        .set({
          state: 'pending',
          priority: input.priority,
          kind: input.kind,
          payload: input.payload === undefined ? existing.payload : JSON.stringify(input.payload),
          nextAttemptAt: null,
        })
        .where(eq(crawlTasks.id, existing.id))
        .run();
      return { changed: true, previous: existing.state as string | null };
    }
    return { changed: false, previous: existing.state as string | null };
  });

  if (outcome.changed && outcome.previous) {
    logEvent(db, {
      source: 'worker',
      level: 'debug',
      class: 'diag',
      scope: 'queue',
      event: 'rearm',
      message: `re-armed a ${outcome.previous} task: ${input.url}`,
      url: input.url,
      runId: input.runId ?? null,
      detail: { previousState: outcome.previous, priority: input.priority },
    });
  }
  return outcome.changed;
}

/**
 * Claim is a single UPDATE … RETURNING, not SELECT-then-UPDATE: with two processes on one file
 * the read-then-write shape lets both claim the same task and double-fetch it.
 */
export function claimNext(db: Db, nowMs = Date.now()): TaskRow | null {
  const nowIso = new Date(nowMs).toISOString();
  return immediate(db, () => {
    const candidate = db
      .select({ id: crawlTasks.id })
      .from(crawlTasks)
      .where(
        and(
          eq(crawlTasks.state, 'pending'),
          sql`(${crawlTasks.nextAttemptAt} IS NULL OR ${crawlTasks.nextAttemptAt} <= ${nowIso})`,
        ),
      )
      .orderBy(asc(crawlTasks.priority), asc(crawlTasks.id))
      .limit(1)
      .get();
    if (!candidate) return null;

    return db
      .update(crawlTasks)
      .set({ state: 'running' })
      .where(and(eq(crawlTasks.id, candidate.id), eq(crawlTasks.state, 'pending')))
      .returning()
      .get() as TaskRow | null;
  });
}

export function complete(db: Db, id: number): void {
  // The row is read inside the transaction and the event is written after it commits: a rollback
  // must never erase the failure or completion that caused the log line.
  const row = immediate(db, () => {
    const found = db.select().from(crawlTasks).where(eq(crawlTasks.id, id)).get();
    db.update(crawlTasks).set({ state: 'done', nextAttemptAt: null }).where(eq(crawlTasks.id, id)).run();
    return found;
  });
  logEvent(db, {
    source: 'worker',
    level: 'debug',
    class: 'diag',
    scope: 'queue',
    event: 'task.done',
    message: `done: ${row?.url ?? id}`,
    url: row?.url ?? null,
    taskId: id,
    runId: row?.runId ?? null,
    detail: { kind: row?.kind ?? null, attempts: row?.attempts ?? 0 },
  });
}

/**
 * Exponential backoff per attempt (30s, 2m, 8m, 32m) and a dead-letter state after
 * `MAX_ATTEMPTS`: a permanently 404 URL must stop consuming the politeness budget.
 */
export function fail(
  db: Db,
  id: number,
  nowMs: number,
  reason = 'unknown',
): { attempts: number; dead: boolean } {
  const outcome = immediate(db, () => {
    const row = db.select().from(crawlTasks).where(eq(crawlTasks.id, id)).get();
    const attempts = (row?.attempts ?? 0) + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const backoffMs = 30_000 * 4 ** (attempts - 1);
    db.update(crawlTasks)
      .set({
        state: dead ? 'error' : 'pending',
        attempts,
        nextAttemptAt: dead ? null : new Date(nowMs + backoffMs).toISOString(),
      })
      .where(eq(crawlTasks.id, id))
      .run();
    return { row, attempts, dead, backoffMs };
  });

  logEvent(db, {
    source: 'worker',
    level: outcome.dead ? 'error' : 'warn',
    class: 'diag',
    scope: 'queue',
    event: outcome.dead ? 'task.dead' : 'task.failed',
    message: outcome.dead
      ? `gave up after ${outcome.attempts} attempts: ${reason}`
      : `attempt ${outcome.attempts} failed, retrying in ${Math.round(outcome.backoffMs / 1000)}s: ${reason}`,
    url: outcome.row?.url ?? null,
    taskId: id,
    runId: outcome.row?.runId ?? null,
    detail: { reason, attempts: outcome.attempts, kind: outcome.row?.kind ?? null },
  });
  return { attempts: outcome.attempts, dead: outcome.dead };
}

/**
 * Hand a claimed task back untouched. Used when the failure is infrastructure (an open breaker)
 * rather than this task's fault: burning one of its five attempts there would dead-letter a
 * perfectly good URL because the site blocked us for half an hour.
 */
export function release(db: Db, id: number): void {
  immediate(db, () => {
    db.update(crawlTasks)
      .set({ state: 'pending', nextAttemptAt: null })
      .where(eq(crawlTasks.id, id))
      .run();
  });
}

export function resetRunning(db: Db): number {
  return immediate(db, () => {
    const rows = db.select().from(crawlTasks).where(eq(crawlTasks.state, 'running')).all();
    if (rows.length === 0) return 0;
    db.update(crawlTasks).set({ state: 'pending' }).where(eq(crawlTasks.state, 'running')).run();
    return rows.length;
  });
}

export function pendingCount(db: Db, priority?: 0 | 1): number {
  return db
    .select()
    .from(crawlTasks)
    .where(
      priority === undefined
        ? eq(crawlTasks.state, 'pending')
        : and(eq(crawlTasks.state, 'pending'), eq(crawlTasks.priority, priority)),
    )
    .all().length;
}

export function deadLetterCount(db: Db): number {
  return db.select().from(crawlTasks).where(eq(crawlTasks.state, 'error')).all().length;
}
