import { pathToFileURL } from 'node:url';
export * from './replay.js';
export * from './http-client.js';
export * from './queue.js';
export * from './persist.js';
export * from './crawl.js';
export * from './config.js';
export * from './state.js';
export * from './tmdb.js';
export * from './omdb.js';
export * from './tvdb.js';
export * from './provider-pass.js';
export * from './rescore.js';
export * from './select.js';

// Guard against a container (or a stale compose file) pointed at the barrel: the module would
// re-export and exit 0, leaving a healthy-looking API with an empty queue and no error anywhere.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('[worker] dist/index.js is the package barrel, not the program. Run dist/main.js.');
  process.exit(1);
}
