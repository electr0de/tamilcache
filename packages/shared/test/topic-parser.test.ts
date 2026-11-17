import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlockHeaderLine } from '../src/block-header.js';
import { htmlLines, parseTopicPage, topicBodyLines } from '../src/topic-parser.js';

const dir = join(import.meta.dirname, 'fixtures');
const read = (file: string): string => readFileSync(join(dir, file), 'utf8');
const BASE = 'https://www.1tamilmv.io';

/**
 * Transcribed from packages/shared/test/fixtures/MANIFEST.md, 2026-11-09.
 * Never adjusted to fit the code: if a number here disagrees with the parser, the parser is wrong.
 */
const EXPECTED: Record<string, number> = {
  'single-quality.html': 2,
  'multi-quality.html': 7,
  'multi-quality-hq-predvd.html': 6,
  'hindi-original.html': 5,
  'season-pack.html': 3,
  'single-episode.html': 3,
  'multi-audio-orgauds.html': 3,
  'gdrive-only.html': 0,
  'no-audio-tag.html': 0,
  // `torrent-no-magnet.html` is asserted separately: it yields variants with a null infohash, so
  // it cannot go through the "every variant has a 40-hex hash" loop below.
};

describe('parseTopicPage — MANIFEST.md variant counts', () => {
  for (const [file, expected] of Object.entries(EXPECTED)) {
    it(file, () => {
      const topic = parseTopicPage(read(file), BASE);
      expect(topic.variants).toHaveLength(expected);
      for (const v of topic.variants) {
        expect(v.infohash).toMatch(/^[0-9a-f]{40}$/);
        expect(v.sizeBytes).toBeGreaterThan(0);
        expect(v.sourceTagRaw.length).toBeGreaterThan(0);
      }
    });
  }

  it('yields distinct infohashes within a topic', () => {
    const topic = parseTopicPage(read('multi-quality.html'), BASE);
    expect(new Set(topic.variants.map((v) => v.infohash)).size).toBe(topic.variants.length);
  });

  it('stores magnets with entities decoded, ready for a Torznab enclosure', () => {
    for (const v of parseTopicPage(read('multi-quality.html'), BASE).variants) {
      expect(v.magnet).not.toContain('&amp;');
      expect(v.magnet?.toLowerCase()).toContain(v.infohash);
    }
  });
});

/**
 * Regression guard for THE PARSING RULE THIS SET PROVES (MANIFEST.md).
 *
 * A quality block anchors on a line that ends with `:` and carries both a size and a source
 * tag; the count of those lines equals the magnet count in every fixture that has magnets
 * (and, trivially, 0 === 0 in the magnet-less ones). `multi-quality.html` is the fixture that
 * catches a "line contains a size and a source tag" selector: 20 candidates, 7 magnets.
 *
 * `torrent-no-magnet.html` is excluded on purpose: it is the synthetic fixture built by
 * deleting magnet anchors, so it keeps its 2 headers and has 0 magnets.
 */
const ANCHOR_RULE_FIXTURES = [
  'single-quality.html',
  'multi-quality.html',
  'multi-quality-hq-predvd.html',
  'hindi-original.html',
  'season-pack.html',
  'single-episode.html',
  'multi-audio-orgauds.html',
  'gdrive-only.html',
  'no-audio-tag.html',
];

