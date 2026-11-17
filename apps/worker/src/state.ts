import { eq } from 'drizzle-orm';
import { logEvent, type Db } from '@tamilcache/db';
import { appState } from '@tamilcache/db/schema';

export type StateKey =
  | 'delta_requested'
  | 'backfill_armed'
  | 'backfill_paused'
  | 'last_delta_at'
  | 'backfill_complete_at'
  | 'circuit_open_until'
  | 'delta_retry_at'
  | 'tmdb_backoff_until'
  | 'torznab_api_key'
  | 'omdb_used_date'
  | 'omdb_used_today'
  | 'tvdb_token'
  | 'enrich_cursor'
  /** JSON of the last coverage audit, written by the CLI and served by `GET /api/v1/coverage`. */
  | 'coverage_report'
  | 'coverage_generated_at';

export function getState(db: Db, key: StateKey): string | null {
  return db.select().from(appState).where(eq(appState.key, key)).get()?.value ?? null;
}

/**
 * Every lane-flag change is an audit record: "why did the crawler stop" is answered here, with
 * who flipped the switch. A no-op write stays silent so the trail is not padded with repeats.
 */
export function setState(db: Db, key: StateKey, value: string, actor = 'worker'): void {
  const before = getState(db, key);
  db.insert(appState)
    .values({ key, value })
    .onConflictDoUpdate({ target: appState.key, set: { value } })
    .run();
  if (before !== value) {
    logEvent(db, {
      source: actor === 'api' ? 'api' : 'worker',
      level: 'info',
      class: 'audit',
      scope: 'state',
      event: 'change',
      message: `${key}: ${before ?? '(unset)'} → ${value}`,
      detail: { key, from: before, to: value, actor },
    });
  }
}

export function clearState(db: Db, key: StateKey, actor = 'worker'): void {
  const before = getState(db, key);
  db.delete(appState).where(eq(appState.key, key)).run();
  if (before !== null) {
    logEvent(db, {
      source: actor === 'api' ? 'api' : 'worker',
      level: 'info',
      class: 'audit',
      scope: 'state',
      event: 'change',
      message: `${key}: ${before} → (cleared)`,
      detail: { key, from: before, to: null, actor },
    });
  }
}

/**
 * The API cannot crawl (the worker owns every outbound request), so lane control is expressed
 * as intent in `app_state` and picked up by the worker's loop. That keeps exactly one process
 * making HTTP calls, which is what makes the 2 s politeness budget enforceable.
 */
export function isOn(db: Db, key: StateKey): boolean {
  return getState(db, key) === '1' || getState(db, key) === 'true';
}
