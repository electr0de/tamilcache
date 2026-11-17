import { describe, expect, it } from 'vitest';
import { torrentInfohash } from '@tamilcache/shared';
import { resolveTorrentHashes } from '../src/torrent-hash.js';
import { SYNTHETIC_TORRENT } from '../../../packages/shared/test/fixtures/synthetic-torrent.js';

const torrent = SYNTHETIC_TORRENT;

describe('resolveTorrentHashes', () => {
  it('fetches each distinct attachment once and derives its infohash', async () => {
    const fetched: string[] = [];
    const http = {
      getBuffer: async (url: string) => {
        fetched.push(url);
        return { status: 200, body: torrent };
      },
    };

    const hashes = await resolveTorrentHashes(http, [
      { torrentUrl: 'https://host/attachment.php?id=1' },
      { torrentUrl: 'https://host/attachment.php?id=1' },
      { torrentUrl: 'https://host/attachment.php?id=2' },
      { torrentUrl: null },
    ]);

    expect(fetched).toEqual(['https://host/attachment.php?id=1', 'https://host/attachment.php?id=2']);
    expect(hashes.get('https://host/attachment.php?id=1')).toBe(torrentInfohash(torrent));
    expect(hashes.size).toBe(2);
  });

  it('skips an attachment that is not a torrent and keeps going', async () => {
    const http = {
      getBuffer: async (url: string) =>
        url.endsWith('bad')
          ? { status: 200, body: Buffer.from('<html>not a torrent</html>') }
          : { status: 404, body: Buffer.alloc(0) },
    };

    const hashes = await resolveTorrentHashes(http, [
      { torrentUrl: 'https://host/attachment.php?id=bad' },
      { torrentUrl: 'https://host/attachment.php?id=missing' },
    ]);

    expect(hashes.size).toBe(0);
  });

  it('does nothing when no block needs a hash', async () => {
    let calls = 0;
    const http = { getBuffer: async () => { calls++; return { status: 200, body: torrent }; } };
    const hashes = await resolveTorrentHashes(http, [{ torrentUrl: null }]);
    expect(calls).toBe(0);
    expect(hashes.size).toBe(0);
  });
});
