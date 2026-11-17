import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { logEvents } from '@tamilcache/db/schema';
import { clearState, getState, setState } from '../src/state.js';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
});

function changes() {
  return db
    .select()
    .from(logEvents)
    .all()
    .filter((row) => row.event === 'change');
}

describe('lane-flag telemetry', () => {
  it('writes an audit row when a flag changes', () => {
    setState(db, 'backfill_armed', '1');
    const rows = changes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ class: 'audit', scope: 'state', source: 'worker' });
    expect(rows[0]!.detail).toContain('"key":"backfill_armed"');
    expect(rows[0]!.detail).toContain('"from":null');
    expect(rows[0]!.message).toContain('(unset) → 1');
  });

  it('does not write a row when the value is unchanged', () => {
    setState(db, 'backfill_armed', '1');
    setState(db, 'backfill_armed', '1');
    expect(changes()).toHaveLength(1);
  });

  it('attributes an API-driven change to the api source', () => {
    setState(db, 'backfill_paused', '1', 'api');
    expect(changes()[0]!.source).toBe('api');
    expect(changes()[0]!.detail).toContain('"actor":"api"');
  });

  it('records a cleared flag with a null destination', () => {
    setState(db, 'delta_requested', '1');
    clearState(db, 'delta_requested');
    const rows = changes();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.detail).toContain('"to":null');
    expect(getState(db, 'delta_requested')).toBeNull();
  });

  it('is silent when clearing a key that was never set', () => {
    clearState(db, 'delta_retry_at');
    expect(changes()).toHaveLength(0);
  });
});
