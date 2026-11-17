/** Types for `check-leaks.mjs`, which is plain ESM so it runs with `node` and no build. */
export interface Leak {
  file: string;
  rule: 'torrent-file' | 'database-file' | 'private-material' | 'real-infohash' | 'tracker-url';
  detail: string;
}

export declare function isMain(metaUrl: string, argv1: string | undefined): boolean;

export declare function gitTracked(root: string): string[];

export declare function loadAllowlist(): { hashes: string[] };

export declare function findLeaks(root: string, files: string[], allowed: Set<string>): Leak[];
