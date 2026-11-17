import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSeasonEpisode } from '../src/episode-range.js';

const fixtureDir = join(import.meta.dirname, 'fixtures');

/**
 * Slug of the topic a fixture page *is*, read from its canonical permalink
 * (`…/forums/topic/NNN-<slug>/`). Sibling topic links on the page point at
 * unrelated threads (e.g. `topic/183-0`), so the canonical href is the only
 * unambiguous anchor.
 */
function canonicalSlug(file: string): string {
  const html = readFileSync(join(fixtureDir, file), 'utf8');
  const href = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
  if (!href) throw new Error(`no canonical href in ${file}`);
  const slug = /forums\/topic\/\d+-([^/"?]+)/.exec(href)?.[1];
  if (!slug) throw new Error(`no topic slug in ${href}`);
  return slug;
}

describe('parseSeasonEpisode', () => {
  it.each([
    ['s01-ep-01-08', { season: 1, epFrom: 1, epTo: 8, isPack: true }],
    ['vadhandhi-2022-s01-ep-01-08-true-web-dl', { season: 1, epFrom: 1, epTo: 8, isPack: true }],
    ['vikram-on-duty-2025-s01-ep-01-04', { season: 1, epFrom: 1, epTo: 4, isPack: true }],
    ['s04-ep01-08', { season: 4, epFrom: 1, epTo: 8, isPack: true }],
    ['panchayat-2025-s04-ep01-08-hindi', { season: 4, epFrom: 1, epTo: 8, isPack: true }],
    // from === to means a single episode, not a one-episode pack
    ['cooku-with-comali-2026-tamil-s07-ep01-01', { season: 7, epFrom: 1, epTo: 1, isPack: false }],
    ['s01-ep-03', { season: 1, epFrom: 3, epTo: 3, isPack: false }],
    ['some-show-2026-s01-ep-03', { season: 1, epFrom: 3, epTo: 3, isPack: false }],
    ['some-show-2026-season-2-episode-5', { season: 2, epFrom: 5, epTo: 5, isPack: false }],
    // S01E05 — the commonest TV naming there is, and `s01` alone did not match
    ['cid-tamil-s01e05-1080p', { season: 1, epFrom: 5, epTo: 5, isPack: false }],
    ['tamil-idol-2026-s01e05-1080p-view-online', { season: 1, epFrom: 5, epTo: 5, isPack: false }],
    // a 3-digit season: the forum writes season 10 as `s010`
    ['bigg-boss-tamil-2026-s010-ep66-day-65', { season: 10, epFrom: 66, epTo: 66, isPack: false }],
    // `e45` must not be read as the range 4→5
    ['wwe-friday-night-smackdown-s28e45-usa-2026-11-06', { season: 28, epFrom: 45, epTo: 45, isPack: false }],
    // a quality token must not be read as the range end
    ['some-show-2026-s01-ep-03-720p', { season: 1, epFrom: 3, epTo: 3, isPack: false }],
    ['some-show-2026-s01-ep01-450mb', { season: 1, epFrom: 1, epTo: 1, isPack: false }],
    // no separator between season and episode, so the `ep\d` lookahead alternative is the one that matches
    ['some-show-2026-s01ep05-1080p', { season: 1, epFrom: 5, epTo: 5, isPack: false }],
    // the `to` spelling of a range
    ['some-show-2026-s01-ep-03-to-07', { season: 1, epFrom: 3, epTo: 7, isPack: true }],
    // a second 3-digit season, so `s010` = season 10 is not resting on one slug
    ['bigg-boss-telugu-2026-s010-ep06-day-05-true-web-dl-1080p-720p-480p-avc-untouched-25gb-1gb-450mb', { season: 10, epFrom: 6, epTo: 6, isPack: false }],
  ])('parses %s', (slug, expected) => {
    expect(parseSeasonEpisode(slug)).toEqual(expected);
  });

  it.each([
    ['a-movie-2025-1080p'],
    ['jailer-2-2026-tamil-true-web-dl-1080p-720p'],
    ['scene-2026-tamil-hq-hdts-1080p-720p-x264-26gb-14gb-900mb-x264-700mb-400mb-250mb-hq-clean-audio'],
    [''],
    ['not-a-slug-at-all'],
  ])('returns null without season info: %s', (slug) => {
    expect(parseSeasonEpisode(slug)).toBeNull();
  });

  it('resolves a bare season marker to episode 1 so downstream always has a range', () => {
    // a full-season post titled just "S02" carries no episode number; the plan
    // resolves it to episode 1 so downstream code always has a usable range
    expect(parseSeasonEpisode('show-2026-s02-1080p')).toEqual({
      season: 2,
      epFrom: 1,
      epTo: 1,
      isPack: false,
    });
  });
});

describe('parseSeasonEpisode on captured fixtures', () => {
  it('reads a multi-episode pack slug as a pack (season-pack.html)', () => {
    const slug = canonicalSlug('season-pack.html');
    expect(slug).toContain('panthadikkaam-2026-s01-ep-01-05');
    expect(parseSeasonEpisode(slug)).toEqual({ season: 1, epFrom: 1, epTo: 5, isPack: true });
  });

  it('reads a single-episode slug as a single episode (single-episode.html)', () => {
    const slug = canonicalSlug('single-episode.html');
    expect(slug).toContain('it-welcome-to-derry-2025-s01-ep01');
    expect(parseSeasonEpisode(slug)).toEqual({ season: 1, epFrom: 1, epTo: 1, isPack: false });
  });

  it('returns null for a movie topic slug (no season in multi-quality.html)', () => {
    expect(parseSeasonEpisode(canonicalSlug('multi-quality.html'))).toBeNull();
  });
});
