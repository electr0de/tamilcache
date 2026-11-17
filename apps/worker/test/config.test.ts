import { describe, expect, it } from 'vitest';
import { forumUrl, loadForumConfig, loadScope, scopeViolations } from '../src/config.js';

const BASE = 'https://www.1tamilmv.io';

describe('forumUrl', () => {
  it('puts the source forum id in the path, because the site routes on it', () => {
    expect(forumUrl(BASE, { id: 57, slug: 'predvd-dvdscr-cam-tc' })).toBe(
      `${BASE}/index.php?/forums/forum/57-predvd-dvdscr-cam-tc/`,
    );
  });

  it('does not double the id when the slug already carries it', () => {
    expect(forumUrl(BASE, { id: 64, slug: '64-hindi-dubbed-movies' })).toBe(
      `${BASE}/index.php?/forums/forum/64-hindi-dubbed-movies/`,
    );
  });

  it('appends the page suffix the site canonicalises to', () => {
    expect(forumUrl(BASE, { id: 12, slug: 'hd-rips-dvd-rips-br-rips' }, 46)).toBe(
      `${BASE}/index.php?/forums/forum/12-hd-rips-dvd-rips-br-rips/page/46/`,
    );
    expect(forumUrl(BASE, { id: 12, slug: 'hd-rips-dvd-rips-br-rips' }, 1)).toBe(
      `${BASE}/index.php?/forums/forum/12-hd-rips-dvd-rips-br-rips/`,
    );
  });

  it('decides every configured board and never configures an excluded one', () => {
    expect(scopeViolations(loadForumConfig(), loadScope())).toEqual([]);
  });

  it('records a reason for every exclusion', () => {
    for (const entry of loadScope().values()) {
      if (!entry.include) expect(entry.reason.length).toBeGreaterThan(3);
    }
  });

  it('excludes the songs, cinema-news, general, members-lounge and live-tv boards', () => {
    const scope = loadScope();
    for (const id of [15, 16, 18, 28, 30, 32, 40, 41, 43, 51, 52, 54, 62, 63, 65, 73, 74, 76]) {
      expect(scope.get(id)?.include, `board ${id} is songs or news`).toBe(false);
    }
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 93, 94, 105]) {
      expect(scope.get(id)?.include, `board ${id} is a site section`).toBe(false);
    }
  });

  it('includes the WWE show boards', () => {
    const scope = loadScope();
    for (const id of [106, 108, 109]) expect(scope.get(id)?.include).toBe(true);
  });

  it('gives every configured forum a distinct url', () => {
    const config = loadForumConfig();
    const urls = config.map((forum) => forumUrl(BASE, forum));
    expect(new Set(urls).size).toBe(config.length);
  });
});

describe('forum allowlist', () => {
  const config = loadForumConfig();

  it('covers every in-scope language section, Kannada included', () => {
    const ids = new Set(config.map((forum) => forum.id));
    // Language hubs plus their release subforums; the site serves both shapes.
    for (const id of [9, 10, 11, 12, 13, 14, 17, 19]) expect(ids.has(id)).toBe(true);
    for (const id of [22, 23, 24, 25, 26, 27, 31, 33]) expect(ids.has(id)).toBe(true);
    for (const id of [34, 35, 36, 37, 38, 39, 42, 44]) expect(ids.has(id)).toBe(true);
    for (const id of [45, 46, 49, 50, 55]) expect(ids.has(id)).toBe(true);
    for (const id of [56, 57, 58, 59, 60, 61, 64, 66]) expect(ids.has(id)).toBe(true);
    for (const id of [67, 68, 69, 70, 71, 72, 75, 77]) expect(ids.has(id)).toBe(true);
  });

  it('leaves songs, news, requests and lounge out', () => {
    const ids = new Set(config.map((forum) => forum.id));
    for (const id of [15, 16, 18, 28, 30, 32, 40, 41, 43, 51, 52, 54, 62, 63, 65]) expect(ids.has(id)).toBe(false);
    for (const id of [73, 74, 76]) expect(ids.has(id)).toBe(false);
    for (const id of [89, 90, 91, 92, 93, 94]) expect(ids.has(id)).toBe(false);
    // Board 105 is the WWE *hub* (a container); its three children are TV shows and are crawled.
    expect(ids.has(105)).toBe(false);
  });

  it('crawls the WWE show boards, because they are TV', () => {
    const ids = new Set(config.map((forum) => forum.id));
    for (const id of [106, 108, 109]) expect(ids.has(id)).toBe(true);
  });
});
