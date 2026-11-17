import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { blockHeaderText, isBlockHeaderLine, parseAudioLangs, parseBlockHeader, parseSize } from '../src/block-header.js';
import { mapSourceTag } from '../src/source-tags.js';
import { parseTopicPage } from '../src/topic-parser.js';

const dir = join(import.meta.dirname, 'fixtures');
const BASE = 'https://www.1tamilmv.io';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe('parseSize', () => {
  it.each([
    ['700MB', 700 * MB],
    ['400MB', 400 * MB],
    ['3GB', 3 * GB],
    ['250MB', 250 * MB],
    ['2.8GB', Math.round(2.8 * GB)],
    ['- 1.8GB - ESub', Math.round(1.8 * GB)],
  ])('%s', (text, expected) => {
    expect(parseSize(text)).toBe(expected);
  });

  it('returns 0 when there is no size', () => {
    expect(parseSize('Jailer 2 (2026) Tamil HQ HDRip - 1080p')).toBe(0);
  });

  it('does not mistake a bitrate for a size', () => {
    expect(parseSize('(DD+5.1 - 192Kbps)')).toBe(0);
  });
});

describe('parseAudioLangs', () => {
  it.each([
    ['Jailer 2 (2026) Tamil HQ HDRip', ['tamil']],
    ['A Minecraft Movie (2025) Hindi  HDTC-Rip', ['hindi']],
    ['IT: Welcome to Derry (2025) S01 EP01 TRUE WEB-DL - [Hindi + Eng]', ['hindi', 'english']],
    ['A History of Violence (2005) BluRay - [Tamil + Eng]', ['tamil', 'english']],
    ['BR-Rip - x264 - Tamil Dubbed', ['tamil']],
    ['Panthadikkaam (2026) S01 EP (01-05) Malayalam TRUE WEB-DL', ['malayalam']],
    // abbreviations used inside attachment file names
    ['[Tam + Eng]', ['tamil', 'english']],
    ['Hindi Hin Hind', ['hindi']],
    // original-audio markers carry no language token of their own
    ['Original Audio', []],
    ['Original Audios', []],
    ['Org Audio', []],
    ['Org Auds', []],
    // quality noise is not a language
    ['HQ Clean Audio', []],
    ['UNTOUCHED - ESub', []],
  ])('%s', (text, expected) => {
    expect(parseAudioLangs(text)).toEqual(expected);
  });

  it('dedupes repeated languages and keeps document order', () => {
    expect(parseAudioLangs('[Tamil + Eng + Tam]')).toEqual(['tamil', 'english']);
  });
});

describe('parseBlockHeader', () => {
  it('parses a full block header (multi-quality.html, block 1)', () => {
    const header = parseBlockHeader(
      'Jailer 2 (2026) Tamil HQ HDRip - 1080p - x264 - (AAC 2.0) - 2.8GB - HC- ESub :',
    );
    expect(header).not.toBeNull();
    expect(header?.title).toBe('Jailer 2');
    expect(header?.year).toBe(2026);
    expect(header?.audioLangs).toEqual(['tamil']);
    expect(header?.sourceTagRaw).toBe('HQ HDRip');
    expect(header?.resolution).toBe('1080p');
    expect(header?.codec).toBe('x264');
    expect(header?.audioCodecs).toBe('AAC 2.0');
    expect(header?.sizeBytes).toBe(Math.round(2.8 * GB));
  });

  it('allows a block header with no resolution (single-quality.html, block 2)', () => {
    const header = parseBlockHeader(
      'A Minecraft Movie (2025) Hindi  HDTC-Rip  - x264 - HQ Clean Audio - AAC - 400MB   :',
    );
    expect(header?.resolution).toBeNull();
    expect(header?.sourceTagRaw).toBe('HDTC-Rip');
    expect(header?.audioLangs).toEqual(['hindi']);
    expect(header?.sizeBytes).toBe(400 * MB);
  });

  it('never emits HQ Clean as a source token (single-quality.html, block 1)', () => {
    const header = parseBlockHeader(
      'A Minecraft Movie (2025) Hindi  HDTC-Rip  - 720p - x264 - HQ Clean Audio - AAC - 700MB   :',
    );
    expect(header?.sourceTagRaw).toBe('HDTC-Rip');
    expect(JSON.stringify(header)).not.toMatch(/clean/i);
  });

  it('parses HQ PreDVD and Original Audio (hindi-original.html, block 1)', () => {
    const header = parseBlockHeader(
      'Ramayana (2026) Hindi HQ PreDVD - 1080p - x264 -  Original Audio - AAC - 3.3GB   :',
    );
    expect(header?.sourceTagRaw).toBe('HQ PreDVD');
    expect(header?.audioLangs).toEqual(['hindi']);
    expect(header?.audioCodecs).toBe('AAC');
    expect(header?.sizeBytes).toBe(Math.round(3.3 * GB));
  });

  it('reads bracketed languages and normalises AVC (season-pack.html, block 1)', () => {
    const header = parseBlockHeader(
      'Panthadikkaam (2026) S01 EP (01-05) Malayalam TRUE WEB-DL - 1080p - AVC - UNTOUCHED - (DD+5.1 - 192Kbps) - 1.8GB - ESub :',
    );
    expect(header?.sourceTagRaw).toBe('TRUE WEB-DL');
    expect(header?.audioLangs).toEqual(['malayalam']);
    expect(header?.codec).toBe('x264');
    expect(header?.audioCodecs).toBe('DD+5.1');
  });

  it('reads bracketed languages placed after the source tag (multi-audio-orgauds.html)', () => {
    const header = parseBlockHeader(
      'A History of Violence (2005) BluRay - 1080p - x264 - [Tamil + Eng] - (AAC 2.0) - 1.5GB - ESub :',
    );
    expect(header?.sourceTagRaw).toBe('BluRay');
    expect(header?.audioLangs).toEqual(['tamil', 'english']);
  });

  it('does not invent a language for Tamil Dubbed only blocks', () => {
    const header = parseBlockHeader(
      'A History of Violence (2005) BR-Rip - x264 - Tamil Dubbed - (AAC 2.0) - 400MB - ESub :',
    );
    expect(header?.sourceTagRaw).toBe('BR-Rip');
    expect(header?.audioLangs).toEqual(['tamil']);
    expect(header?.resolution).toBeNull();
  });

  it('returns null when there is no source tag even if HQ Clean is present', () => {
    expect(parseBlockHeader('X (2026) Tamil HQ Clean Audio - AAC - 400MB :')).toBeNull();
  });

  it('returns null when there is no size', () => {
    expect(parseBlockHeader('Jailer 2 (2026) Tamil HQ HDRip - 1080p - HC- ESub :')).toBeNull();
  });
});

