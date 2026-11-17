import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasTopicList, isEmptyForumPage, parseHomeSections, parseListingPage, parseViewCount } from '../src/listings.js';

const dir = join(import.meta.dirname, 'fixtures');
const read = (file: string) => readFileSync(join(dir, file), 'utf8');

describe('parseListingPage scope', () => {
  const BASE = 'https://www.1tamilmv.io';

  it('returns exactly the topic rows of a real listing page', () => {
    const { topics, totalPages } = parseListingPage(read('forum-listing.html'), BASE);
    expect(topics).toHaveLength(25);
    expect(totalPages).toBe(46);
  });

  it('returns only the rows on the last page', () => {
    const { topics, totalPages } = parseListingPage(read('forum-listing-last.html'), BASE);
    expect(topics).toHaveLength(6);
    expect(totalPages).toBe(46);
  });

  it('returns nothing for the board index, so a wrong url cannot become a listing', () => {
    expect(parseListingPage(read('home.html'), BASE).topics).toHaveLength(0);
  });

  it('returns nothing for a language hub page', () => {
    expect(parseListingPage(read('forum-hub.html'), BASE).topics).toHaveLength(0);
  });
});

describe('parseListingPage', () => {
  const html = read('pagination.html');

  it('extracts topic urls with ids and slugs', () => {
    const { topics } = parseListingPage(html, 'https://www.1tamilmv.io');
    expect(topics.length).toBeGreaterThanOrEqual(20);
    for (const topic of topics) {
      expect(topic.sourceTopicId).toBeGreaterThan(0);
      expect(topic.slug).not.toBe('0');

    }
  });

  it('drops the topic/183-0 navigation stub', () => {
    const { topics } = parseListingPage(html, 'https://www.1tamilmv.io');
    expect(topics.some((topic) => topic.slug === '0')).toBe(false);
  });

  it('reads the total page count', () => {
    expect(parseListingPage(html, 'https://www.1tamilmv.io').totalPages).toBeGreaterThan(1);
  });

  it('dedupes by topic id', () => {
    const { topics } = parseListingPage(html, 'https://www.1tamilmv.io');
    expect(new Set(topics.map((topic) => topic.sourceTopicId)).size).toBe(topics.length);
  });
});

describe('parseHomeSections', () => {
  const html = read('home.html');

  it('finds the three watched sections', () => {
    const { sections } = parseHomeSections(html, 'https://www.1tamilmv.io');
    expect(sections).toContain('TOP RELEASES THIS WEEK');
    expect(sections).toContain('Week Releases');
    expect(sections).toContain('RECENTLY ADDED');
  });

  it('extracts topics and dedupes them', () => {
    const { topics } = parseHomeSections(html, 'https://www.1tamilmv.io');
    expect(topics.length).toBeGreaterThan(10);
    expect(new Set(topics.map((topic) => topic.sourceTopicId)).size).toBe(topics.length);
  });

  it('produces absolute urls', () => {
    const { topics } = parseHomeSections(html, 'https://www.1tamilmv.io');
    for (const topic of topics) expect(topic.url).toMatch(/^https?:\/\//);
  });
});

describe('parseHomeSections scoping', () => {
  it('does not sweep the whole home page (it carries hundreds of unrelated topic links)', () => {
    const { topics } = parseHomeSections(read('home.html'), 'https://www.1tamilmv.io');
    expect(topics.length).toBeGreaterThan(5);
    expect(topics.length).toBeLessThan(120);
  });
});

describe('forumRefsFromHtml', () => {
  it('returns every forum link in document order, de-duplicated', async () => {
    const { forumRefsFromHtml } = await import('../src/listings.js');
    const html = read('multi-quality.html');
    const refs = forumRefsFromHtml(html);
    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs.map((ref) => ref.sourceForumId)).size).toBe(refs.length);
  });

  it('lets the caller pick the first seeded forum, not blindly index 0', async () => {
    const { forumRefsFromHtml } = await import('../src/listings.js');
    const refs = forumRefsFromHtml(read('multi-quality.html'));
    // A topic breadcrumb can name a parent category first; the crawler must scan for a seeded one.
    expect(refs.length).toBeGreaterThan(1);
  });
});

describe('empty forum pages', () => {
  it('is still a listing when the container is present but has no rows', () => {
    const html = '<html><ol class="ipsDataList cTopicList"></ol><span>Page 1 of 1</span></html>';
    expect(parseListingPage(html, 'https://www.1tamilmv.io').topics).toHaveLength(0);
    expect(hasTopicList(html)).toBe(true);
  });

  it('is not a listing when the container is missing', () => {
    expect(hasTopicList(read('home.html'))).toBe(false);
    expect(hasTopicList(read('forum-hub.html'))).toBe(false);
    expect(hasTopicList(read('forum-listing.html'))).toBe(true);
  });

  it('recognises the empty-state block a board renders instead of the list', () => {
    const page = read('empty-forum.html');
    expect(isEmptyForumPage(page)).toBe(true);
    // The container is absent exactly when the board is empty, which is why it cannot be the test.
    expect(hasTopicList(page)).toBe(false);
    expect(isEmptyForumPage(read('forum-listing.html'))).toBe(false);
    expect(isEmptyForumPage(read('home.html'))).toBe(false);
  });
});

describe('view counts', () => {
  it('parses a compact count from a listing row', () => {
    expect(parseViewCount('197.8k')).toBe(197800);
    expect(parseViewCount('1.2m')).toBe(1200000);
    expect(parseViewCount('42')).toBe(42);
    expect(parseViewCount('1,234')).toBe(1234);
    expect(parseViewCount('')).toBeNull();
  });

  it('attaches each row its own view count', () => {
    const row = (id: number, views: string) =>
      `<li class="ipsDataItem" data-rowID="${id}"><a href="https://www.1tamilmv.io/index.php?/forums/topic/${id}-film-${id}/">x</a>` +
      `<li data-statType="num_views"><span class="ipsDataItem_stats_number">${views}</span><span> views</span></li></li>`;
    const html = `<ol class="ipsDataList cTopicList">${row(101, '197.8k')}${row(102, '5')}</ol><span>Page 1 of 3</span>`;

    const { topics } = parseListingPage(html, 'https://www.1tamilmv.io');

    expect(topics.map((topic) => [topic.sourceTopicId, topic.views])).toEqual([
      [101, 197800],
      [102, 5],
    ]);
  });
});
