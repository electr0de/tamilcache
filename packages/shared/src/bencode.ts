export type Bencode = number | Buffer | Bencode[] | { [k: string]: Bencode };

interface Cursor { buf: Buffer; i: number }

function parseValue(c: Cursor): Bencode {
  const ch = c.buf[c.i];
  if (ch === undefined) throw new Error('bencode: unexpected end of input');
  if (ch === 0x69 /* i */) {
    const end = c.buf.indexOf(0x65, c.i);
    if (end < 0) throw new Error('bencode: unterminated integer');
    const n = Number(c.buf.toString('latin1', c.i + 1, end));
    if (!Number.isInteger(n)) throw new Error('bencode: bad integer');
    c.i = end + 1;
    return n;
  }
  if (ch === 0x6c /* l */) {
    c.i++;
    const out: Bencode[] = [];
    while (c.buf[c.i] !== 0x65) out.push(parseValue(c));
    c.i++;
    return out;
  }
  if (ch === 0x64 /* d */) {
    c.i++;
    const out: { [k: string]: Bencode } = {};
    while (c.buf[c.i] !== 0x65) {
      const k = parseValue(c);
      if (!Buffer.isBuffer(k)) throw new Error('bencode: dict key must be a string');
      out[k.toString('utf8')] = parseValue(c);
    }
    c.i++;
    return out;
  }
  if (ch >= 0x30 && ch <= 0x39) {
    const colon = c.buf.indexOf(0x3a, c.i);
    if (colon < 0) throw new Error('bencode: malformed string length');
    const len = Number(c.buf.toString('latin1', c.i, colon));
    if (!Number.isInteger(len) || len < 0) throw new Error('bencode: bad string length');
    const start = colon + 1;
    const end = start + len;
    if (end > c.buf.length) throw new Error('bencode: truncated string');
    c.i = end;
    return c.buf.subarray(start, end);
  }
  throw new Error(`bencode: invalid token 0x${ch.toString(16)}`);
}

export function bdecode(buf: Buffer): Bencode {
  const c: Cursor = { buf, i: 0 };
  const v = parseValue(c);
  if (c.i !== buf.length) throw new Error('bencode: trailing bytes');
  return v;
}

/**
 * Byte-accurate re-slice of the raw `info` value — required for the infohash, because
 * re-serialising the parsed dict can reorder keys and change the hash.
 *
 * Walks the top-level dict's keys instead of searching for the `4:infod` needle: a `pieces`
 * blob (or any other byte string) may legitimately contain those bytes, which would make a
 * naive `indexOf` slice the wrong region and yield a wrong infohash.
 */
export function findRawInfoDict(buf: Buffer): Buffer {
  if (buf[0] !== 0x64) throw new Error('bencode: root must be a dict');
  const c: Cursor = { buf, i: 1 };
  let info: Buffer | null = null;

  for (;;) {
    const ch = buf[c.i];
    if (ch === undefined) throw new Error('bencode: unterminated root dict');
    if (ch === 0x65) {
      c.i++;
      break;
    }
    const key = parseValue(c);
    if (!Buffer.isBuffer(key)) throw new Error('bencode: dict key must be a string');
    const start = c.i;
    parseValue(c);
    if (key.toString('latin1') === 'info') info = buf.subarray(start, c.i);
  }

  if (c.i !== buf.length) throw new Error('bencode: trailing bytes');
  if (!info) throw new Error('bencode: no info dict');
  return info;
}
