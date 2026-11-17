const BTIH_PREFIX = /^urn:btih:(.+)$/i;
const B32 = /^[A-Z2-7]+=*$/i;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(s: string): string {
  const clean = s.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`magnet: invalid base32 char ${ch}`);
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString('hex');
}

/**
 * Accepts raw or HTML-escaped magnet links. Returns 40-char lowercase hex or null.
 *
 * Parses the query string instead of regex-scanning the whole link: a `dn` that happens to
 * contain `xt=urn:btih:` must not shadow the real `xt` parameter.
 */
export function magnetInfohash(magnet: string): string | null {
  const decoded = magnet.replace(/&amp;/gi, '&');
  const queryAt = decoded.indexOf('?');
  if (queryAt < 0) return null;
  const params = new URLSearchParams(decoded.slice(queryAt + 1));
  for (const xt of params.getAll('xt')) {
    const raw = BTIH_PREFIX.exec(xt)?.[1]?.trim();
    if (!raw) continue;
    if (/^[0-9a-f]{40}$/i.test(raw)) return raw.toLowerCase();
    if (B32.test(raw)) {
      const hex = base32ToHex(raw);
      if (hex.length === 40) return hex;
    }
  }
  return null;
}

export interface BuildMagnetInput {
  infohash: string;
  dn: string;
  trackers?: string[];
}

export function buildMagnet({ infohash, dn, trackers = [] }: BuildMagnetInput): string {
  const parts = [`xt=urn:btih:${infohash}`, `dn=${encodeURIComponent(dn)}`];
  for (const t of trackers) parts.push(`tr=${encodeURIComponent(t)}`);
  return `magnet:?${parts.join('&')}`;
}
