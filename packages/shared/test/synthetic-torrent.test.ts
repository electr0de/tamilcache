import { describe, it, expect } from 'vitest';
import { torrentInfohash, torrentName } from '../src/torrent.js';
import { SYNTHETIC_TORRENT, SYNTHETIC_INFOHASH } from './fixtures/synthetic-torrent.js';

describe('synthetic torrent fixture', () => {
  it('hashes to the documented, externally computed infohash', () => {
    expect(torrentInfohash(SYNTHETIC_TORRENT)).toBe(SYNTHETIC_INFOHASH);
  });

  it('names a file that does not exist anywhere', () => {
    expect(torrentName(SYNTHETIC_TORRENT)).toBe('example-fixture.txt');
  });
});
