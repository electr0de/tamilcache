import { pathToFileURL } from 'node:url';
import { openDb, type Db } from '@tamilcache/db';
import { sql } from 'drizzle-orm';
import { forumUrl, loadForumConfig, loadScope, mirrorList, type ForumConfig, type ScopeEntry } from './config.js';
import { parseListingPage } from '@tamilcache/shared';
import { setState } from './state.js';

export interface AuditHttp {
  get(url: string): Promise<{ status: number; body: string; url: string }>;
}

export interface DiscoveredBoard {
  id: number;
  slug: string;
  /** The site's own label for the board, read from its own breadcrumb. */
  title: string;
  /** The language section, taken from config — the page a board was *listed on* is unreliable. */
  hub: { title: string };
}

/** Section label per configured language, so a board lands under "Tamil" not under its board slug. */
const SECTION: Record<string, string> = {
  tamil: 'Tamil',
  telugu: 'Telugu',
  malayalam: 'Malayalam',
  hindi: 'Hindi',
  kannada: 'Kannada',
  english: 'English',
  multi: 'Multi-audio',
  watch: 'Watch online',
};

export type BoardScope = 'include' | 'exclude' | 'undecided';

export interface BoardCoverage {
  id: number;
  /** The site's display title; `name` keeps the slug for logs and older callers. */
  title: string;
  /** The language/section, by title: a section is not a forum and has no id. */
  hub: { title: string };
  name: string;
  scope: BoardScope;
  /** Pages the site has, or null when the board is excluded or its page 1 could not be read. */
  pagesOnSite: number | null;
  /** Distinct listing pages the crawler recorded for this board. */
  pagesCovered: number;
  slots: number | null;
  fetched: number;
  stored: number;
  byStatus: Record<string, number>;
}

export interface CoverageReport {
  boards: BoardCoverage[];
  problems: string[];
  exitCode: number;
}

/**
 * The board links a forum index or a hub page carries. Both render one `data-forumID` row per
 * board with a `/forums/forum/<id>-<slug>/` anchor, which is the only stable identifier the site
 * exposes — the slug alone is ambiguous (five languages share `predvd-dvdscr-cam-tc`).
 */
export function parseBoardIndex(html: string): Array<{ id: number; slug: string }> {
  const boards = new Map<number, { id: number; slug: string }>();
  for (const match of html.matchAll(/\/forums\/forum\/(\d+)-([a-z0-9-]+)\/?/gi)) {
    const id = Number(match[1]);
    const slug = match[2];
    if (!Number.isFinite(id) || id === 0 || !slug || slug === '0') continue;
    if (!boards.has(id)) boards.set(id, { id, slug });
  }
  return [...boards.values()];
}


function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

