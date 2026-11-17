import { describe, it, expect } from 'vitest';
import { bdecode, findRawInfoDict } from '../src/bencode.js';
import { torrentInfohash, torrentName } from '../src/torrent.js';
import { SYNTHETIC_TORRENT, SYNTHETIC_INFOHASH } from './fixtures/synthetic-torrent.js';

const torrent = SYNTHETIC_TORRENT;

/** Minimal hand-built torrent: dictionary with announce, info[length,name,piece length,pieces]. */
const MINIMAL = Buffer.concat([
  Buffer.from('d8:announce22:http://tracker.example4:infod6:lengthi12345e4:name10:sample.mkv12:piece lengthi16384e6:pieces20:'),
  Buffer.from('aaaaaaaaaaaaaaaaaaaa', 'latin1'),
  Buffer.from('ee'),
]);

describe('torrentInfohash', () => {
  it('computes SHA1 over the bencoded info dict', () => {
    // externally sourced: `printf … | sha1sum` over the info-dict slice, see the fixture's comment
    expect(torrentInfohash(torrent)).toBe(SYNTHETIC_INFOHASH);
  });

  it('reads the name field', () => {
    expect(torrentName(torrent)).toBe('example-fixture.txt');
  });

  it('rejects non-torrent input', () => {
    expect(() => torrentInfohash(Buffer.from('<html></html>'))).toThrow(/bencode/i);
  });

  it('hashes a hand-built minimal torrent dict', () => {
    // SHA1 of the exact byte slice starting at the 'd' of 4:infod .. its terminator
    const raw = MINIMAL.subarray(MINIMAL.indexOf('4:infod') + 6);
    expect(raw[0]).toBe(0x64 /* 'd' */);
    expect(torrentInfohash(MINIMAL)).toMatch(/^[0-9a-f]{40}$/);
    expect(torrentName(MINIMAL)).toBe('sample.mkv');
  });

  it('round-trips a minimal torrent through bdecode', () => {
    const root = bdecode(MINIMAL);
    expect(typeof root).toBe('object');
    const dict = root as Record<string, unknown>;
    expect(dict['announce']).toBeInstanceOf(Buffer);
    expect((dict['announce'] as Buffer).toString()).toBe('http://tracker.example');
    const info = dict['info'] as Record<string, unknown>;
    expect(info['length']).toBe(12345);
    expect((info['name'] as Buffer).toString()).toBe('sample.mkv');
  });
});

describe('bdecode', () => {
  it('parses integers, strings, lists and dicts', () => {
    expect(bdecode(Buffer.from('i42e'))).toBe(42);
    expect(bdecode(Buffer.from('3:abc'))).toBeInstanceOf(Buffer);
    expect(bdecode(Buffer.from('l4:spami7ee'))).toEqual([Buffer.from('spam'), 7]);
    expect(bdecode(Buffer.from('d1:ai1e1:bl1:xee'))).toEqual({ a: 1, b: [Buffer.from('x')] });
  });

  it.each([
    ['', /bencode/],
    ['i12', /bencode/],
    ['i12xe', /bencode/],
    ['4:ab', /bencode/],
    ['x', /bencode/],
    ['d1:ai1e', /bencode/],
    ['i1ei2e', /bencode/],
    ['di1ei2ee', /bencode/],
  ])('throws on malformed input %j', (input, pattern) => {
    expect(() => bdecode(Buffer.from(input))).toThrow(pattern as RegExp);
  });
});

describe('findRawInfoDict robustness', () => {
  // A naive `indexOf('4:infod')` finds the FIRST occurrence, so a byte string containing
  // those bytes before the real key would slice the wrong region and produce a wrong hash.
  it('ignores a decoy needle inside an earlier byte string', () => {
    // comment value is exactly 10 bytes: "xx4:infod!" — contains the needle bytes.
    const torrent = Buffer.from(
      'd8:announce4:http7:comment10:xx4:infod!4:infod4:name4:abcd12:piece lengthi16384e6:pieces0:ee',
      'latin1',
    );
    const info = findRawInfoDict(torrent);
    expect(info[0]).toBe(0x64); // 'd' — the real dict, not the decoy
    expect(info.toString('latin1')).toContain('4:name4:abcd');
    expect(info.toString('latin1')).not.toContain('infod!');
  });

  it('still hashes the fixture correctly', () => {
    expect(torrentInfohash(torrent)).toBe(SYNTHETIC_INFOHASH);
  });
});
