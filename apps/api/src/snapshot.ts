/**
 * Move a database in and out of a deployment — without ever publishing one.
 *
 * `export` uses `VACUUM INTO`, the only way to take a consistent copy of a live WAL database
 * without stopping the worker: one statement writes a fresh, fully-checkpointed file.
 * `import` refuses anything it cannot prove is sane: a file that is not a database, a schema from
 * a newer build, or an overwrite of a database that already holds data (unless `--force`).
 */
import { createGunzip, createGzip } from 'node:zlib';
import {
  chownSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeDb, openDb, type Db } from '@tamilcache/db';

/** Cleared on export unless `--keep-secrets`: a credential and two provider quota counters. */
const SCRUB_STATE_KEYS = ['torznab_api_key', 'tvdb_token', 'omdb_used_today', 'omdb_used_date'];

export interface ExportOptions {
  keepSecrets?: boolean;
}

export async function exportSnapshot(
  livePath: string,
  outPath: string,
  options: ExportOptions,
): Promise<void> {
  // openDb() creates a missing database. Exporting would then "succeed" with an empty file, and
  // the mistake surfaces only when someone tries to restore it.
  if (!existsSync(livePath)) {
    throw new Error(`database ${livePath} does not exist — check DB_PATH`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const copy = `${outPath}.partial.db`;
  rmSync(copy, { force: true });

  const live = openDb(livePath);
  try {
    // Single-quote escaping: VACUUM INTO takes a literal, not a bound parameter.
    live.$client.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  } finally {
    closeDb(live);
  }

  const staged = openDb(copy);
  try {
    staged.run(sql`DELETE FROM log_events`);
    if (!options.keepSecrets) {
      for (const key of SCRUB_STATE_KEYS) {
        staged.run(sql`DELETE FROM app_state WHERE key = ${key}`);
      }
    }
    staged.$client.exec('VACUUM');
  } finally {
    closeDb(staged);
  }

  const partial = `${outPath}.partial.gz`;
  await pipeline(createReadStream(copy), createGzip({ level: 9 }), createWriteStream(partial));
  rmSync(copy, { force: true });
  renameSync(partial, outPath);
}

export interface ImportOptions {
  force?: boolean;
}

function removeSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${dbPath}${suffix}`, { force: true });
}

function countVariants(db: Db): number {
  return Number(db.get<{ n: number }>(sql`SELECT count(*) AS n FROM variants`)?.n ?? 0);
}

/**
 * Download to a file with plain `node:http(s)`.
 *
 * Deliberately not `fetch` + `Readable.fromWeb`: on Node 24 that combination trips an internal
 * undici assertion (`assert(!this.paused)` in `Parser.finish`) and kills the process mid-restore.
 * Redirects are followed by hand because every release-asset URL redirects at least once.
 */
async function download(url: string, dest: string, hops = 0): Promise<void> {
  if (hops > 5) throw new Error('download failed: too many redirects');
  const target = new URL(url);
  const get = target.protocol === 'https:' ? httpsGet : httpGet;

  await new Promise<void>((resolve, reject) => {
    const request = get(target, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        void download(new URL(location, target).toString(), dest, hops + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`download failed: HTTP ${status}`));
        return;
      }
      void pipeline(response, createWriteStream(dest)).then(() => resolve(), reject);
    });
    request.on('error', reject);
  });
}

export async function importSnapshot(
  source: string | URL,
  targetPath: string,
  options: ImportOptions,
): Promise<void> {
  mkdirSync(dirname(targetPath), { recursive: true });
  const gz = `${targetPath}.incoming.gz`;
  const staged = `${targetPath}.incoming.db`;
  rmSync(gz, { force: true });
  rmSync(staged, { force: true });

  try {
    if (/^https?:\/\//i.test(String(source))) {
      await download(String(source), gz);
    } else {
      await pipeline(createReadStream(String(source)), createWriteStream(gz));
    }
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(staged));

    // openDb() is the gate: it throws on a corrupt file, refuses a newer schema, and runs the
    // upgrade ladder for an older one — so an import of an old snapshot lands ready to boot.
    let incoming: Db | null = null;
    let rows = 0;
    try {
      incoming = openDb(staged);
      const check = incoming.$client.prepare('PRAGMA integrity_check').get() as
        | Record<string, string>
        | undefined;
      if (Object.values(check ?? {})[0] !== 'ok') throw new Error('integrity check failed');
      rows = countVariants(incoming);
    } finally {
      if (incoming) closeDb(incoming);
    }

    if (existsSync(targetPath) && !options.force) {
      const existing = openDb(targetPath);
      let existingRows = 0;
      try {
        existingRows = countVariants(existing);
      } finally {
        closeDb(existing);
      }
      if (existingRows > 0) {
        throw new Error(`target already holds ${existingRows} variant(s); pass --force to replace it`);
      }
    }

    // A WAL left beside a database that was swapped underneath it is applied on the next open:
    // SQLite does not check that the WAL belongs to the file next to it. The import would look
    // successful while the previous contents came back. Same for `-shm` and a rollback journal.
    removeSidecars(targetPath);
    renameSync(staged, targetPath);
    removeSidecars(targetPath);
    console.log(`imported ${rows} variant(s) into ${targetPath}`);
  } finally {
    rmSync(gz, { force: true });
    rmSync(staged, { force: true });
  }
}

/**
 * The tool may run as root (it is the one service that has to be able to repair /data). Anything it
 * creates must still end up owned by PUID:PGID, or the API — which drops privileges — cannot write
 * the database it just imported.
 */
function handBackOwnership(path: string): void {
  const uid = Number(process.env['PUID'] ?? Number.NaN);
  const gid = Number(process.env['PGID'] ?? Number.NaN);
  if (process.getuid?.() !== 0 || Number.isNaN(uid) || Number.isNaN(gid)) return;
  try {
    chownSync(path, uid, gid);
  } catch {
    // A read-only mount or an unmapped id: the next `up` fixes it, and a backup that cannot be
    // chowned is still a usable backup.
  }
}

// `import.meta.url` is percent-encoded and argv[1] is not: a hand-built `file://` prefix silently
// turns the CLI into a no-op whenever the checkout path contains a space.
/**
 * Flags are parsed out before positionals. Taking `argv[2]` as the source path meant
 * `snapshot export --keep-secrets` wrote a file literally named `--keep-secrets`.
 */
export interface SnapshotArgs {
  // `exactOptionalPropertyTypes`: the undefined has to be in the type, not just implied.
  command?: string | undefined;
  source?: string | undefined;
  keepSecrets: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): SnapshotArgs {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const [command, source] = argv.filter((arg) => !arg.startsWith('--'));
  return {
    command,
    source,
    keepSecrets: flags.includes('--keep-secrets'),
    force: flags.includes('--force'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { command, source, keepSecrets, force } = parseArgs(process.argv.slice(2));
  const dbPath = process.env['DB_PATH'] ?? '/data/tamilcache.db';
  const dataDir = process.env['DATA_DIR'] ?? '/data';

  // A refusal here is a normal, documented outcome (`already holds N variants`, `newer than this
  // build`), not a crash: print one line and exit 1 rather than dumping a stack trace at a user
  // mid-restore.
  try {
    if (command === 'export') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const out = source ?? `${dataDir}/backups/tamilcache-${stamp}.db.gz`;
      await exportSnapshot(dbPath, out, { keepSecrets });
      handBackOwnership(out);
      console.log(`exported ${out}`);
    } else if (command === 'import') {
      if (!source) {
        console.error('usage: snapshot import <path-or-url> [--force]');
        process.exit(2);
      }
      await importSnapshot(source, dbPath, { force });
      handBackOwnership(dbPath);
    } else {
      console.error('usage: snapshot <export|import> [source] [--force] [--keep-secrets]');
      process.exit(2);
    }
  } catch (error) {
    console.error(`snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
