import { describe, it, expect } from 'vitest';
import { mapSourceTag, RADARR_SOURCE_ALLOWLIST } from '../src/source-tags.js';

describe('RADARR_SOURCE_ALLOWLIST', () => {
  it.each(['HDTS', 'HDTC', 'PDVD', 'WEB-DL', 'WEBRip', 'HDTV', 'SDTV', 'PDTV', 'BluRay', 'DVD9', 'DVD5', 'BRRip', 'BDRip', 'CAM'])(
    'contains %s',
    (token) => expect(RADARR_SOURCE_ALLOWLIST.has(token)).toBe(true),
  );

  it('does not contain HDRip or PREDVD', () => {
    expect(RADARR_SOURCE_ALLOWLIST.has('HDRip')).toBe(false);
    expect(RADARR_SOURCE_ALLOWLIST.has('PREDVD')).toBe(false);
  });
});

describe('mapSourceTag', () => {
  it.each([
    ['HQ HDTS', 'HDTS'],
    ['HQ HDTS (HQ Clean)', 'HDTS'],
    ['HDTC-Rip', 'HDTC'],
    ['HQ HDTC', 'HDTC'],
    ['HQ PreDVD', 'PDVD'],
    ['PreDVD (HQ Clean)', 'PDVD'],
    ['v2 HQ PreDVD', 'PDVD'],
    ['TRUE WEB-DL', 'WEB-DL'],
    ['NF WEB-DL', 'WEB-DL'],
    ['HQ HDRip', 'WEBRip'],
    ['HDRip', 'WEBRip'],
    ['HDTV-Rip', 'HDTV'],
    ['SDTV-Rip', 'SDTV'],
    ['BluRay', 'BluRay'],
    ['BR-Rip', 'BRRip'],
    ['DVD9', 'DVD9'],
    ['UNTOUCHED', null],
    ['HQ Clean', null],
    ['Original Audio', null],
    ['nonsense', null],
  ])('%s → %s', (raw, expected) => {
    const mapping = mapSourceTag(raw);
    expect(mapping.tag).toBe(expected);
    if (mapping.tag !== null) expect(RADARR_SOURCE_ALLOWLIST.has(mapping.tag)).toBe(true);
  });

  it('flags cleanAudio and keeps it out of the tag', () => {
    const m = mapSourceTag('HQ HDTS (HQ Clean)');
    expect(m.cleanAudio).toBe(true);
    expect(m.tag).toBe('HDTS');
  });

  it('does not treat the UNTOUCHED marker as a source', () => {
    expect(mapSourceTag('UNTOUCHED').tag).toBeNull();
  });
});
