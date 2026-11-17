import { describe, it, expect } from 'vitest';
import { normaliseTitle, sizeLabel } from '../src/normalise-title.js';

const base = {
  title: 'A Minecraft Movie',
  year: 2025,
  resolution: '720p',
  sourceTag: 'HDTS',
  codec: 'x264',
  audioCodecs: 'AAC',
  audioLangs: ['hindi'],
  sizeBytes: 734003200,
};

describe('normaliseTitle', () => {
  it('produces a scene-parseable name', () => {
    expect(normaliseTitle(base)).toBe('A.Minecraft.Movie.2025.720p.HDTS.x264.AAC.Hindi.700MB-TMV');
  });

  it('keeps resolution adjacent to source', () => {
    expect(normaliseTitle(base)).toMatch(/720p\.HDTS/);
  });

  it('never emits a bare WEB token', () => {
    const n = normaliseTitle({ ...base, sourceTag: 'WEB-DL' });
    expect(n).not.toMatch(/\.WEB\./);
    expect(n).toContain('WEB-DL');
  });

  it('never emits HQ or HQ Clean', () => {
    expect(normaliseTitle({ ...base, sourceTag: 'HDTS' })).not.toMatch(/HQ/i);
  });

  it('de-duplicates audio languages', () => {
    const n = normaliseTitle({ ...base, audioLangs: ['tamil', 'hindi', 'tamil'] });
    expect(n.match(/Tamil/g)).toHaveLength(1);
    expect(n).toContain('Hindi');
  });

  it('keeps multi-language tokens distinguishable', () => {
    const n = normaliseTitle({ ...base, audioLangs: ['tamil', 'english'] });
    expect(n).toContain('Tamil.English');
    expect(n).not.toContain('TamilEnglish');
  });

  it('compacts audio codecs into one token', () => {
    expect(normaliseTitle({ ...base, audioCodecs: 'AAC 2.0' })).toContain('.AAC2.0.');
    expect(normaliseTitle({ ...base, audioCodecs: 'DD+5.1' })).toContain('.DDP5.1.');
  });

  it('only emits the dubbed marker when asked', () => {
    expect(normaliseTitle({ ...base, dubbed: true })).toContain('HindiDubbed');
    expect(normaliseTitle(base)).not.toContain('HindiDubbed');
  });

  it('omits missing parts without empty segments', () => {
    const n = normaliseTitle({ ...base, codec: null, audioCodecs: null, year: null, sizeBytes: 0 });
    expect(n).not.toMatch(/\.\./);
    expect(n).toBe('A.Minecraft.Movie.720p.HDTS.Hindi-TMV');
  });

  it('appends the season/episode range for packs', () => {
    expect(normaliseTitle({ ...base, season: 1, epFrom: 1, epTo: 8, isPack: true })).toContain('S01E01-E08');
    expect(normaliseTitle({ ...base, season: 1, epFrom: 3, epTo: 3, isPack: false })).toContain('S01E03');
  });

  it('strips characters Radarr would mis-parse', () => {
    const n = normaliseTitle({ ...base, title: 'Vikram: On Duty [Tamil]' });
    expect(n).not.toMatch(/[[\]:]/);
  });

  it('drops version markers from the title', () => {
    expect(normaliseTitle({ ...base, title: 'Sardar 2 v2' })).not.toMatch(/\.v2/);
  });

  it('maps AVC to x264 and HEVC to x265', () => {
    expect(normaliseTitle({ ...base, codec: 'AVC' })).toContain('.x264.');
    expect(normaliseTitle({ ...base, codec: 'HEVC' })).toContain('.x265.');
  });
});

describe('sizeLabel', () => {
  it('renders GB and MB', () => {
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3GB');
    expect(sizeLabel(1.4 * 1024 ** 3)).toBe('1.4GB');
    expect(sizeLabel(700 * 1024 ** 2)).toBe('700MB');
    expect(sizeLabel(0)).toBe('');
  });
});
