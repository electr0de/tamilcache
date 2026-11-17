import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLeaks, gitTracked, isMain, loadAllowlist } from '../../../scripts/check-leaks.mjs';
import { SYNTHETIC_INFOHASH } from './fixtures/synthetic-torrent.js';

const REAL = 'magnet:?xt=urn:btih:b98bb8d75328cda2ea68d9658f6e96230c4fc81b&dn=x';

function tree(files: Record<string, string>): { dir: string; names: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'leaks-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { dir, names: Object.keys(files) };
}

describe('findLeaks', () => {
  it('flags a real infohash in a tracked file', () => {
    const { dir, names } = tree({ 'page.html': `<a href="${REAL}">x</a>` });
    expect(findLeaks(dir, names, new Set()).map((l) => l.rule)).toContain('real-infohash');
    rmSync(dir, { recursive: true });
  });

  // Both forms below are resolvable magnets that the original 40-hex-only scan reported as clean.
  it('flags a base32 infohash (32 characters)', () => {
    // A base32 magnet is the same 20 bytes as its hex form — a resolvable link either way.
    const { dir, names } = tree({ 'page.html': 'magnet:?xt=urn:btih:YJ6XA5DXOBTWC7DOZQPRYPCQBE5WUOOO' });
    expect(findLeaks(dir, names, new Set()).map((l) => l.rule)).toContain('real-infohash');
    rmSync(dir, { recursive: true });
  });

  it('accepts the base32 form of an allowlisted synthetic hash', () => {
    const { dir, names } = tree({ 'page.html': 'magnet:?xt=urn:btih:ZHJYLXDRLDLU64FXGPYXVDAN32NWONL4' });
    expect(findLeaks(dir, names, new Set([SYNTHETIC_INFOHASH]))).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  it('flags an uppercase URN prefix', () => {
    const { dir, names } = tree({ 'page.html': `magnet:?xt=urn:BTIH:${'a'.repeat(40)}` });
    expect(findLeaks(dir, names, new Set()).map((l) => l.rule)).toContain('real-infohash');
    rmSync(dir, { recursive: true });
  });

  it('flags a database by content, whatever it is called', () => {
    // A gzip blob named `--keep-secrets` (a CLI mis-parse) reached `git add -A` once. Extension
    // rules cannot see that; the magic bytes can.
    const { dir } = tree({});
    writeFileSync(join(dir, '--keep-secrets'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    writeFileSync(join(dir, 'backup'), Buffer.from('SQLite format 3\0', 'latin1'));
    writeFileSync(join(dir, 'blob'), Buffer.from('d8:announce22:http://tracker.example', 'latin1'));
    const rules = findLeaks(dir, ['--keep-secrets', 'backup', 'blob'], new Set()).map((l) => l.rule);
    expect(rules).toContain('database-file');
    expect(rules).toContain('torrent-file');
    rmSync(dir, { recursive: true });
  });

  it('flags an exported snapshot archive and other database suffixes', () => {
    const { dir, names } = tree({ 'a.db.gz': '', 'b.sqlite3': '', 'c.db-journal': '' });
    const rules = findLeaks(dir, names, new Set()).map((l) => l.rule);
    expect(rules.filter((r) => r === 'database-file')).toHaveLength(3);
    rmSync(dir, { recursive: true });
  });

  it('allows a documented synthetic hash', () => {
    const { dir, names } = tree({ 'page.html': `magnet:?xt=urn:btih:${SYNTHETIC_INFOHASH}` });
    expect(findLeaks(dir, names, new Set([SYNTHETIC_INFOHASH]))).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  it('flags a torrent, a database and its WAL sidecars', () => {
    const { dir, names } = tree({ 'x.torrent': 'd4:infod4:name0:ee', 'x.db': '', 'x.db-wal': '' });
    const rules = findLeaks(dir, names, new Set()).map((l) => l.rule);
    expect(rules).toContain('torrent-file');
    expect(rules).toContain('database-file');
    rmSync(dir, { recursive: true });
  });

  it('flags a real tracker URL', () => {
    const { dir, names } = tree({ 'a.html': 'announce: udp://tracker.opentrackr.org:1337/announce' });
    expect(findLeaks(dir, names, new Set()).map((l) => l.rule)).toContain('tracker-url');
    rmSync(dir, { recursive: true });
  });

  it('ignores a documentation tracker host, which cannot resolve', () => {
    const { dir, names } = tree({ 'a.md': 'trackers: [udp://tracker.example:1337/announce]' });
    expect(findLeaks(dir, names, new Set())).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  it('flags agent material that was meant to stay private', () => {
    const { dir, names } = tree({ 'AGENTS.md': 'notes', 'docs/plans/x-design.md': 'plan' });
    const rules = findLeaks(dir, names, new Set()).map((l) => l.rule);
    expect(rules.filter((r) => r === 'private-material')).toHaveLength(2);
    rmSync(dir, { recursive: true });
  });

  it('recognises itself as the entrypoint even when its path contains a space', () => {
    // The guard was `import.meta.url === `file://${argv[1]}``. import.meta.url is percent-encoded
    // and argv[1] is not, so from a checkout under "…/leak gate/" the whole CLI was a no-op that
    // exited 0 with no output — a gate that silently passes.
    expect(isMain('file:///tmp/leak%20gate/check-leaks.mjs', '/tmp/leak gate/check-leaks.mjs')).toBe(true);
    expect(isMain('file:///tmp/plain/check-leaks.mjs', '/tmp/plain/check-leaks.mjs')).toBe(true);
    expect(isMain('file:///tmp/plain/check-leaks.mjs', undefined)).toBe(false);
    expect(isMain('file:///tmp/plain/check-leaks.mjs', '/tmp/other.mjs')).toBe(false);
  });

  it('passes on this repository', () => {
    const root = join(import.meta.dirname, '../../..');
    expect(findLeaks(root, gitTracked(root), new Set(loadAllowlist().hashes))).toHaveLength(0);
  });
});
