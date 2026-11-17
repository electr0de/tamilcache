import { sql } from 'drizzle-orm';
import type { Db } from '@tamilcache/db';
import { renderCapsXml } from '@tamilcache/shared';
import { search } from './queries.js';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function count(db: Db, query: ReturnType<typeof sql>): number {
  const row = db.get<{ n: number }>(query) ?? { n: 0 };
  return Number(row.n ?? 0);
}

/**
 * Layer-4 verification: invariants that must never be violated, expressed as SQL so they are
 * cheap to run against a 100k-row database and impossible to satisfy accidentally.
 */
export function runChecks(db: Db): CheckResult[] {
  const results: CheckResult[] = [];

  const orphans = count(db, sql`SELECT count(*) AS n FROM variants v LEFT JOIN topics t ON t.id = v.topic_id WHERE t.id IS NULL`);
  results.push({ name: 'no orphan variants', pass: orphans === 0, detail: `${orphans} row(s)` });

  // The same torrent is cross-posted across language forums, so duplicate `infohash` rows are
  // expected in the table; what must never happen is emitting them more than once. This checks
  // the serialiser's actual output rather than a schema invariant that cannot hold.
  const searchOutput = search(db, { limit: 500, offset: 0, bestVariantOnly: false });
  const uniqueHashes = new Set(searchOutput.map((row) => row.infohash));
  results.push({
    name: 'duplicate infohashes collapsed at emit',
    pass: uniqueHashes.size === searchOutput.length,
    detail: `${searchOutput.length} item(s), ${uniqueHashes.size} unique infohash(es)`,
  });

  // A Hindi decision must be backed by either a Hindi audio token or provider data.
  const unbacked = count(db, sql`
    SELECT count(*) AS n FROM variants v
    LEFT JOIN media m ON m.id = v.media_id
    WHERE v.decision = 'hindi_dubbed'
      AND v.audio_langs NOT LIKE '%hindi%'
      AND (m.original_language IS NULL OR m.original_language <> 'hi')`);
  results.push({ name: 'hindi_dubbed decisions have evidence', pass: unbacked === 0, detail: `${unbacked} unbacked row(s)` });

  const originalUnbacked = count(db, sql`
    SELECT count(*) AS n FROM variants v
    LEFT JOIN media m ON m.id = v.media_id
    WHERE v.decision = 'hindi_original' AND (m.original_language IS NULL OR m.original_language <> 'hi')`);
  results.push({ name: 'hindi_original decisions come from the provider', pass: originalUnbacked === 0, detail: `${originalUnbacked} unbacked row(s)` });

  const noHash = count(db, sql`SELECT count(*) AS n FROM variants WHERE infohash IS NULL OR length(infohash) <> 40`);
  results.push({ name: 'every variant has a 40-char infohash', pass: noHash === 0, detail: `${noHash} bad row(s)` });

  const unknownSource = count(db, sql`SELECT count(*) AS n FROM variants WHERE decision IN ('hindi_dubbed','hindi_original') AND source_tag = 'UNKNOWN'`);
  results.push({ name: 'no emitted variant with an unmapped source', pass: unknownSource === 0, detail: `${unknownSource} row(s)` });

  const checkedNone = count(db, sql`SELECT count(*) AS n FROM topics WHERE provider_status = 'none'`);
  const checkedAmbiguous = count(db, sql`SELECT count(*) AS n FROM topics WHERE provider_status = 'ambiguous'`);
  const checkedMatched = count(db, sql`SELECT count(*) AS n FROM topics WHERE provider_status = 'matched'`);
  const pendingCheck = count(db, sql`SELECT count(*) AS n FROM topics WHERE provider_checked_at IS NULL`);
  results.push({
    name: 'provider pass progress',
    pass: true,
    detail: `${checkedMatched} matched, ${checkedAmbiguous} ambiguous, ${checkedNone} none, ${pendingCheck} pending`,
  });

  // A matched topic whose variants were never pointed at the media row would silently lose both
  // the Hindi-original decision and the episode coverage.
  const unlinked = count(db, sql`
    SELECT count(*) AS n FROM topics t
    JOIN variants v ON v.topic_id = t.id
    WHERE t.provider_status = 'matched' AND v.media_id IS NULL`);
  results.push({ name: 'matched topics have media attached to their variants', pass: unlinked === 0, detail: `${unlinked} row(s)` });

  const orphanEpisodes = count(db, sql`
    SELECT count(*) AS n FROM media_episodes e LEFT JOIN media m ON m.id = e.media_id WHERE m.id IS NULL`);
  results.push({ name: 'no orphan episodes', pass: orphanEpisodes === 0, detail: `${orphanEpisodes} row(s)` });

  // `SELECT count(*) FROM variants_fts` is useless here: an external-content table reads its
  // rows straight out of the content table, so it can never disagree. `integrity-check` with a
  // non-zero *second* argument (rank) is the probe that compares the index against its content —
  // the plain form only validates internal structure and passes even when rows are missing.
  const variantCount = count(db, sql`SELECT count(*) AS n FROM variants`);
  let indexOk = true;
  let indexError = '';
  try {
    db.run(sql`INSERT INTO variants_fts(variants_fts, rank) VALUES('integrity-check', 1)`);
  } catch (error) {
    indexOk = false;
    indexError = error instanceof Error ? error.message : String(error);
  }
  results.push({
    name: 'search index matches the variants table',
    pass: indexOk,
    detail: indexOk ? `${variantCount} variant(s) indexed` : `integrity-check failed: ${indexError}`,
  });

  const caps = renderCapsXml();
  const capsOk = caps.includes('id="2040"') && caps.includes('id="5030"');
  results.push({ name: 'caps declares 2040 and 5030', pass: capsOk, detail: capsOk ? 'ok' : 'missing category' });

  const capsHonest = !caps.includes('tvdbid');
  results.push({
    name: 'caps advertises only ids we can resolve',
    pass: capsHonest,
    detail: capsHonest ? 'no tvdbid (TMDB returns null for regional shows)' : 'tvdbid advertised but usually unavailable',
  });

  const emitted = count(db, sql`SELECT count(*) AS n FROM variants WHERE decision IN ('hindi_dubbed','hindi_original')`);
  const review = count(db, sql`SELECT count(*) AS n FROM variants WHERE decision = 'unknown'`);
  results.push({
    name: 'indexer population',
    pass: emitted > 0,
    detail: `${emitted} emitted, ${review} awaiting review`,
  });

  return results;
}

export function printChecks(results: CheckResult[]): boolean {
  let failed = 0;
  for (const result of results) {
    const mark = result.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${result.name.padEnd(48)} ${result.detail}`);
    if (!result.pass) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed === 0;
}

if (process.argv[1]?.endsWith('verify.js')) {
  const { openDb } = await import('@tamilcache/db');
  const db = openDb(process.env['DB_PATH'] ?? './data/tamilcache.db');
  const ok = printChecks(runChecks(db));
  process.exit(ok ? 0 : 1);
}
