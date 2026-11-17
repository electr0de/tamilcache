import { randomBytes } from 'node:crypto';
import type { Db } from '@tamilcache/db';
import { appState } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';

export interface ResolvedKey {
  key: string;
  source: 'env' | 'generated' | 'stored';
}

const STATE_KEY = 'torznab_api_key';

function read(db: Db): string | null {
  return db.select().from(appState).where(eq(appState.key, STATE_KEY)).get()?.value ?? null;
}

function write(db: Db, key: string): void {
  db.insert(appState)
    .values({ key: STATE_KEY, value: key })
    .onConflictDoUpdate({ target: appState.key, set: { value: key } })
    .run();
}

/**
 * The key is never something the user has to invent.
 *
 * Resolution order: an explicit `TORZNAB_API_KEY` (an override for anyone who wants one) →
 * the key already stored in this database → a freshly generated 48-char hex key, persisted so
 * it survives restarts. It is shown in the UI's Settings page (loopback only) and logged once
 * at boot, so pasting it into Radarr never requires reading a file.
 */
export function resolveApiKey(db: Db, env: NodeJS.ProcessEnv = process.env): ResolvedKey {
  const fromEnv = env['TORZNAB_API_KEY']?.trim();
  if (fromEnv) {
    if (env['NODE_ENV'] === 'production' && fromEnv === 'devkey') {
      throw new Error('TORZNAB_API_KEY is the documentation value "devkey"; unset it to let the app generate one');
    }
    write(db, fromEnv);
    return { key: fromEnv, source: 'env' };
  }

  const stored = read(db);
  if (stored) return { key: stored, source: 'stored' };

  const generated = randomBytes(24).toString('hex');
  write(db, generated);
  return { key: generated, source: 'generated' };
}
