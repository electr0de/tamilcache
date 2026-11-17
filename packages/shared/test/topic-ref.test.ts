import { describe, expect, it } from 'vitest';
import { parseTopicPage } from '../src/topic-parser.js';

const BASE = 'https://www.1tamilmv.io';

/** The canonical link carries the slug the site serves; everything else in the page is noise. */
const page = (canonicalSlug: string): string => `
<html><head>
<link rel="canonical" href="https://www.1tamilmv.io/index.php?/forums/topic/${canonicalSlug}/" />
<title>Test Topic - 1TamilMV</title>
</head><body><div data-role="commentContent">plain body</div></body></html>`;

describe('topic ref parsing', () => {
  it('parses a plain slug', () => {
    const parsed = parseTopicPage(page('201035-atmos-the-odyssey-2026'), BASE);
    expect(parsed.sourceTopicId).toBe(201035);
    expect(parsed.slug).toBe('atmos-the-odyssey-2026');
  });

  it('parses a slug that begins with a percent-encoded symbol', () => {
    // June 2026 soundtracks are posted as "◗◖ ATMOS …", which the site URL-encodes to
    // %E2%97%97%E2%97%96. Requiring an ASCII first character rejected 79 topics outright.
    const parsed = parseTopicPage(page('201035-%E2%97%97%E2%97%96-atmos-the-odyssey-2026'), BASE);
    expect(parsed.sourceTopicId).toBe(201035);
    expect(parsed.slug.startsWith('◗◖')).toBe(true);
  });

  it('parses a slug that begins with a zero-width space', () => {
    const parsed = parseTopicPage(page('189820-%E2%80%8B%E2%80%8Bkaiju-no-8-s01-1080p'), BASE);
    expect(parsed.sourceTopicId).toBe(189820);
  });

  it('ignores the navigation entry topic/183-0 that every page links', () => {
    const html = `
<html><head><title>No canonical - 1TamilMV</title></head><body>
<a href="https://www.1tamilmv.io/index.php?/forums/topic/183-0/">nav</a>
</body></html>`;
    expect(parseTopicPage(html, BASE).sourceTopicId).toBeNull();
  });
});
