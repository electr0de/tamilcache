import { describe, expect, it } from 'vitest';
import { deriveStatus } from '../src/status.js';

describe('deriveStatus', () => {
  it('marks a deleted topic gone whatever else is true', () => {
    expect(deriveStatus({ httpStatus: 404, variants: 0, hasDownload: true, hasPostLink: true })).toBe('gone');
    expect(deriveStatus({ httpStatus: 410, variants: 0, hasDownload: false, hasPostLink: false })).toBe('gone');
  });

  it('marks a topic with variants parsed', () => {
    expect(deriveStatus({ httpStatus: 200, variants: 2, hasDownload: true, hasPostLink: false })).toBe('parsed');
  });

  it('separates a magnet-less post with a real link from one with nothing', () => {
    expect(deriveStatus({ httpStatus: 200, variants: 0, hasDownload: false, hasPostLink: true })).toBe('external');
    expect(deriveStatus({ httpStatus: 200, variants: 0, hasDownload: false, hasPostLink: false })).toBe('no_link');
  });

  it('calls a download that produced no variant a parse failure, never a user task', () => {
    expect(deriveStatus({ httpStatus: 200, variants: 0, hasDownload: true, hasPostLink: true })).toBe('parse_failed');
  });

  it('calls a download whose blocks are all under the 1080p floor below_floor, not a parse failure', () => {
    expect(
      deriveStatus({ httpStatus: 200, variants: 0, variantsDropped: 3, hasDownload: true, hasPostLink: false }),
    ).toBe('below_floor');
  });

  it('treats a plain 200 with no variants as external when only site chrome is present', () => {
    // Chrome links are classified `spam` and never reach `hasPostLink`, so a page whose only
    // outbound links are the player banner is `no_link`, not `external`.
    expect(deriveStatus({ httpStatus: 200, variants: 0, hasDownload: false, hasPostLink: false })).toBe('no_link');
  });
});
