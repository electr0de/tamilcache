#!/usr/bin/env node
/**
 * Reset the crawl cache without touching taught data.
 *
 *   pnpm db:reset --yes            # uses DB_PATH / ./data/tamilcache.db
 *   pnpm db:reset --yes /path/db
 *
 * Deletes everything the crawler created (topics, variants, links, episodes, metadata cache,
 * queue, runs, backfill cursors, logs) and every `app_state` flag except the Torznab key.
 * Keeps `sources`, `forums`, `media`, `rules` and `overrides`: the first two are re-seeded at
 * boot, and the last three are expensive or human decisions a crawl cannot recover.
 *
 * Stop api and worker first — both hold this file open in WAL mode.
 */
import { existsSync } from 'node:fs';
// Resolved by path on purpose: a root-level script has no workspace link to the package, and this
// must work straight from a checkout after `pnpm build`.
const { openDb } = await import(new URL('../packages/db/dist/index.js', import.meta.url));

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const path = args.find((arg) => !arg.startsWith('--')) ?? process.env['DB_PATH'] ?? './data/tamilcache.db';

const CLEARED = [
  'links',
  'variants',
  'topics',
  'media_episodes',
  'metadata_cache',
  'crawl_tasks',
  'crawl_runs',
  'backfill_state',
  'log_events',
];
const KEPT = ['sources', 'forums', 'media', 'rules', 'overrides'];

if (!yes) {
  console.error(`refusing to wipe ${path} without --yes`);
  process.exit(2);
}
if (!existsSync(path)) {
  console.error(`no database at ${path}`);
  process.exit(2);
}

const db = openDb(path);
const client = db.$client;

const count = (table) => client.prepare(`SELECT count(*) AS c FROM "${table}"`).get().c;
const snapshot = () => {
  const rows = {};
  for (const table of [...CLEARED, ...KEPT]) rows[table] = count(table);
  rows['app_state'] = count('app_state');
  return rows;
};

const before = snapshot();

client.exec('BEGIN IMMEDIATE');
try {
  for (const table of CLEARED) client.exec(`DELETE FROM "${table}"`);
  client.exec(`DELETE FROM app_state WHERE key <> 'torznab_api_key'`);
  client.exec('COMMIT');
} catch (error) {
  client.exec('ROLLBACK');
  throw error;
}

const after = snapshot();

console.log('table            before   after');
for (const table of Object.keys(before)) {
  const flag = before[table] !== after[table] ? ' *' : '  ';
  console.log(`${table.padEnd(16)} ${String(before[table]).padStart(6)} ${String(after[table]).padStart(6)}${flag}`);
}
console.log('\nkept:', KEPT.join(', '), '+ app_state.torznab_api_key');
client.close();
