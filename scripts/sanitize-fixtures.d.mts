/** Types for `sanitize-fixtures.mjs`, which is plain ESM so it runs with `node` and no build. */
export declare const TORRENT_FIXTURE_HASH: string;
export declare const ALLOWLIST_PATH: string;

export interface Allowlist {
  _note?: string;
  hashes: string[];
  tokens: Record<string, string>;
  attachments: Record<string, string>;
}

export declare function newAllowlist(hashes?: string[]): Allowlist;

export declare function sanitizeContent(text: string, allowlist?: Allowlist): string;
