#!/usr/bin/env node
/**
 * Fail if this tree contains something that must not be published: a torrent, a database, an
 * infohash that is not a documented synthetic one, a tracker URL, or agent/planning material that
 * was meant to stay private.
 *
 *   pnpm check:leaks            # the whole tracked tree (what CI runs)
 *   pnpm check:leaks <dir>
 *
 * The infohash allowlist is `packages/shared/test/fixtures/synthetic-hashes.json`, written by
 * `pnpm sanitize:fixtures`. Keeping it a file (rather than re-deriving it here) means a reviewer
 * can see exactly which hashes are permitted, and a new capture cannot slip one in silently.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALLOWLIST_PATH, newAllowlist } from './sanitize-fixtures.mjs';

const FORBIDDEN_FILES = [
  [/\.torrent$/i, 'torrent-file'],
  // `*.db.gz` is exactly what `snapshot export` produces — binary, so the text scan below cannot
  // see a magnet inside it either. The extension has to be caught.
  [/\.(db|sqlite|sqlite3)(\.gz)?$/i, 'database-file'],
  [/\.(db|sqlite|sqlite3)-(wal|shm|journal)$/i, 'database-file'],
];

/**
 * Magic bytes, because a filename is not a promise. A gzip blob (what `snapshot export` writes) or a
 * SQLite file under any name — `--keep-secrets`, `backup`, `data` — is the same leak.
 */
const BINARY_MAGIC = [
  [Buffer.from([0x1f, 0x8b]), 'database-file'], // gzip
  [Buffer.from('SQLite format 3\0', 'latin1'), 'database-file'],
  [Buffer.from('d8:announce', 'latin1'), 'torrent-file'], // bencoded torrent, first key
];

const FORBIDDEN_PATHS = [/^AGENTS\.md$/, /^\.pi\//, /^graphify-out\//, /^docs\/plans\//];

/**
 * The gate's own test has to contain the shapes it rejects — that is what it is testing. Content
 * rules skip it; file-name and private-path rules still apply, so it cannot be used to smuggle a
 * database or a plan document in.
 */
const CONTENT_EXEMPT = new Set(['packages/shared/test/check-leaks.test.ts']);

/**
 * Both magnet forms are resolvable, so both are leaks.
 *
 *  - 40 hex characters, or the 32-character base32 encoding of the same 20 bytes;
 *  - `urn:BTIH:` is legal and appears in the wild, so the prefix is case-insensitive.
 *
 * The 40-hex alternative comes first deliberately: `[A-Za-z2-7]{32}` would otherwise match the
 * first 32 characters of a hex hash and leave the rest looking legitimate. The trailing lookahead
 * stops a partial match inside a longer token.
 */
const HASH_RE = /urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})(?![A-Za-z0-9])/gi;

/**
 * A bare `announce` word is common in bencode, so a tracker only counts when it is a URL — and
 * only when the host is real. `tracker.example`, `localhost` and friends are documentation
 * hosts that cannot resolve, which is exactly what the tests use.
 */
const TRACKER_URL_RE = /(?:udp:\/\/|&tr=https?:\/\/|announce:\s*https?:\/\/)([^/\s"'&]+)/gi;
const RESERVED_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|(?:[\w-]+\.)*example(?:\.(?:com|net|org))?)(?::\d+)?$/i;

/**
 * `import.meta.url` is percent-encoded; `process.argv[1]` is a raw path. Comparing them with a
 * hand-built `file://` prefix fails for any checkout path containing a space (or `#`, `%`), and
 * the CLI then silently does nothing and exits 0 — a gate that passes because it never ran.
 */
export function isMain(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

/** Base32 (RFC 4648, no padding) → lowercase hex. Returns '' if the input is not base32. */
function fromBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const char of value.toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) return '';
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes).toString('hex');
}

export function gitTracked(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

export function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return newAllowlist();
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
}

export function findLeaks(root, files, allowed) {
  const leaks = [];
  for (const file of files) {
    for (const [re, rule] of FORBIDDEN_FILES) {
      if (re.test(file)) leaks.push({ file, rule, detail: 'must not be tracked' });
    }
    for (const re of FORBIDDEN_PATHS) {
      if (re.test(file)) leaks.push({ file, rule: 'private-material', detail: 'must not be tracked' });
    }
    if (CONTENT_EXEMPT.has(file)) continue;
    let raw;
    try {
      raw = readFileSync(join(root, file));
    } catch {
      continue; // deleted-but-indexed
    }
    const magic = BINARY_MAGIC.find(([bytes]) => raw.subarray(0, bytes.length).equals(bytes));
    if (magic) {
      leaks.push({ file, rule: magic[1], detail: 'content, not name' });
      continue;
    }
    const body = raw.toString('utf8');
    for (const match of body.matchAll(HASH_RE)) {
      const token = match[1];
      // A base32 magnet is the same 20 bytes as its hex form, so compare it as hex: a synthetic
      // hash's base32 encoding is legitimate in a fixture that documents it.
      const hex = token.length === 32 ? fromBase32(token) : token.toLowerCase();
      if (!allowed.has(hex)) leaks.push({ file, rule: 'real-infohash', detail: token });
    }
    for (const match of body.matchAll(TRACKER_URL_RE)) {
      if (!RESERVED_HOST.test(match[1])) {
        leaks.push({ file, rule: 'tracker-url', detail: match[0] });
        break;
      }
    }
  }
  return leaks;
}

if (isMain(import.meta.url, process.argv[1])) {
  const root = process.argv[2] ?? process.cwd();
  const allowed = new Set(loadAllowlist().hashes);
  const leaks = findLeaks(root, gitTracked(root), allowed);
  if (leaks.length > 0) {
    for (const leak of leaks) console.error(`${leak.rule}: ${leak.file} (${leak.detail})`);
    console.error(`\n${leaks.length} leak(s) — this tree must not be published.`);
    process.exit(1);
  }
  console.log('check:leaks — clean');
}
