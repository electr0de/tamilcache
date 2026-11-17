import { pathToFileURL } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { topics, variants } from '@tamilcache/db/schema';
import { replayAll } from './replay.js';
import { selectPreferredAcrossTitles } from './select.js';
import { runProviderPass } from './provider-pass.js';
import { TmdbClient } from './tmdb.js';

export interface RescoreOptions {
  limit?: number;
  dryRun?: boolean;
}
export interface RescoreSummary {
  scanned: number;
  matched: number;
  stillStuck: number;
  dryRun: boolean;
}

/**
 * One-shot repair for rows parked in review under the old parser.
 *
 * It invents no new code path: it clears `provider_checked_at` for topics whose variants are still
 * `unknown` and lets `runProviderPass` re-resolve them with the corrected scoring, in `limit`-sized
 * batches so TMDB is never hammered. Dry-run is the default.
 */
export async function rescore(db: Db, tmdb: TmdbClient | null, options: RescoreOptions = {}): Promise<RescoreSummary> {
  const parked = db
    .select({ id: topics.id })
    .from(topics)
    .innerJoin(variants, eq(variants.topicId, topics.id))
    .where(eq(variants.decision, 'unknown'))
    .groupBy(topics.id)
    .all();

  if (options.dryRun !== false) {
    return { scanned: parked.length, matched: 0, stillStuck: parked.length, dryRun: true };
  }
  if (parked.length === 0) return { scanned: 0, matched: 0, stillStuck: 0, dryRun: false };

  db.update(topics)
    .set({ providerCheckedAt: null })
    .where(inArray(topics.id, parked.map((row) => row.id)))
    .run();

  const pass = await runProviderPass(db, tmdb, { limit: options.limit ?? 25 });
  replayAll(db);
  selectPreferredAcrossTitles(db);
  return { scanned: parked.length, matched: pass.matched, stillStuck: parked.length - pass.matched, dryRun: false };
}

// `node dist/rescore.js [--apply]` — dry run unless `--apply` is passed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = createDb(process.env['DB_PATH'] ?? './data/tamilcache.db');
  migrate(db);
  const tmdbKey = process.env['TMDB_API_KEY']?.trim() ?? '';
  const tmdb = tmdbKey ? new TmdbClient({ apiKey: tmdbKey }) : null;
  const dryRun = !process.argv.includes('--apply');
  rescore(db, tmdb, { dryRun })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
