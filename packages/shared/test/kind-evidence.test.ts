import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { kindEvidence } from '../src/kind-evidence.js';

describe('kindEvidence', () => {
  it.each([
    ['panthadikkaam-2026-s01-ep-01-05-true-web-dl', 'show', 'strong'],
    ['cid-tamil-s01e05-1080p-view-online', 'show', 'strong'],
    ['bigg-boss-tamil-2026-s010-ep66-day-65', 'show', 'strong'],
    ['bharathi-kannamma-14th-november-2025-720p', 'show', 'weak'],
    ['some-random-upload-with-no-year', 'unknown', 'none'],
    ['sardar-2-2026-tamil-v2-hq-predvd-1080p', 'movie', 'weak'],
    ['a-minecraft-movie-2025-hindi-hdtc', 'movie', 'weak'],
    ['love-insurance-kompany-trailer-pradeep-ranganathan', 'other', 'strong'],
    ['sivaji-2007-all-video-songs-bd50-4k', 'other', 'strong'],
    ['vishwanath-and-sons-2026-tamil-audio-launch-true-web-dl', 'other', 'strong'],
  ])('%s → %s (%s)', (slug, kind, confidence) => {
    expect(kindEvidence({ slug, rawTitle: '' })).toMatchObject({ kind, confidence });
  });

  it('uses recurrence across days as a show signal', () => {
    expect(kindEvidence({ slug: 'some-soap-2026-720p', rawTitle: '', recurrence: { topics: 4, days: 4 } }))
      .toMatchObject({ kind: 'show', confidence: 'strong' });
  });

  it('reports why it decided', () => {
    expect(kindEvidence({ slug: 'cid-tamil-s01e05-1080p', rawTitle: '' }).reasons).toContain('episode token');
  });
});

function fixtureSlugs(): string[] {
  const dir = join(import.meta.dirname, 'fixtures');
  const slugs = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(join(dir, file), 'utf8');
    for (const match of html.matchAll(/index\.php\?\/forums\/topic\/\d+-([a-z0-9-]+)/g)) {
      if (match[1]) slugs.add(match[1]);
    }
  }
  return [...slugs];
}

describe('fixture corpus regression', () => {
  it('flags at least 131 of the fixture slugs as tv', () => {
    const slugs = fixtureSlugs();
    // Floor, not equality: recognising one more convention is an improvement, losing one is a bug.
    // Measured 2026-11-12: 131 show / 1008 slugs. The design doc's 127/986 predates this counting.
    expect(slugs.length).toBeGreaterThanOrEqual(900);
    const shows = slugs.filter((slug) => kindEvidence({ slug, rawTitle: '' }).kind === 'show').length;
    expect(shows).toBeGreaterThanOrEqual(131);
  });
});
