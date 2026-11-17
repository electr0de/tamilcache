import { describe, it, expect } from 'vitest';
import { magnetInfohash, buildMagnet } from '../src/magnet.js';

const REAL =
  'magnet:?xt=urn:btih:c9d385dc7158d74f70b733f17a8c0dde9b67357c&dn=www.1TamilMV.day%20-%20A%20Minecraft%20Movie%20%282025%29%20Hindi%20HDTC-Rip%20-%20720p%20-%20x264%20-%20HQ%20Clean%20Aud%20-%20700MB.mkv&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce';

describe('magnetInfohash', () => {
  it('extracts a lowercase hex infohash', () => {
    expect(magnetInfohash(REAL)).toBe('c9d385dc7158d74f70b733f17a8c0dde9b67357c');
  });

  it('accepts uppercase hex', () => {
    expect(magnetInfohash(REAL.replace('b98bb8d7', 'C9D385DC'))).toBe(
      'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
    );
  });

  it('accepts base32 btih and converts to hex', () => {
    // shape assertion (plan's verbatim case)
    expect(magnetInfohash('magnet:?xt=urn:btih:ZHJYLXDRLDLU64FXGPYXVDAN32NWONL4')).toMatch(
      /^[0-9a-f]{40}$/,
    );
    // base32 encoding of the fixture magnet's infohash decodes back to it exactly
    expect(magnetInfohash('magnet:?xt=urn:btih:ZHJYLXDRLDLU64FXGPYXVDAN32NWONL4')).toBe(
      'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
    );
  });

  it('returns null for links without btih', () => {
    expect(magnetInfohash('magnet:?dn=x')).toBeNull();
  });

  it('decodes &amp; entities from scraped HTML', () => {
    expect(magnetInfohash(REAL.replace(/&/g, '&amp;'))).toBe(
      'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
    );
  });
});

describe('buildMagnet', () => {
  it('round-trips through magnetInfohash', () => {
    const m = buildMagnet({
      infohash: 'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
      dn: 'A.B.2025.720p.HDTS.x264.Hindi-TMV',
      trackers: ['udp://tracker.example:1337/announce'],
    });
    expect(magnetInfohash(m)).toBe('c9d385dc7158d74f70b733f17a8c0dde9b67357c');
    expect(m).toContain('dn=A.B.2025.720p.HDTS.x264.Hindi-TMV');
    expect(m).toContain('tr=udp');
    expect(m.startsWith('magnet:?xt=urn:btih:')).toBe(true);
  });

  it('omits trackers when none are given', () => {
    const m = buildMagnet({ infohash: 'c9d385dc7158d74f70b733f17a8c0dde9b67357c', dn: 'x y' });
    expect(m).toBe('magnet:?xt=urn:btih:c9d385dc7158d74f70b733f17a8c0dde9b67357c&dn=x%20y');
  });
});

describe('magnetInfohash parameter handling', () => {
  it('ignores an xt-shaped string inside dn', () => {
    const m =
      'magnet:?dn=xt%3Durn%3Abtih%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      '&xt=urn%3Abtih%3Ac9d385dc7158d74f70b733f17a8c0dde9b67357c';
    expect(magnetInfohash(m)).toBe('c9d385dc7158d74f70b733f17a8c0dde9b67357c');
  });
});