/** `&amp;` and friends arrive in board labels ("Post &amp; Share Here"). */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** Section label per configured language, so a board lands under "Tamil" not under its slug. */
/** The page's own heading (`Members Lounge - 1TamilMV`), used for boards config does not decide. */
function containerTitle(html: string): string {
  const title = /<title>([^<]{1,80})<\/title>/i.exec(html)?.[1] ?? '';
  return (
    title
      .replace(/\s*-\s*1TamilMV\s*$/i, '')
      // `Tamil Language` is the hub's own title; config calls the same section `Tamil`, and one
      // language must not be split across two sections by a suffix.
      .replace(/\s+Language$/i, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Other'
  );
}

function sectionFor(config: ForumConfig[], id: number): { title: string } {
  const language = config.find((forum) => forum.id === id)?.language ?? 'unknown';
  return { title: SECTION[language] ?? 'Other' };
}

/**
 * Boards, with the title the site shows, discovered from the pages that *list* boards.
 *
 * The forum index mixes hubs and boards (its "latest post" widgets link boards directly), so the
 * container test is behavioural: a page that renders `data-forumID` rows is a hub listing its
 * children; a page that renders topic rows is a board, and its own title is not needed twice.
 */
async function discoverBoards(
  http: AuditHttp,
  baseUrl: string,
  config: ForumConfig[],
): Promise<DiscoveredBoard[]> {
  const root = `${baseUrl.replace(/\/$/, '')}/index.php?/forums/`;
  const candidates = parseBoardIndex((await http.get(root)).body);
  const boards = new Map<number, DiscoveredBoard>();
  for (const candidate of candidates) {
    let body = '';
    try {
      body = (await http.get(forumUrl(baseUrl, candidate))).body;
    } catch {
      // A page that cannot be read is reported through its boards being missing, not hidden.
      continue;
    }
    const rows = [...body.matchAll(/data-forumID=["'](\d+)["']/gi)];
    if (rows.length === 0) continue;
    for (const row of rows) {
      const id = Number(row[1]);
      if (!Number.isFinite(id) || id === 0 || boards.has(id)) continue;
      const segment = body.slice(row.index, row.index + 900);
      const link = new RegExp(`/forums/forum/${id}-([a-z0-9-]+)/?["'][^>]*>([\\s\\S]{0,200}?)</a>`, 'i').exec(segment);
      const slug = link?.[1];
      if (!slug) continue;
      const title = stripTags(decodeEntities(link?.[2] ?? '')).replace(/\s+/g, ' ').trim();
      const known = config.some((forum) => forum.id === id);
      const hub = known ? sectionFor(config, id) : { title: containerTitle(body) };
      boards.set(id, { id, slug, title: title === '' ? slug : title, hub });
    }
  }
  return [...boards.values()];
}

function count(db: Db, query: ReturnType<typeof sql>): number {
  return db.get<{ n: number }>(query)?.n ?? 0;
}

function coverageOf(db: Db, board: DiscoveredBoard, scope: Map<number, ScopeEntry>): BoardCoverage {
  const entry = scope.get(board.id);
  const forum = db.get<{ id: number }>(sql`SELECT id FROM forums WHERE source_forum_id = ${board.id}`);
  const byStatus: Record<string, number> = {};
  let stored = 0;
  if (forum) {
    for (const row of db.all<{ status: string; n: number }>(
      sql`SELECT status, COUNT(*) AS n FROM topics WHERE forum_id = ${forum.id} GROUP BY status`,
    )) {
      byStatus[row.status] = row.n;
      stored += row.n;
    }
  }
  // Pages 1..next_page-1 have been visited by definition, and page 1 is usually fetched by the
  // *delta* lane (which does not log `backfill.page`), so the logged set alone reads one page
  // short on every board. The cursor is the authoritative count.
  const cursor = forum
    ? db.get<{ next_page: number | null }>(sql`SELECT next_page FROM backfill_state WHERE forum_id = ${forum.id}`)
    : undefined;
  const loggedPages = forum
    ? count(
        db,
        sql`SELECT COUNT(DISTINCT json_extract(detail, '$."page"')) AS n FROM log_events WHERE event = 'backfill.page' AND forum_id = ${forum.id}`,
      )
    : 0;
  return {
    id: board.id,
    title: board.title,
    hub: board.hub,
    name: board.slug,
    scope: entry === undefined ? 'undecided' : entry.include ? 'include' : 'exclude',
    pagesOnSite: null,
    pagesCovered: Math.max(loggedPages, Math.max(0, (cursor?.next_page ?? 1) - 1)),
    slots: null,
    fetched: forum
      ? count(
          db,
          sql`SELECT COUNT(*) AS n FROM crawl_tasks WHERE kind = 'topic' AND state = 'done' AND json_extract(payload, '$."forumId"') = ${forum.id}`,
        )
      : 0,
    stored,
    byStatus,
  };
}

/**
 * Proves the crawl matches the site instead of trusting our own counters.
 *
 * Three independent sources: the site (page counts), `backfill_state`/`log_events` (pages we
 * visited) and `crawl_tasks` (topic pages we fetched). A board is covered only when all agree,
 * and a board the site serves with no scope decision is a hard failure — that is what stops
 * coverage drifting silently when the site adds a section.
 */
export async function auditCoverage(
  db: Db,
  scope: Map<number, ScopeEntry>,
  http: AuditHttp,
  options: { boards?: number[]; config?: ForumConfig[]; baseUrl?: string } = {},
): Promise<CoverageReport> {
  const baseUrl = options.baseUrl ?? 'https://www.1tamilmv.io';
  const config = options.config ?? [];
  const discovered = (await discoverBoards(http, baseUrl, config)).filter(
    (board) => options.boards === undefined || options.boards.includes(board.id),
  );
  const problems: string[] = [];
  const boards: BoardCoverage[] = [];

  for (const board of discovered) {
    const coverage = coverageOf(db, board, scope);
    if (coverage.scope === 'undecided') problems.push(`board ${board.id} has no scope decision`);
    if (coverage.scope === 'include') {
      try {
        const url = forumUrl(baseUrl, board);
        const body = (await http.get(url)).body;
        const { totalPages } = parseListingPage(body, baseUrl);
        coverage.pagesOnSite = totalPages;
        coverage.slots = totalPages * 25;
      } catch (error) {
        problems.push(`board ${board.id}: page 1 could not be read (${(error as Error).message})`);
      }
    }
    if (coverage.pagesOnSite !== null && coverage.pagesCovered > coverage.pagesOnSite) {
      // The cursor can sit one past the last page (an extra fetch that redirected), and reporting
      // `9/8` looks like a bug in the crawler rather than the bookkeeping it is.
      coverage.pagesCovered = coverage.pagesOnSite;
    }
    boards.push(coverage);
    if (coverage.scope !== 'include') continue;
    if (coverage.pagesOnSite !== null && coverage.pagesCovered < coverage.pagesOnSite) {
      problems.push(`board ${board.id}: ${coverage.pagesCovered} of ${coverage.pagesOnSite} pages`);
    }
    const state = db.get<{ done: number }>(
      sql`SELECT done FROM backfill_state WHERE forum_id = (SELECT id FROM forums WHERE source_forum_id = ${board.id})`,
    );
    if (state && state.done !== 1) problems.push(`board ${board.id}: backfill not finished`);
    // Page coverage is the reliable signal. A topic-count ratio is not: `enqueue` dedupes by URL
    // across the whole site, so a topic posted in two boards is fetched once and attributed to
    // whichever board queued it first — the other board looks short through no fault of its own.
    // One page with no fetched topic is still worth flagging: that board was never paged into.
    if (coverage.pagesOnSite !== null && coverage.pagesOnSite > 1 && coverage.fetched === 0) {
      problems.push(`board ${board.id}: ${coverage.pagesOnSite} pages on the site, none fetched`);
    }
  }

  return { boards, problems, exitCode: problems.length > 0 ? 1 : 0 };
}

export function formatReport(report: CoverageReport): string {
  const lines = report.boards.map((board) => {
    const pages = board.pagesOnSite === null ? 'excluded' : `${board.pagesCovered}/${board.pagesOnSite} pages`;
    const statuses = Object.entries(board.byStatus)
      .map(([status, n]) => `${status} ${n}`)
      .join(' · ');
    return `${String(board.id).padEnd(4)} ${(board.title ?? board.name).slice(0, 34).padEnd(34)} ${pages.padEnd(16)} ${String(board.fetched).padStart(5)} fetched ${String(board.stored).padStart(5)} stored  ${statuses}`;
  });
  const problems = report.problems.length === 0 ? 'coverage OK' : report.problems.map((p) => `  ! ${p}`).join('\n');
  return [...lines, '', problems].join('\n');
}

// `node dist/coverage-audit.js` — read-only against the site and the database.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(process.env['DB_PATH'] ?? './data/tamilcache.db');
  void run(db);

  async function run(database: Db): Promise<void> {
    const { PoliteHttpClient } = await import('./http-client.js');
    // No circuit breaker and a slower pace than the crawler: the audit runs *beside* a worker that
    // is already spending the site's tolerance, and a burst of 403s must be reported per board
    // ("page 1 could not be read"), not abort the other 45 with a global "circuit open".
    const http = new PoliteHttpClient({
      mirrors: mirrorList(),
      delayMs: Math.max(Number(process.env['CRAWL_DELAY_MS'] ?? 2000), 3000),
      breakerThreshold: Number.POSITIVE_INFINITY,
    });
    const report = await auditCoverage(database, loadScope(), http, {
      baseUrl: mirrorList()[0] as string,
      config: loadForumConfig(),
    });
    // The API serves this instead of running the audit per request: 50+ site fetches per call.
    setState(database, 'coverage_report', JSON.stringify(report), 'worker');
    setState(database, 'coverage_generated_at', new Date().toISOString(), 'worker');
    console.log(formatReport(report));
    process.exit(report.exitCode);
  }
}
