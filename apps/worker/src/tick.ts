import type { Logger } from 'pino';
import { logEvent, pruneLogs } from '@tamilcache/db';
import { crawlRuns } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';
import {
  backfillComplete,
  drainQueue,
  nextBackfillForums,
  runBackfillPage,
  runDelta,
  type CrawlContext,
} from './crawl.js';
import { deadLetterCount, pendingCount } from './queue.js';
import { describeError } from './errors.js';
import { enrichBatch, runProviderPass } from './provider-pass.js';
import { replayAll } from './replay.js';
import { selectPreferredAcrossTitles } from './select.js';
import { pruneRetention } from './retention.js';
import { clearState, getState, isOn, setState } from './state.js';
import type { TmdbClient } from './tmdb.js';

/** Mutable counters that survive between ticks. Passed in so the loop stays testable. */
export interface TickState {
  deltaFailures: number;
  lastPruneAt: number;
  /** Rate limit for the hourly "why is it idle" row. */
  lastIdleAt: number;
}

/** A delta older than a day plus slack is overdue, whatever the cron did. */
export const DELTA_OVERDUE_MS = 26 * 3_600_000;
const IDLE_LOG_EVERY_MS = 3_600_000;

export interface TickDeps {
  ctx: CrawlContext;
  tmdb: TmdbClient | null;
  log: Pick<Logger, 'info' | 'warn' | 'debug' | 'error'>;
  backfillPagesPerTick: number;
  state: TickState;
}

export function deltaDue(ctx: CrawlContext, now: number): boolean {
  if (isOn(ctx.db, 'delta_requested')) return true;
  // Respect the failure backoff before anything else, or an overdue delta would retry every tick.
  const retryAt = Number(getState(ctx.db, 'delta_retry_at') ?? 0);
  if (now < retryAt) return false;
  const last = getState(ctx.db, 'last_delta_at');
  if (last === null) return true;
  const lastAt = Date.parse(last);
  if (!Number.isFinite(lastAt)) return true;
  // A missed cron (host off at 03:00, redeploy at 14:00) must self-heal instead of waiting a day.
  return now - lastAt >= DELTA_OVERDUE_MS;
}

/**
 * One pass of the crawl loop: prune, then the circuit gate, then the delta, the queue, the
 * backfill and the provider pass. Extracted from `main.ts` so the branches that only run at
 * boot or once an hour can be tested without starting the process.
 */
