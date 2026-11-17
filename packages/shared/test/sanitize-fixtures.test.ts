import { describe, it, expect } from 'vitest';
import { sanitizeContent, newAllowlist } from '../../../scripts/sanitize-fixtures.mjs';
import { SYNTHETIC_INFOHASH } from './fixtures/synthetic-torrent.js';

/** Built, not written out: a 40-hex literal in the tree is exactly what `check:leaks` hunts for. */
const hex = (seed: number): string =>
  Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(seed * 7 + i * 3) % 16]).join('');

const REAL = `magnet:?xt=urn:btih:${hex(1)}&amp;dn=Some.Real.Release`;
const OTHER = `magnet:?xt=urn:btih:${hex(2)}`;

function run(text: string, allowlist = newAllowlist()) {
  return { out: sanitizeContent(text, allowlist), allowlist };
}

describe('sanitizeContent — infohashes', () => {
  it('replaces a real infohash with a synthetic one of the same length', () => {
    const { out } = run(REAL);
    const hash = out.match(/urn:btih:([0-9a-f]{40})/)?.[1];
    expect(hash).toBeDefined();
    expect(hash).not.toBe(hex(1));
  });

  it('is deterministic across runs', () => {
    expect(run(REAL).out).toBe(run(REAL).out);
  });

  it('maps two different real hashes to two different synthetic ones', () => {
    const allowlist = newAllowlist();
    const a = sanitizeContent(REAL, allowlist).match(/urn:btih:([0-9a-f]{40})/)?.[1];
    const b = sanitizeContent(OTHER, allowlist).match(/urn:btih:([0-9a-f]{40})/)?.[1];
    expect(a).not.toBe(b);
  });

  it('is idempotent: sanitizing its own output leaves it alone', () => {
    // Idempotence is a property of the file-backed run: the allowlist persists, so the hash the
    // first pass minted is recognised on the second. Same allowlist object = same on-disk file.
    const allowlist = newAllowlist();
    const once = sanitizeContent(REAL, allowlist);
    expect(sanitizeContent(once, allowlist)).toBe(once);
  });

  it('leaves an already-allowlisted synthetic hash untouched', () => {
    const known = SYNTHETIC_INFOHASH;
    expect(sanitizeContent(`magnet:?xt=urn:btih:${known}`, newAllowlist([known]))).toContain(known);
  });

  it('records every hash it mints in the allowlist', () => {
    const { out, allowlist } = run(REAL);
    const minted = out.match(/urn:btih:([0-9a-f]{40})/)?.[1];
    expect(allowlist.hashes).toContain(minted);
  });
});

describe('sanitizeContent — links', () => {
  it('keeps the hostname, because link classification is by host', () => {
    const { out } = run('<a href="https://adrinolinks.in/6sZ3q">x</a>');
    expect(out).toContain('adrinolinks.in');
  });

  it('replaces a shortener token with one of the same length that goes nowhere', () => {
    const { out } = run('<a href="https://adrinolinks.in/6sZ3q">x</a>');
    expect(out).not.toContain('6sZ3q');
    expect(out).toMatch(/adrinolinks\.in\/[A-Za-z0-9]{5}/);
  });

  it('rewrites a link inside an escaped \\n text block, not only inside an anchor', () => {
    // Real fixtures repeat every gate link as literal text: `... 4.85 GB \\n\\thttps://host/token\\n`
    const block = 'Audio - 4.85 GB \\n\\thttps://adrinolinks.in/ficTU\\n \\n';
    const { out } = run(block);
    expect(out).not.toContain('/ficTU');
    expect(out).toMatch(/adrinolinks\.in\/[A-Za-z0-9]{5}/);
  });

  it('keeps the path structure of a /l/<id> gate', () => {
    const { out } = run('<a href="https://www.cyberloom.best/l/PWKT876T">x</a>');
    expect(out).toMatch(/cyberloom\.best\/l\/[A-Za-z0-9]{8}/);
    expect(out).not.toContain('PWKT876T');
  });

  it('is idempotent for links too: a second pass does not re-mint a token', () => {
    const allowlist = newAllowlist();
    const page = '<a href="https://adrinolinks.in/6sZ3q">x</a><a href="https://www.cyberloom.best/l/PWKT876T">y</a>';
    const once = sanitizeContent(page, allowlist);
    expect(sanitizeContent(once, allowlist)).toBe(once);
  });

  it('replaces an attachment id and its per-file key', () => {
    const url =
      'https://www.1tamilmv.io/applications/core/interface/file/attachment.php?id=114765&amp;key=a8f848d67278c974a3db1ec49cb7d24c';
    const { out } = run(url);
    expect(out).not.toContain('114765');
    expect(out).not.toContain('a8f848d67278c974a3db1ec49cb7d24c');
    expect(out).toMatch(/attachment\.php\?id=\d+&amp;key=[0-9a-f]{32}/);
  });

  it('leaves the forum host and its topic URLs alone', () => {
    const page = '<a href="https://www.1tamilmv.io/topic/12345-film/">Film</a>';
    expect(run(page).out).toBe(page);
  });
});
