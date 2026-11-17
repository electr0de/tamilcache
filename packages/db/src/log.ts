import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { logEvents } from './schema.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogClass = 'audit' | 'diag';
export type LogScope =
  | 'boot'
  | 'crawl'
  | 'queue'
  | 'http'
  | 'parse'
  | 'persist'
  | 'provider'
  | 'state'
  | 'torznab'
  | 'auth'
  | 'api'
  | 'review'
  | 'curation'
  | 'log';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MESSAGE_MAX = 200;
const DETAIL_MAX = 2048;

export interface LogEntry {
  source: 'worker' | 'api';
  level: LogLevel;
  class: LogClass;
  scope: LogScope;
  event: string;
  message: string;
  url?: string | null;
  taskId?: number | null;
  runId?: number | null;
  forumId?: number | null;
  variantId?: number | null;
  detail?: Record<string, unknown> | null;
}

/**
 * `LOG_LEVEL` is a minimum, so `warn` also keeps errors. `LOG_DEBUG_SCOPES` is the escape hatch
 * that makes "log everything" affordable: debug rows are written only for the scopes named there.
 */
export function levelEnabled(
  level: LogLevel,
  scope: LogScope,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = (env['LOG_LEVEL'] ?? 'info').toLowerCase() as LogLevel;
  if (RANK[level] >= (RANK[configured] ?? RANK.info)) return true;
  if (level !== 'debug') return false;
  return (env['LOG_DEBUG_SCOPES'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(scope);
}

/**
 * Deliberately does not match a bare `key` field: `app_state` keys are identifiers, not secrets,
 * and redacting them would erase the answer to "who flipped this flag". Credential-shaped names
 * (`apiKey`, `torznabApiKey`, `secret`, `token`, `password`) are still scrubbed.
 */
const SECRET_KEY = /apikey|api_key|secret|token|password|credential/i;
const APIKEY_IN_URL = /(apikey=)[^&\s]+/gi;

/** Magnets and infohashes are kept: they are the audit point for a grab. Keys never are. */
export function redact(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = typeof value === 'string' ? value.replace(APIKEY_IN_URL, '$1[redacted]') : value;
  }
  return out;
}

/**
 * The single write path for `log_events`.
 *
 * It never throws. A logging failure must not be the reason the crawler stops — that is the exact
 * failure mode this table exists to make visible, so trading one for the other would be absurd.
 */
/**
 * Caps `detail` without producing invalid JSON. Slicing the serialised object raw cuts mid-string,
 * which leaves an unterminated JSON document; anything parsing the column then throws. Over the
 * cap, the payload is wrapped so the remainder is still readable and the column still parses.
 */
function capDetail(serialised: string): string {
  if (serialised.length <= DETAIL_MAX) return serialised;
  let cut = serialised.slice(0, DETAIL_MAX);
  let out = JSON.stringify({ truncated: true, text: cut });
  // Escaping can make the wrapper longer than the text it wraps; shrink until it fits.
  while (out.length > DETAIL_MAX && cut.length > 0) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
    out = JSON.stringify({ truncated: true, text: cut });
  }
  return out;
}

export function logEvent(db: Db, entry: LogEntry): void {
  try {
    if (!levelEnabled(entry.level, entry.scope)) return;
    const message =
      entry.message.length > MESSAGE_MAX
        ? `${entry.message.slice(0, MESSAGE_MAX - 1)}…`
        : entry.message;
    const serialised = entry.detail ? JSON.stringify(redact(entry.detail)) : null;
    db.insert(logEvents)
      .values({
        ts: new Date().toISOString(),
        source: entry.source,
        level: entry.level,
        class: entry.class,
        scope: entry.scope,
        event: entry.event,
        message,
        url: entry.url ?? null,
        taskId: entry.taskId ?? null,
        runId: entry.runId ?? null,
        forumId: entry.forumId ?? null,
        variantId: entry.variantId ?? null,
        detail: serialised ? capDetail(serialised) : null,
      })
      .run();
  } catch (error) {
    console.error('logEvent failed:', error instanceof Error ? error.message : String(error));
  }
}

export interface PruneResult {
  deleted: number;
  remaining: number;
  auditKept: number;
}

function countRows(db: Db, where = '1 = 1'): number {
  const rows = db.all<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM log_events WHERE ${where}`));
  return rows[0]?.count ?? 0;
}

/**
 * Diagnostic rows expire; audit rows do not. A human decision or a Sonarr grab must survive every
 * retention sweep, so `class = 'audit'` is excluded from both statements — a careless prune that
 * deleted the audit trail would defeat the reason the class column exists.
 */
export function pruneLogs(
  db: Db,
  options: { keepDays?: number; maxRows?: number; now?: Date } = {},
): PruneResult {
  const keepDays = options.keepDays ?? Number(process.env['LOG_KEEP_DAYS'] ?? 14);
  const maxRows = options.maxRows ?? 200_000;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();

  const before = countRows(db);
  db.run(sql`DELETE FROM log_events WHERE class = 'diag' AND ts < ${cutoff}`);
  const excess = countRows(db, "class = 'diag'") - maxRows;
  if (excess > 0) {
    db.run(
      sql`DELETE FROM log_events WHERE id IN (
        SELECT id FROM log_events WHERE class = 'diag' ORDER BY id ASC LIMIT ${excess})`,
    );
  }
  const remaining = countRows(db);
  return { deleted: before - remaining, remaining, auditKept: countRows(db, "class = 'audit'") };
}