describe('anchor rule — colon lines equal magnets', () => {
  for (const file of ANCHOR_RULE_FIXTURES) {
    it(file, () => {
      const html = read(file);
      const magnetCount = [...html.matchAll(/href="magnet:\?[^"]*"/gi)].length;
      const colonLines = htmlLines(html).filter((line) => isBlockHeaderLine(line.text));
      expect(colonLines.length).toBe(magnetCount);
    });
  }

  it('multi-quality.html has 20 size+source candidates but only 7 headers', () => {
    const html = read('multi-quality.html');
    const lines = htmlLines(html).map((l) => l.text);
    // a naive "size + source tag" selector, for contrast with the colon rule
    const candidates = lines.filter(
      (l) => /(\d+(?:\.\d+)?)\s*(GB|MB)\b/i.test(l) && /WEB-?DL|HDRip/i.test(l),
    );
    expect(candidates.length).toBe(20);
    expect(lines.filter((l) => isBlockHeaderLine(l)).length).toBe(7);
  });

  it('keeps the rule honest when scanning only the post body', () => {
    // the summary lines survive in the page chrome (title/h1/meta), not in the body
    const html = read('multi-quality.html');
    const body = topicBodyLines(html).map((l) => l.text);
    expect(body.filter((l) => isBlockHeaderLine(l)).length).toBe(7);
  });
});

describe('parseTopicPage — topic identity', () => {
  it('reads sourceTopicId and slug from the canonical topic URL', () => {
    const topic = parseTopicPage(read('single-quality.html'), BASE);
    expect(topic.sourceTopicId).toBe(187596);
    expect(topic.slug).toBe(
      'a-minecraft-movie-2025-hindi-hdtc-1080p-720p-x264-2gb-1gb-400mb-hq-clean-audio',
    );
  });

  it('does not pick the navigation topic link (topic/183-0) every page carries', () => {
    const topic = parseTopicPage(read('season-pack.html'), BASE);
    expect(topic.sourceTopicId).toBe(200135);
    expect(topic.slug.startsWith('panthadikkaam-2026-s01-ep-01-05')).toBe(true);
  });

  it('reads rawTitle from the topic, not the page chrome', () => {
    expect(parseTopicPage(read('single-quality.html'), BASE).rawTitle).toMatch(
      /^A Minecraft Movie \(2025\) Hindi HDTC/,
    );
  });

  it('reads the poster from img src, never from an anchor href', () => {
    expect(parseTopicPage(read('single-quality.html'), BASE).poster).toMatch(
      /^https:\/\/img1\.imageride\.net\/.*\.jpg$/,
    );
    expect(parseTopicPage(read('multi-quality.html'), BASE).poster).toMatch(/^https:\/\/pbs\.twimg\.com\//);
    expect(parseTopicPage(read('season-pack.html'), BASE).poster).toMatch(/^https:\/\/m\.media-amazon\.com\//);
  });

  it('parses season packs from the slug later', () => {
    expect(parseTopicPage(read('season-pack.html'), BASE).slug).toContain('s01-ep-01-05');
  });
});

describe('parseTopicPage — per-block variants', () => {
  it('keeps a resolution-less block as a valid variant (single-quality.html)', () => {
    const { variants } = parseTopicPage(read('single-quality.html'), BASE);
    expect(variants.map((v) => v.resolution)).toEqual(['720p', null]);
    expect(variants.map((v) => v.sizeBytes)).toEqual([700 * 1024 ** 2, 400 * 1024 ** 2]);
    expect(variants.map((v) => v.qualityLabel)).toEqual(['720p HDTC-Rip', 'HDTC-Rip']);
    for (const v of variants) {
      expect(v.audioLangs).toEqual(['hindi']);
      expect(v.magnet).toMatch(/^magnet:\?xt=urn:btih:/);
      expect(v.torrentUrl).toMatch(/attachment\.php\?id=/);
    }
  });

  it('separates x264 and x265 variants of the same source (multi-quality.html)', () => {
    const { variants } = parseTopicPage(read('multi-quality.html'), BASE);
    expect(variants.map((v) => v.resolution)).toEqual([
      '1080p',
      '1080p',
      '720p',
      '720p',
      null,
      null,
      null,
    ]);
    expect(variants.map((v) => v.codec)).toEqual(['x264', 'x265', 'x264', 'x265', 'x264', 'x264', 'x264']);
    for (const v of variants) {
      expect(v.sourceTagRaw).toBe('HQ HDRip');
      expect(v.audioLangs).toEqual(['tamil']);
    }
  });

  it('emits HQ PreDVD blocks with their own sizes (multi-quality-hq-predvd.html)', () => {
    const { variants } = parseTopicPage(read('multi-quality-hq-predvd.html'), BASE);
    expect(variants.map((v) => v.sizeBytes)).toEqual([
      3 * 1024 ** 3,
      Math.round(1.7 * 1024 ** 3),
      1 * 1024 ** 3,
      800 * 1024 ** 2,
      500 * 1024 ** 2,
      300 * 1024 ** 2,
    ]);
    for (const v of variants) expect(v.sourceTagRaw).toBe('HQ PreDVD');
  });

  it('keeps Original Audio from inventing a language (hindi-original.html)', () => {
    const { variants } = parseTopicPage(read('hindi-original.html'), BASE);
    for (const v of variants) {
      expect(v.audioLangs).toEqual(['hindi']);
      expect(JSON.stringify(v)).not.toMatch(/original/i);
    }
  });

  it('filters audio languages per block, not per topic (season-pack.html)', () => {
    // MANIFEST.md describes this fixture as Tamil + Malayalam blocks. The captured file is
    // Malayalam-only (every block header says Malayalam); what it still proves is that each
    // variant's languages come from its own header line, not from the topic title.
    const { variants } = parseTopicPage(read('season-pack.html'), BASE);
    expect(variants).toHaveLength(3);
    for (const v of variants) {
      expect(v.audioLangs).toEqual(['malayalam']);
      expect(v.audioLangs).not.toContain('tamil');
    }
  });

  it('reads bracketed languages per block (single-episode.html)', () => {
    const { variants } = parseTopicPage(read('single-episode.html'), BASE);
    for (const v of variants) expect(v.audioLangs).toEqual(['hindi', 'english']);
  });

  it('classifies a multi-audio topic without Hindi (multi-audio-orgauds.html)', () => {
    const { variants } = parseTopicPage(read('multi-audio-orgauds.html'), BASE);
    expect(variants.map((v) => v.audioLangs)).toEqual([
      ['tamil', 'english'],
      ['tamil', 'english'],
      ['tamil'],
    ]);
    expect(variants.some((v) => v.audioLangs.includes('hindi'))).toBe(false);
  });
});

/**
 * A block header is per-block evidence; the topic title and the post prose are topic-level. They
 * are collected separately and counted as *places*, because `classify()` may only conclude
 * `not_hindi` when more than one place agrees.
 */
describe('audio evidence places', () => {
  it('counts the topic title and the block header as two places (multi-audio-orgauds.html)', () => {
    const { variants } = parseTopicPage(read('multi-audio-orgauds.html'), BASE);
    // 2, not 3: the attachment anchor repeats the header verbatim, so it is the same place.
    for (const v of variants) expect(v.audioSourceCount).toBe(2);
    // Topic-level languages are kept out of the per-block list (Tamil-dub block stays Tamil).
    expect(variants[0]?.topicAudioLangs).toEqual(['tamil', 'english']);
    expect(variants[2]?.audioLangs).toEqual(['tamil']);
  });

  it('takes Hindi from the topic title when a header omits it (hindi-original.html)', () => {
    const { variants } = parseTopicPage(read('hindi-original.html'), BASE);
    for (const v of variants) {
      expect(v.audioLangs).toEqual(['hindi']);
      expect(v.topicAudioLangs).toContain('hindi');
      expect(v.audioSourceCount).toBe(2);
    }
  });

  it('reports a single place when only the header names a language (season-pack.html)', () => {
    const { variants } = parseTopicPage(read('season-pack.html'), BASE);
    // Title says `DD+5.1 - 192Kbps`, which names a codec, not a language.
    for (const v of variants) {
      expect(v.audioSourceCount).toBe(1);
      expect(v.topicAudioLangs).toEqual([]);
    }
  });

  it('reports zero places when nothing on the page names a language', () => {
    // A magnet-bearing block whose header and title both name no language at all: this is the
    // `NO_AUDIO_TAG` shape, and it must stay undecidable rather than count as one place.
    const html = [
      '<html><head><meta property="og:title" content="Danger - Param Sundari (2026)"></head><body>',
      '<div data-role="commentContent">',
      '<p>Danger - Param Sundari (2026) HQ HDRip - 1080p - x264 - (AAC 2.0) - 2.6GB :<br>',
      `<a href="magnet:?xt=urn:btih:${'b'.repeat(40)}&amp;dn=Scene">MAGNET</a></p>`,
      '</div></body></html>',
    ].join('');
    const { variants } = parseTopicPage(html, BASE);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.audioLangs).toEqual([]);
    expect(variants[0]?.topicAudioLangs).toEqual([]);
    expect(variants[0]?.audioSourceCount).toBe(0);
  });

  it('reads a labelled prose line as its own place (topicAudioLangs)', () => {
    // Shape taken from a live topic (190630): `Audio Tracks: Hindi, Marathi` as a plain line.
    const html = [
      '<html><head><meta property="og:title" content="Movie (2026) HQ HDRip"></head><body>',
      '<div data-role="commentContent">',
      '<p>Audio Tracks: Malayalam</p>',
      '<p>Movie (2026) HQ HDRip - 1080p - x264 - 2.6GB :<br>',
      '<a href="attachment.php?id=1">www.1TamilMV.io - Movie (2026) - 1080p.mkv.torrent</a><br>',
      `<a href="magnet:?xt=urn:btih:${'a'.repeat(40)}&amp;dn=Scene">MAGNET</a></p>`,
      '</div></body></html>',
    ].join('');
    const { variants } = parseTopicPage(html, BASE);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.topicAudioLangs).toEqual(['malayalam']);
    // The header here names no language, so the prose line is the only place that does.
    expect(variants[0]?.audioSourceCount).toBe(1);
    // ... and the per-block list is untouched by it.
    expect(variants[0]?.audioLangs).toEqual([]);
  });

  it('does not treat the repeated title line as a prose place', () => {
    // The first body line of most posts is the topic title verbatim; counting it separately
    // would fake agreement between two copies of the same uploader string.
    const html = read('multi-quality.html');
    const { variants } = parseTopicPage(html, BASE);
    expect(variants[0]?.audioSourceCount).toBe(2);
  });
});

describe('parseTopicPage — pages without magnets', () => {
  it('gdrive-only.html yields no variants but keeps the Drive gates as links', () => {
    const topic = parseTopicPage(read('gdrive-only.html'), BASE);
    expect(topic.variants).toEqual([]);
    const gates = topic.links.filter((l) => l.url.includes('adrinolinks.'));
    expect(gates).toHaveLength(13);
  });

  it('no-audio-tag.html yields no variants and does not throw', () => {
    expect(parseTopicPage(read('no-audio-tag.html'), BASE).variants).toEqual([]);
  });

  it('torrent-no-magnet.html yields one variant per attachment, with no infohash yet', () => {
    const topic = parseTopicPage(read('torrent-no-magnet.html'), BASE);
    expect(topic.variants).toHaveLength(2);
    for (const variant of topic.variants) {
      expect(variant.infohash).toBeNull();
      expect(variant.magnet).toBeNull();
      expect(variant.torrentUrl).toMatch(/attachment\.php\?id=\d+/);
      expect(variant.sizeBytes).toBeGreaterThan(0);
      expect(variant.sourceTagRaw).toContain('HDTC-Rip');
    }
    expect(topic.variants[0]?.resolution).toBe('720p');
  });

  it.each(['home.html', 'pagination.html'])('%s is not a topic page but does not throw', (file) => {
    const topic = parseTopicPage(read(file), BASE);
    expect(topic.variants).toEqual([]);
    expect(Array.isArray(topic.links)).toBe(true);
  });
});

describe('parseTopicPage — links', () => {
  it('excludes the magnet hrefs already attached to variants', () => {
    const topic = parseTopicPage(read('multi-quality.html'), BASE);
    expect(topic.links.length).toBeGreaterThan(0);
    expect(topic.links.some((l) => l.url.startsWith('magnet:'))).toBe(false);
  });

  it('keeps attachment URLs classified as torrent links', () => {
    const topic = parseTopicPage(read('single-quality.html'), BASE);
    expect(topic.links.filter((l) => l.kind === 'torrent').length).toBeGreaterThanOrEqual(2);
  });

  it('dedupes repeated navigation hrefs', () => {
    const { links } = parseTopicPage(read('gdrive-only.html'), BASE);
    const urls = links.map((l) => l.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('per-block title and year', () => {
  it('carries the header title and year on each variant', () => {
    const html = read('hindi-original.html');
    const topic = parseTopicPage(html, 'https://www.1tamilmv.io');
    expect(topic.variants.length).toBeGreaterThan(0);
    for (const variant of topic.variants) {
      expect(variant.title.toLowerCase()).toContain('ramayana');
      expect(variant.year).toBe(2026);
    }
  });
});

describe('resolution inference from the summary line', () => {
  it('gives a resolution to a block whose header omits one, when the summary pairs that size', () => {
    const html = read('multi-quality.html');
    const topic = parseTopicPage(html, BASE);
    const inferred = topic.variants.filter((variant) => variant.sizeBytes === Math.round(2.8 * 1024 ** 3));
    expect(inferred.length).toBe(1);
    expect(inferred[0]?.resolution).toBe('1080p');
  });

  it('leaves a size the summary does not mention unresolved rather than guessing', () => {
    const topic = parseTopicPage(read('multi-quality.html'), BASE);
    const unknown = topic.variants.filter((variant) => variant.resolution === null);
    // 700MB and 400MB rips are not in the summary; they stay unknown and never reach 1080p+.
    for (const variant of unknown) {
      expect(variant.sizeBytes).toBeGreaterThan(0);
    }
  });
});

describe('daily-show topic pages', () => {
  it('parses every dated block header and keeps the resolutions distinct', () => {
    const html = readFileSync(join(dir, 'daily-show-episodes.html'), 'utf8');
    const parsed = parseTopicPage(html, 'https://www.1tamilmv.io');
    // 198 dated headers (66 episodes x 1080p/720p/480p); the page carries 192 magnets, so 192
    // variants have a hash. Three more blocks carry an attachment and no magnet (one episode's
    // 1080p/720p/480p), which are servable since the attachment yields the infohash; the
    // remaining three headers have neither a magnet nor an attachment after them.
    expect(parsed.variants.length).toBe(195);
    const resolved = parsed.variants.filter((variant) => variant.infohash !== null);
    const attachmentOnly = parsed.variants.filter((variant) => variant.infohash === null);
    expect(resolved).toHaveLength(192);
    expect(attachmentOnly).toHaveLength(3);
    for (const variant of attachmentOnly) expect(variant.torrentUrl).toMatch(/attachment\.php/);
    const resolutions = new Set(parsed.variants.map((variant) => variant.resolution));
    expect(resolutions).toEqual(new Set(['1080p', '720p', '480p']));
    for (const variant of resolved) expect(variant.infohash).toMatch(/^[0-9a-f]{40}$/);
    for (const variant of parsed.variants) {
      expect(variant.title).not.toMatch(/\[\d{1,2}-\d{1,2}-\d{4}\]/);
    }
  });
});