export async function runTick(now: number, deps: TickDeps): Promise<void> {
  const { ctx, tmdb, log, backfillPagesPerTick, state } = deps;
  const db = ctx.db;

  // Prune before the circuit gate: an open breaker must not stop retention, or a long outage
  // would leave the table growing untouched.
  if (now - state.lastPruneAt >= 3_600_000) {
    state.lastPruneAt = now;
    const pruned = pruneLogs(db, { now: new Date(now) });
    logEvent(db, {
      source: 'worker',
      level: 'info',
      class: 'diag',
      scope: 'log',
      event: 'prune',
      message: `pruned ${pruned.deleted} diagnostic rows`,
      detail: { ...pruned },
    });
  }

  const circuitUntil = getState(db, 'circuit_open_until');
  if (circuitUntil && Number(circuitUntil) > now) {
    log.warn({ until: new Date(Number(circuitUntil)).toISOString() }, 'circuit open: idling');
    // The one thing that truly pauses the crawler must be visible in the Logs view, not only on
    // the worker's stdout. Rate-limited by the tick's own hourly idle row below.
    logEvent(db, {
      source: 'worker',
      level: 'warn',
      class: 'diag',
      scope: 'crawl',
      event: 'circuit_open',
      message: `circuit open until ${new Date(Number(circuitUntil)).toISOString()}: idling`,
      detail: { circuitOpenUntil: Number(circuitUntil) },
    });
    return;
  }

  let deltaRunId: number | null = null;
  // P0 first, always. The delta is a bounded ~125-request job; it must never queue behind the
  // backfill's HTTP round-trips.
  if (deltaDue(ctx, now)) {
    try {
      const result = await runDelta(ctx);
      deltaRunId = result.runId;
      setState(db, 'last_delta_at', new Date().toISOString());
      clearState(db, 'delta_requested');
      clearState(db, 'delta_retry_at');
      state.deltaFailures = 0;
      log.info({ enqueued: result.enqueued, runId: result.runId }, 'delta enqueued');
    } catch (error) {
      state.deltaFailures++;
      const backoffMs = Math.min(30_000 * 2 ** state.deltaFailures, 30 * 60_000);
      setState(db, 'delta_retry_at', String(now + backoffMs));
      clearState(db, 'delta_requested');
      log.error(
        { err: error instanceof Error ? error.message : String(error), retryInMs: backoffMs },
        'delta failed; backing off',
      );
      logEvent(db, {
        source: 'worker',
        level: 'error',
        class: 'diag',
        scope: 'crawl',
        event: 'delta.failed',
        message: `delta failed: ${describeError(error)}`,
        detail: { reason: describeError(error), retryInMs: backoffMs, failures: state.deltaFailures },
      });
    }
  }

  const drained = await drainQueue(ctx, { max: 25 });
  if (deltaRunId !== null) {
    // Close the run the delta opened: an unfinished row made every completed delta look abandoned.
    db.update(crawlRuns)
      .set({
        // Wall clock, not the tick's start: the run row is created after the tick begins, and a
        // finished_at earlier than started_at is nonsense.
        finishedAt: new Date().toISOString(),
        tasksDone: drained.processed,
        tasksFailed: drained.failed,
      })
      .where(eq(crawlRuns.id, deltaRunId))
      .run();
  }
  // One preferred release per title per resolution, now that this tick may have added variants.
  if (drained.processed > 0) {
    const selection = selectPreferredAcrossTitles(db);
    if (selection.changed > 0) log.debug(selection, 'selection pass');
  }

  let providerChecked = 0;
  let backfillPages = 0;

  if (isOn(db, 'backfill_armed') && !isOn(db, 'backfill_paused')) {
    for (const forumId of nextBackfillForums(ctx, backfillPagesPerTick)) {
      try {
        await runBackfillPage(ctx, forumId);
        backfillPages++;
      } catch (error) {
        // A broken forum must not stall the loop; it is skipped and retried on a later tick.
        log.warn({ forumId, err: error instanceof Error ? error.message : String(error) }, 'backfill page failed');
      }
    }
    if (getState(db, 'backfill_complete_at') === null && backfillComplete(ctx)) {
      setState(db, 'backfill_complete_at', new Date(now).toISOString());
      logEvent(db, {
        source: 'worker',
        level: 'info',
        class: 'diag',
        scope: 'crawl',
        event: 'backfill.complete',
        message: 'backfill complete: every in-scope forum reached its last page',
        detail: { forums: ctx.config.filter((forum) => !forum.hub).length },
      });
    }
  }

  const tmdbBackoffUntil = Number(getState(db, 'tmdb_backoff_until') ?? 0);
  if (tmdbBackoffUntil > now) {
    log.debug({ until: new Date(tmdbBackoffUntil).toISOString() }, 'tmdb backoff: skipping provider pass');
  } else {
    const provider = await runProviderPass(db, tmdb, { limit: 20 });
    if (provider.checked > 0) {
      log.info(provider, 'provider pass');
      logEvent(db, {
        source: 'worker',
        level: 'info',
        class: 'diag',
        scope: 'provider',
        event: 'pass.finish',
        message: `provider pass checked ${provider.checked} titles`,
        detail: { ...provider },
      });
    }
    if (provider.rateLimitedMs) {
      const until = now + provider.rateLimitedMs;
      setState(db, 'tmdb_backoff_until', String(until));
      log.warn({ until: new Date(until).toISOString() }, 'TMDB rate limited: backing off');
      logEvent(db, {
        source: 'worker',
        level: 'warn',
        class: 'diag',
        scope: 'provider',
        event: 'rate_limited',
        message: `TMDB rate limited; backing off ${Math.round(provider.rateLimitedMs / 1000)}s`,
        detail: { until },
      });
    }

    // Backfill the schema-v9 metadata for rows that predate it. Same lane, same backoff: a rate
    // limit here must stop TMDB work for the whole tick, not just this batch.
    if (!provider.rateLimitedMs && tmdb !== null) {
      const enrichment = await enrichBatch(db, tmdb, { limit: 50 });
      if (enrichment.enriched > 0 || enrichment.failed > 0) {
        logEvent(db, {
          source: 'worker',
          level: enrichment.failed > 0 ? 'warn' : 'info',
          class: 'diag',
          scope: 'provider',
          event: 'enrich.batch',
          message:
            `enriched ${enrichment.enriched} media rows` +
            (enrichment.failed > 0 ? `, ${enrichment.failed} failed` : '') +
            ` (${enrichment.remaining ?? '?'} remaining)`,
          detail: { ...enrichment },
        });
      }
      if (enrichment.rateLimitedMs) {
        const until = now + enrichment.rateLimitedMs;
        setState(db, 'tmdb_backoff_until', String(until));
        logEvent(db, {
          source: 'worker',
          level: 'warn',
          class: 'diag',
          scope: 'provider',
          event: 'rate_limited',
          message: `TMDB rate limited during enrichment; backing off ${Math.round(enrichment.rateLimitedMs / 1000)}s`,
          detail: { until },
        });
      }
    }
    providerChecked += provider.checked;
  }

  if (drained.processed > 0 || providerChecked > 0) {
    const replay = replayAll(db);
    if (replay.updated > 0) log.info({ updated: replay.updated }, 'reclassified after crawl');
    // Retention runs after replay, never before: the classifier needs the row to decide it.
    const pruned = pruneRetention(db);
    if (pruned.variants > 0) log.info(pruned, 'pruned non-Hindi variants');
  }
  if (drained.dead > 0) log.error({ dead: drained.dead, totalDead: deadLetterCount(db) }, 'tasks dead-lettered');
  if (drained.dropped > 0) log.debug({ dropped: drained.dropped }, 'variants below 1080p dropped');

  // "Why is the queue doing nothing?" deserves an answer in the Logs view, not just silence.
  // One row an hour is enough to see it and cheap enough to keep forever.
  const idle =
    drained.processed === 0 &&
    drained.failed === 0 &&
    providerChecked === 0 &&
    backfillPages === 0 &&
    deltaRunId === null;
  if (idle && now - state.lastIdleAt >= IDLE_LOG_EVERY_MS) {
    state.lastIdleAt = now;
    logEvent(db, {
      source: 'worker',
      level: 'info',
      class: 'diag',
      scope: 'crawl',
      event: 'idle',
      message: 'idle: nothing to crawl',
      detail: {
        pending: pendingCount(db),
        lastDeltaAt: getState(db, 'last_delta_at'),
        backfillArmed: isOn(db, 'backfill_armed'),
        backfillPaused: isOn(db, 'backfill_paused'),
        backfillCompleteAt: getState(db, 'backfill_complete_at'),
        circuitOpenUntil: getState(db, 'circuit_open_until'),
      },
    });
  }
}
