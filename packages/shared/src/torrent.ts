import { createHash } from 'node:crypto';
import { bdecode, findRawInfoDict, type Bencode } from './bencode.js';

export function torrentInfohash(torrent: Buffer): string {
  const raw = findRawInfoDict(torrent);
  return createHash('sha1').update(raw).digest('hex');
}

export function torrentName(torrent: Buffer): string {
  const root = bdecode(torrent);
  if (typeof root !== 'object' || root === null || Array.isArray(root) || Buffer.isBuffer(root)) {
    throw new Error('bencode: root must be a dict');
  }
  const info = (root as Record<string, Bencode>)['info'];
  if (typeof info !== 'object' || info === null || Array.isArray(info) || Buffer.isBuffer(info)) {
    throw new Error('bencode: missing info dict');
  }
  const name = (info as Record<string, Bencode>)['name'];
  if (!Buffer.isBuffer(name)) throw new Error('bencode: missing name');
  return name.toString('utf8');
}
