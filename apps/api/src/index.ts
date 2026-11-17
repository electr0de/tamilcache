import { openDb } from '@tamilcache/db';
import { resolveApiKey } from './apikey.js';
import { buildApp } from './server.js';

const port = Number(process.env['PORT'] ?? 8484);
// Loopback by default: this is a personal indexer, and binding 0.0.0.0 by default silently
// exposes the review queue, crawl controls and (with bootstrap) the API key to the LAN.
const host = process.env['HOST'] ?? '127.0.0.1';
const dbPath = process.env['DB_PATH'] ?? './data/tamilcache.db';

const db = openDb(dbPath);
const { key: apiKey, source: keySource } = resolveApiKey(db);
const app = buildApp({
  db,
  apiKey,
  bestVariantOnly: process.env['BEST_VARIANT_ONLY'] === 'true',
  // Deliberately absent when unset: the feed origin then follows the request's Host, which is
  // the only value a container client can actually reach. Pinning localhost here silently
  // produced grab links pointing at the *client's own* localhost.
  ...(process.env['SELF_ORIGIN']?.trim() ? { selfOrigin: process.env['SELF_ORIGIN']?.trim() } : {}),
  logger: true,
  dataDir: process.env['DATA_DIR'] ?? './data',
});

await app.listen({ port, host });

const origin = process.env['SELF_ORIGIN'] ?? `http://localhost:${port}`;
app.log.info({ keySource, host }, `torznab endpoint: ${origin}/api/v1`);
if (host !== '127.0.0.1' && host !== 'localhost') {
  app.log.warn({ host }, 'bound to a non-loopback address: bootstrap stays loopback-only unless ALLOW_BOOTSTRAP=true');
}
// Logged once so the key is discoverable from `docker logs` without opening the UI. It is also
// on the Settings page and in the database; this is a personal, localhost-only indexer.
app.log.info(`torznab api key: ${apiKey}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      db.$client.close();
      process.exit(0);
    });
  });
}
