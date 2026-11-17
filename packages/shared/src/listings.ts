export interface ListedTopic {
  sourceTopicId: number;
  slug: string;
  url: string;
  /** View count shown on the row; null when the row does not state one. */
  views: number | null;
}

/**
 * `197.8k` → 197800, `1,234` → 1234. Absent ⇒ null, never 0: zero views is a real value and a
 * missing count must not tie-break as if nobody had looked at the post.
 */
export function parseViewCount(text: string): number | null {
  const match = /([\d.,]+)\s*([km])?/i.exec(text.replace(/^\s+/, ''));
  if (!match?.[1]) return null;
  const base = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  return Math.round(base * scale);
}

const VIEWS_IN_ROW = /data-statType=['"]num_views['"][\s\S]{0,200}?ipsDataItem_stats_number['"]>\s*([\d.,]+\s*[km]?)/i;

function viewsOf(row: string): number | null {
  const match = VIEWS_IN_ROW.exec(row);
  return match?.[1] ? parseViewCount(match[1]) : null;
}

/**
 * A slug is any non-slash path segment: titles with a non-breaking space arrive URL-encoded
 * (`%C2%A0`), and the old `[a-z0-9_.-]` class silently dropped half of a listing page's rows —
 * those topics were never even enqueued, which is one reason sections looked half-empty.
 */
const TOPIC_HREF = /href=['"]([^'"]*?forums\/topic\/(\d+)-([^'"\/]+)\/?)['"]/gi;
const PAGE_OF = /Page (\d+) of ([0-9,]+)/i;
/**
 * The topic list is one container (`cTopicList`); everything before it is navigation, banners and
 * widgets, and everything after the list is footer. Without this bound a listing parser happily
 * reads the home page's "TOP RELEASES THIS WEEK" banner and returns ~800 topics for one page —
 * which is exactly how 723 topics were once filed under a single forum.
 */
export const TOPIC_LIST_MARKER = 'cTopicList';

/** True when the page carries the topic-list container at all. */
export function hasTopicList(html: string): boolean {
  return html.includes(TOPIC_LIST_MARKER);
}

/**
 * An empty board renders this empty-state block *instead of* the topic list, so `hasTopicList()` is
 * false exactly when the forum has nothing in it (`empty-forum.html`; forums 26 and 71). A caller
 * that only trusts the container dead-letters every genuinely empty forum, forever.
 */
const EMPTY_FORUM_MARKER = 'There are no topics in this forum yet';

/** True when the page is a board that states it has no topics — an answer, not a parse failure. */
export function isEmptyForumPage(html: string): boolean {
  return html.includes(EMPTY_FORUM_MARKER);
}
/** The list itself is ~100 KB on the largest forum page; the cap only guards against a runaway slice. */
const MAX_LISTING_CHARS = 200_000;

function absolute(baseUrl: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${baseUrl.replace(/\/$/, '')}/${href.replace(/^\//, '')}`;
}

/** `topic/183-0` is a navigation stub present on every page and is not a release. */
function collect(html: string, baseUrl: string): ListedTopic[] {
  const seen = new Set<number>();
  const topics: ListedTopic[] = [];
  const hrefs = [...html.matchAll(TOPIC_HREF)];
  for (let i = 0; i < hrefs.length; i++) {
    const match = hrefs[i] as RegExpExecArray;
    const id = Number(match[2]);
    const slug = match[3] ?? '';
    if (!id || slug === '0' || seen.has(id)) continue;
    seen.add(id);
    // The row's own stats sit between this topic link and the next one, so the view count can
    // never be borrowed from a neighbour (the site shows both `replies` and `views` per row).
    const start = match.index ?? 0;
    const end = hrefs[i + 1]?.index ?? start + 4000;
    topics.push({
      sourceTopicId: id,
      slug,
      url: absolute(baseUrl, (match[1] ?? '').replace(/&amp;/g, '&')),
      views: viewsOf(html.slice(start, end)),
    });
  }
  return topics;
}

export function parseListingPage(html: string, baseUrl: string): { topics: ListedTopic[]; totalPages: number } {
  const pageMatch = PAGE_OF.exec(html);
  const totalPages = pageMatch?.[2] ? Number(pageMatch[2].replace(/,/g, '')) : 1;
  // No topic-list container means this is not a listing: a board index, a language hub or an error
  // page. Returning no topics makes the caller fail loudly instead of caching the wrong section.
  const start = html.indexOf(TOPIC_LIST_MARKER);
  if (start < 0) return { topics: [], totalPages };
  return { topics: collect(html.slice(start, start + MAX_LISTING_CHARS), baseUrl), totalPages };
}

export const HOME_SECTIONS = ['TOP RELEASES THIS WEEK', 'Week Releases', 'RECENTLY ADDED'] as const;

/**
 * Collect topics from the three watched sections only.
 *
 * The home page carries hundreds of topic links (forum widgets, "latest posts", sidebars), so
 * scanning the whole document would enqueue ~800 delta tasks instead of ~30 and turn a
 * three-minute daily job into an hour of needless crawling. Each section is therefore bounded
 * by the start of the next one.
 */
export function parseHomeSections(html: string, baseUrl: string): { topics: ListedTopic[]; sections: string[] } {
  const found = HOME_SECTIONS.map((name) => ({ name, at: html.indexOf(name) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);

  if (found.length === 0) return { topics: [], sections: [] };

  const seen = new Set<number>();
  const topics: ListedTopic[] = [];
  // A section ends at the next watched section or after MAX_SECTION_CHARS — the page then
  // continues with unrelated widgets that also link topics.
  const MAX_SECTION_CHARS = 40_000;
  found.forEach((entry, index) => {
    const nextAt = index + 1 < found.length ? (found[index + 1] as { at: number }).at : html.length;
    const end = Math.min(nextAt, entry.at + MAX_SECTION_CHARS);
    for (const topic of collect(html.slice(entry.at, end), baseUrl)) {
      if (seen.has(topic.sourceTopicId)) continue;
      seen.add(topic.sourceTopicId);
      topics.push(topic);
    }
  });

  return { topics, sections: found.map((entry) => entry.name) };
}

/**
 * The forum a topic belongs to, taken from its own breadcrumb. Needed because the home page
 * lists topics without saying which forum they came from, and filing them under a guessed forum
 * would attribute a Hindi release to the wrong language section.
 */
export function forumRefFromHtml(html: string): { sourceForumId: number; slug: string } | null {
  return forumRefsFromHtml(html)[0] ?? null;
}

/**
 * Every forum a page links, in document order. A topic's breadcrumb can name several (parent
 * category first, then the leaf), and the first one may be a category we do not crawl — so the
 * caller picks the first *seeded* forum rather than blindly taking index 0.
 */
export function forumRefsFromHtml(html: string): Array<{ sourceForumId: number; slug: string }> {
  const seen = new Set<number>();
  const refs: Array<{ sourceForumId: number; slug: string }> = [];
  for (const match of html.matchAll(/forums\/forum\/(\d+)-([a-z0-9-]+)\//gi)) {
    const sourceForumId = Number(match[1]);
    const slug = match[2];
    if (!slug || !Number.isFinite(sourceForumId) || sourceForumId <= 0 || seen.has(sourceForumId)) continue;
    seen.add(sourceForumId);
    refs.push({ sourceForumId, slug });
  }
  return refs;
}
