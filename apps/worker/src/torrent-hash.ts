import { torrentInfohash } from '@tamilcache/shared';

export interface BufferHttp {
  getBuffer(url: string): Promise<{ status: number; body: Buffer }>;
}

/**
 * Every torrent-only block needs its hash before it can be stored: `variants.infohash` is NOT
 * NULL and the indexer cannot serve a file it has not read. One fetch per distinct attachment;
 * a failure simply leaves that block unpublished (the topic is marked `parse_failed` and retried
 * on the next pass) — never a placeholder hash, which would poison `dedupeByInfohash()`.
 */
export async function resolveTorrentHashes(
  http: BufferHttp,
  blocks: { torrentUrl: string | null }[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(blocks.map((block) => block.torrentUrl).filter((url): url is string => url !== null))];
  const hashes = new Map<string, string>();
  for (const url of wanted) {
    try {
      const response = await http.getBuffer(url);
      if (response.status !== 200) continue;
      hashes.set(url, torrentInfohash(response.body));
    } catch {
      // A network failure is not this block's fault: leave it unresolved and move on.
    }
  }
  return hashes;
}