describe('isBlockHeaderLine (the anchor rule)', () => {
  it('accepts a line that ends with a colon and carries size + source', () => {
    expect(
      isBlockHeaderLine('Jailer 2 (2026) Tamil HQ HDRip - 1080p - x264 - (AAC 2.0) - 2.8GB - HC- ESub :'),
    ).toBe(true);
  });

  it('rejects the topic-level summary line that has no trailing colon', () => {
    expect(
      isBlockHeaderLine(
        'Jailer 2 (2026) Tamil TRUE WEB-DL - [1080p & 720p - AVC / HEVC - (AAC 2.0) - 2.8GB - 1.4GB & 950MB] - [x264 - 700MB - 400MB & 250MB] - ESub',
      ),
    ).toBe(false);
  });

  it('rejects a colon line without a size or without a source', () => {
    expect(isBlockHeaderLine('Download Links :')).toBe(false);
    expect(isBlockHeaderLine('Panthadikkaam (2026) Malayalam ESub :')).toBe(false);
  });

  it('accepts a colon followed by the upload date (daily-show listings)', () => {
    // BIGG BOSS episodes end their block headers with `: [10-11-2026]`, so a strict
    // "ends with a colon" rule saw 0 of 198 headers and the whole daily-show category
    // produced no variants at all.
    expect(
      isBlockHeaderLine(
        'BIGG BOSS (Tamil) S10 EP66 DAY 65 TRUE WEB-DL - 1080p - AVC - UNTOUCHED - AAC - 1.7GB : [10-11-2026]',
      ),
    ).toBe(true);
  });
});

describe('source spellings measured on the live site (2026-11-17)', () => {
  const fixtures = [
    ['source-tvrip.html', 'TVRip'],
    ['source-pre-hd.html', 'PRE-HD'],
    ['source-hdrp-typo.html', 'HDRp'],
  ] as const;

  for (const [file, expected] of fixtures) {
    it(`${file} yields variants and keeps the spelling as printed`, () => {
      const html = readFileSync(join(dir, file), 'utf8');
      const parsed = parseTopicPage(html, BASE);
      expect(parsed.variants.length).toBeGreaterThan(0);
      expect(parsed.variants[0]?.sourceTagRaw.toUpperCase()).toContain(expected.toUpperCase());
    });
  }

  it('maps each spelling to a Radarr token', () => {
    // PRE-HD is a pre-release HD: Radarr has no such token, and PreDVD is the honest neighbour.
    expect(mapSourceTag('HQ PRE-HD').tag).toBe('PDVD');
    expect(mapSourceTag('TVRip').tag).toBeTruthy();
    // The site prints the typo; the intent is HDRip, which Radarr has no token for, so it maps
    // to the same grabbable neighbour the correct spelling does.
    expect(mapSourceTag('HQ HDRp').tag).toBe('WEBRip');
  });
});

describe('header anchoring beyond the colon', () => {
  it('accepts a header that ends with ESub', () => {
    const html = readFileSync(join(dir, 'header-no-colon-esub.html'), 'utf8');
    expect(parseTopicPage(html, BASE).variants.length).toBeGreaterThan(0);
  });

  it('accepts the torrent filename as the only quality line, without taking the mirror host as the title', () => {
    const html = readFileSync(join(dir, 'header-torrent-follows.html'), 'utf8');
    const [first] = parseTopicPage(html, BASE).variants;
    expect(first).toBeDefined();
    expect(first?.title).toContain('Naked Gun');
    expect(first?.title.toLowerCase()).not.toContain('tamilmv');
    expect(first?.resolution).toBe('720p');
  });

  it('still rejects the topic summary line, which lists several resolutions', () => {
    // The summary carries a size and a source too, so it can only be excluded by its bracket.
    expect(blockHeaderText('Film (2026) - [4K, 1080p & 720p - x264 - 6GB & 2.8GB & 1.4GB] - ESub')).toBeNull();
  });
});

describe('a shape-valid block with an unknown source is kept', () => {
  it('returns a header instead of null, keeping the source as printed', () => {
    const header = parseBlockHeader('Some Film (2026) HQ XYZ-Rip - 1080p - x264 - 6GB');
    expect(header).not.toBeNull();
    expect(header?.resolution).toBe('1080p');
    expect(header?.sizeBytes).toBeGreaterThan(0);
    expect(header?.sourceTagRaw.length).toBeGreaterThan(0);
  });

  it('still refuses a line with no size, or no resolution', () => {
    expect(parseBlockHeader('Some Film (2026) HQ XYZ-Rip - 1080p')).toBeNull();
    expect(parseBlockHeader('Some Film (2026) HQ XYZ-Rip - x264 - 6GB')).toBeNull();
  });
});
