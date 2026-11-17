import cron from 'node-cron';
import { pino } from 'pino';
import { logEvent, openDb } from '@tamilcache/db';
import { loadForumConfig, mirrorList, seedSourcesAndForums } from './config.js';
import type { CrawlContext } from './crawl.js';
import { CircuitOpenError, PoliteHttpClient } from './http-client.js';
import { pendingCount, resetRunning } from './queue.js';
import { TmdbClient } from './tmdb.js';
import { isOn, setState } from './state.js';
import { describeError } from './errors.js';
import { runTick, type TickDeps, type TickState } from './tick.js';

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
const delayMs = Number(process.env['CRAWL_DELAY_MS'] ?? 2000);
const dbPath = process.env['DB_PATH'] ?? './data/tamilcache.db';
const cronSpec = process.env['DELTA_CRON'] ?? '0 3 * * *';
const backfillPagesPerTick = Number(process.env['BACKFILL_PAGES_PER_TICK'] ?? 2);

const db = openDb(dbPath);
const baseUrl = mirrorList()[0] as string;
const config = loadForumConfig();
const { sourceId } = seedSourcesAndForums(db, baseUrl, config);

const tmdbKey = process.env['TMDB_API_KEY']?.trim() ?? '';
const tmdb = tmdbKey ? new TmdbClient({ apiKey: tmdbKey }) : null;
if (!tmdb) log.warn('TMDB_API_KEY is not set: hindi_original detection and episode data are disabled');

const http = new PoliteHttpClient({
  mirrors: mirrorList(),
  delayMs,
  maxAttempts: 3,
  onEvent: (event) => {
    logEvent(db, {
      source: 'worker',
      level: event.event === 'circuit_open' ? 'error' : event.event === 'retry' ? 'warn' : 'debug',
      class: 'diag',
      scope: 'http',
      event: event.event,
      message:
        event.event === 'request'
          ? `${event.status} in ${event.ms}ms`
          : event.event === 'retry'
            ? `${event.status} — retrying in ${event.backoffMs}ms`
            : `circuit opened: repeated ${event.status ?? 'blocked'} responses`,
      url: event.url,
      detail: {
        status: event.status ?? null,
        ms: event.ms,
        mirror: event.mirror ?? null,
        attempt: event.attempt ?? null,
      },
    });
  },
});
const ctx: CrawlContext = { db, http, baseUrl, sourceId, config };

logEvent(db, {
  source: 'worker',
  level: 'info',
  class: 'diag',
  scope: 'boot',
  event: 'start',
  message: 'worker starting',
  detail: {
    baseUrl,
    forums: config.length,
    delayMs,
    cron: cronSpec,
    dbPath,
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  },
});

const recovered = resetRunning(db);
if (recovered > 0) {
  log.warn({ recovered }, 'returned in-flight tasks to pending after restart');
  logEvent(db, {
    source: 'worker',
    level: 'warn',
    class: 'diag',
    scope: 'boot',
    event: 'crawl_reset',
    message: `returned ${recovered} in-flight tasks to pending after restart`,
    detail: { recovered },
  });
}

cron.schedule(cronSpec, () => {
  log.info('delta cron fired');
  setState(db, 'delta_requested', '1');
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    log.info({ signal }, 'shutting down after the current request');
    db.$client.close();
    process.exit(0);
  });
}

const tickState: TickState = { deltaFailures: 0, lastPruneAt: 0, lastIdleAt: 0 };
const tickDeps: TickDeps = { ctx, tmdb, log, backfillPagesPerTick, state: tickState };

async function main(): Promise<void> {
  log.info({ baseUrl, forums: config.length, delayMs, cron: cronSpec }, 'worker started');
  logEvent(db, {
    source: 'worker',
    level: 'info',
    class: 'diag',
    scope: 'boot',
    event: 'ready',
    message: 'worker ready: polling lane flags',
    detail: { cron: cronSpec, deltaRequested: isOn(db, 'delta_requested') },
  });
  for (;;) {
    try {
      await runTick(Date.now(), tickDeps);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        setState(db, 'circuit_open_until', String(error.untilMs));
        log.error({ until: new Date(error.untilMs).toISOString() }, 'circuit opened, pausing 30 minutes');
        // The pause is the one state a reader must be able to find in the Logs view.
        logEvent(db, {
          source: 'worker',
          level: 'error',
          class: 'diag',
          scope: 'crawl',
          event: 'circuit_open',
          message: `circuit opened, pausing until ${new Date(error.untilMs).toISOString()}`,
          detail: { circuitOpenUntil: error.untilMs },
        });
      } else {
        log.error({ err: error instanceof Error ? error.message : String(error) }, 'tick failed');
        logEvent(db, {
          source: 'worker',
          level: 'error',
          class: 'diag',
          scope: 'crawl',
          event: 'tick.failed',
          message: `tick failed: ${describeError(error)}`,
          detail: { reason: describeError(error) },
        });
      }
    }
    if (pendingCount(db) === 0) log.debug('queue idle');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

void main();
