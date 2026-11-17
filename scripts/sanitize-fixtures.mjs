#!/usr/bin/env node
/**
 * Rewrite every captured forum page so the published fixtures cannot be used to download
 * anything, while staying byte-shaped like the pages the parser was written against.
 *
 * What changes:
 *   - `urn:btih:<40 hex>`          → a synthetic hash minted from it, recorded in the allowlist
 *   - `attachment.php?id=&key=`    → a synthetic id and a synthetic 32-hex key
 *   - shortener/stream/Drive URLs  → the last path token, same length and character class
 *
 * What must NOT change: hostnames (`links.kind` is classified by host), path structure
 * (`cyberloom.best/l/<id>`), forum topic URLs, release names, quality blocks, sizes and the post
 * structure — the parser is tested against all of it.
 *
 * Idempotent: a hash already in the allowlist is left alone, so a second run produces no diff.
 *
 *   pnpm sanitize:fixtures            # rewrite packages/shared/test/fixtures/*.html
 *   pnpm sanitize:fixtures <dir>
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The synthetic torrent blob's own hash (`test/fixtures/synthetic-torrent.ts`) is legitimate. */
export const TORRENT_FIXTURE_HASH = 'c9d385dc7158d74f70b733f17a8c0dde9b67357c';

export const ALLOWLIST_PATH = join(
  import.meta.dirname,
  '..',
  'packages',
  'shared',
  'test',
  'fixtures',
  'synthetic-hashes.json',
);

/**
 * Hosts whose path carries a resolvable token. Kept in sync by hand with the SHORTENERS / STREAM /
 * GDRIVE sets in `packages/shared/src/links.ts` — a host missing here still gets its infohash
 * scrubbed, it just keeps a dead shortener token, and `pnpm check:leaks` cannot see either.
 */
const TOKEN_HOSTS = [
  'drive.google.com',
  'docs.google.com',
  'lulust.com',
  'luluvido.com',
  'luluvdo.com',
  'drakkar.st',
  'siteget.net',
  'freeproxy.io',
  'adrinolinks.in',
  'cyberloom.best',
  'bit.ly',
  'tinyurl.com',
  'ouo.io',
  'shrinke.me',
  'gplinks.co',
  'za.gl',
  'adf.ly',
  'shrinkme.io',
  'clicksfly.com',
  'urlshortx.com',
  'dood.to',
  'doodstream.com',
  'mp4upload.com',
];

const HASH_RE = /urn:btih:([0-9a-fA-F]{40})/g;
const ATTACH_RE = /(attachment\.php\?id=)(\d+)((?:&amp;|&)key=)([0-9a-fA-F]{32})/gi;
const TOKEN_HOST_RE = new RegExp(
  `https?://(?:[\\w-]+\\.)*(?:${TOKEN_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})/[^\\s"'<>)]*`,
  'gi',
);

const sha1 = (value) => createHash('sha1').update(value).digest('hex');

/** Deterministic hex token of a given length — for values a regex validates as `[0-9a-f]`. */
function hexTokenOf(value, length) {
  let out = '';
  for (let i = 0; out.length < length; i++) out += sha1(`tamilcache-fixture:${value}:${i}`);
  return out.slice(0, length);
}

/** Deterministic, same-length, same-character-class token: shape for the parser, nothing for a user. */
function tokenOf(original) {
  const bytes = Buffer.from(sha1(`tamilcache-fixture:${original}`), 'hex');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < original.length; i++) {
    const byte = bytes[i % bytes.length];
    const char = original[i];
    if (/[0-9]/.test(char)) out += String(byte % 10);
    else if (/[A-Z]/.test(char)) out += upper[byte % 26];
    else if (/[a-z]/.test(char)) out += alphabet[byte % 26];
    else out += char;
  }
  return out;
}

export function newAllowlist(hashes = [TORRENT_FIXTURE_HASH]) {
  return {
    _note:
      'Values that are provably synthetic: minted by scripts/sanitize-fixtures.mjs or built in ' +
      'code by test/fixtures/synthetic-torrent.ts. `pnpm check:leaks` fails on any infohash not ' +
      'listed here. The maps record each real value → the dead one that replaced it, which is ' +
      'what makes a second sanitize run a no-op.',
    hashes: [...new Set(hashes.map((h) => h.toLowerCase()))].sort(),
    tokens: {},
    attachments: {},
  };
}

/**
 * Replace `real` once and remember the decision. Without the memory, a second run would rewrite
 * its own synthetic value into a different one — the fixtures would churn on every run.
 */
function memoRewrite(allowlist, bucket, real, make) {
  const map = allowlist[bucket] ?? {};
  if (Object.values(map).includes(real)) return real; // already ours
  const synthetic = map[real] ?? make(real);
  allowlist[bucket] = { ...map, [real]: synthetic };
  return synthetic;
}

export function sanitizeContent(text, allowlist = newAllowlist()) {
  const allowed = new Set(allowlist.hashes);
  const mint = (real) => {
    const lower = real.toLowerCase();
    if (allowed.has(lower)) return lower;
    const synthetic = sha1(`tamilcache-fixture:${lower}`);
    allowed.add(synthetic);
    allowlist.hashes.push(synthetic);
    return synthetic;
  };

  let out = text.replace(HASH_RE, (_match, real) => `urn:btih:${mint(real)}`);

  out = out.replace(ATTACH_RE, (_match, prefix, id, middle, key) => {
    const newId = memoRewrite(allowlist, 'attachments', id, (real) =>
      String(100000 + (Number(`0x${sha1(`attachment:${real}`).slice(0, 8)}`) % 900000)),
    );
    const newKey = memoRewrite(allowlist, 'attachments', key, (real) => hexTokenOf(real, real.length));
    return `${prefix}${newId}${middle}${newKey}`;
  });

  out = out.replace(TOKEN_HOST_RE, (url) => {
    // The same link appears twice in these pages: as an anchor, and again inside a literal `\n`
    // escaped text block. The tail therefore may be ANY non-token character (`\`, `?`, `#`), not
    // just a query string — matching only `[?#]` silently left 13 real tokens in place.
    const match = url.match(/^(.*\/)([A-Za-z0-9_-]{4,})([^A-Za-z0-9_-].*)?$/);
    if (!match) return url;
    const [, head, token, tail = ''] = match;
    return `${head}${memoRewrite(allowlist, 'tokens', token, tokenOf)}${tail}`;
  });

  return out;
}

// Percent-encoding mismatch would make this a silent no-op in a path with a space.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? join(import.meta.dirname, '..', 'packages', 'shared', 'test', 'fixtures');
  const allowlist = existsSync(ALLOWLIST_PATH)
    ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
    : newAllowlist();
  const files = readdirSync(dir).filter((file) => file.endsWith('.html'));
  let changed = 0;
  for (const file of files) {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = sanitizeContent(before, allowlist);
    if (after !== before) {
      writeFileSync(path, after);
      changed++;
    }
  }
  allowlist.hashes = [...new Set(allowlist.hashes)].sort();
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(allowlist, null, 2)}\n`);
  console.log(`sanitized ${changed}/${files.length} fixture(s); ${allowlist.hashes.length} synthetic hash(es) allowed`);
}
