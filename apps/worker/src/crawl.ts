import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { logEvent, type Db } from '@tamilcache/db';
import { backfillState, crawlRuns, forums, links, topics } from '@tamilcache/db/schema';
import {
  deriveStatus,
  firstPostBody,
  forumRefsFromHtml,
  hasDownload,
  hasTopicList,
  isEmptyForumPage,
  parseHomeSections,
  parseListingPage,
  parseTopicPage,
  topicRefFromUrl,
} from '@tamilcache/shared';
import { resolveTorrentHashes } from './torrent-hash.js';
import { forumUrl, type ForumConfig } from './config.js';
import { describeError } from './errors.js';
import { CircuitOpenError } from './http-client.js';
import { claimNext, complete, enqueue, enqueueOrRearm, fail, release } from './queue.js';
import { persistTopic } from './persist.js';

export interface CrawlHttp {
  get(url: string): Promise<{ status: number; body: string; url: string }>;
  /** Binary fetch for `.torrent` attachments; absent in tests that never touch one. */
  getBuffer?(url: string): Promise<{ status: number; body: Buffer }>;
}

export interface CrawlContext {
  db: Db;
  http: CrawlHttp;
  baseUrl: string;
  sourceId: number;
  config: ForumConfig[];
}

interface TaskPayload {
  forumId?: number;
  page?: number;
  /** View count read from the listing row, carried to the topic page so it can be stored. */
  views?: number | null;
}

export interface DrainStats {
  processed: number;
  failed: number;
  dead: number;
  dropped: number;
}

function parsePayload(raw: string | null): TaskPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TaskPayload;
  } catch {
    return {};
  }
}

/**
 * Delta, pass 1 + 2, all at priority 0.
 *
 * Pass 1 re-arms every topic named on the home page so edits are noticed. Pass 2 sweeps page 1
 * of every in-scope forum, because the home page lists ~84 items and a busy day uploads more.
 */
export async function runDelta(ctx: CrawlContext): Promise<{ runId: number; enqueued: number }> {
  const { db, http, baseUrl } = ctx;
  const run = db.insert(crawlRuns).values({ kind: 'delta' }).returning().get();
  logEvent(db, {
    source: 'worker',
    level: 'info',
    class: 'diag',
    scope: 'crawl',
    event: 'delta.start',
    message: 'delta crawl started',
    runId: run.id,
  });
  let enqueued = 0;

  const home = await http.get(`${baseUrl.replace(/\/$/, '')}/`);
  const { topics: homeTopics } = parseHomeSections(home.body, baseUrl);
  for (const topic of homeTopics) {
    if (enqueueOrRearm(db, { url: topic.url, kind: 'delta_page', priority: 0, runId: run.id })) enqueued++;
  }

  for (const forum of ctx.config) {
    // A language hub has no listing of its own; its subforums carry the topics.
    if (forum.hub) continue;
    const forumRow = db.select().from(forums).where(eq(forums.sourceForumId, forum.id)).get();
    if (!forumRow || !forumRow.inScope) continue;
    const url = forumUrl(baseUrl, forum);
    const payload = { forumId: forumRow.id, page: 1 };
    if (enqueueOrRearm(db, { url, kind: 'listing', priority: 0, payload, runId: run.id })) enqueued++;
  }

  db.update(crawlRuns).set({ tasksTotal: enqueued }).where(eq(crawlRuns.id, run.id)).run();
  logEvent(db, {
    source: 'worker',
    level: 'info',
    class: 'diag',
    scope: 'crawl',
    event: 'delta.finish',
    message: `delta enqueued ${enqueued} tasks`,
    runId: run.id,
    detail: { enqueued },
  });
  return { runId: run.id, enqueued };
}

/** Drains the queue, P0 before P1. Returns counters rather than a bare processed count. */
export async function drainQueue(
  ctx: CrawlContext,
  options: { max?: number; nowMs?: () => number } = {},
): Promise<DrainStats> {
  const { db, http, baseUrl } = ctx;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const nowMs = options.nowMs ?? (() => Date.now());
  const stats: DrainStats = { processed: 0, failed: 0, dead: 0, dropped: 0 };

  while (stats.processed + stats.failed < max) {
    const task = claimNext(db, nowMs());
    if (!task) break;
    try {
      const response = await http.get(task.url);
      const payload = parsePayload(task.payload);

      if (task.kind === 'listing') {
        const { topics } = parseListingPage(response.body, baseUrl);
        // A page that parses to zero topics is a parse miss, not an empty page: advancing the
        // cursor there would silently truncate a forum's entire backfill.
        if (topics.length === 0 && (hasTopicList(response.body) || isEmptyForumPage(response.body))) {
          // The container is there but holds no rows: the forum is empty (or this is a page past
          // its end). That is a fact about the forum, not a parse failure — retrying it five
          // times would dead-letter a perfectly good URL.
          logEvent(db, {
            source: 'worker',
            level: 'info',
            class: 'diag',
            scope: 'crawl',
            event: 'backfill.page',
            message: 'listing page has no topics (empty forum)',
            url: task.url,
            taskId: task.id,
            runId: task.runId,
            forumId: payload.forumId ?? null,
            detail: { page: payload.page ?? null, empty: true },
          });
          const forumRow = payload.forumId
            ? db.select().from(forums).where(eq(forums.id, payload.forumId)).get()
            : undefined;
          if (forumRow) advanceBackfillCursor(db, forumRow.id, payload.page ?? 1, 1);
          complete(db, task.id);
          stats.processed++;
          continue;
        }
        if (topics.length === 0) {
          logEvent(db, {
            source: 'worker',
            level: 'warn',
            class: 'diag',
            scope: 'parse',
            event: 'miss',
            message: 'listing page yielded no topics',
            url: task.url,
            taskId: task.id,
            runId: task.runId,
            detail: { status: response.status, parser: 'parseListingPage' },
          });
          throw new Error(`listing page yielded no topics: ${task.url}`);
        }
        for (const topic of topics) {
          enqueue(db, {
            url: topic.url,
            kind: 'topic',
            priority: task.priority as 0 | 1,
            payload: { forumId: payload.forumId, views: topic.views },
          });
        }
        const forumRow = payload.forumId ? db.select().from(forums).where(eq(forums.id, payload.forumId)).get() : undefined;
        if (forumRow) advanceBackfillCursor(db, forumRow.id, payload.page ?? 1, pageCountOf(response.body));
      } else {
        // A deleted topic is a fact about the site, not a parse failure: record it against its id
        // and never retry it. Retrying a 404 five times is what filled the dead-letter list with
        // pages that were simply gone.
        if (response.status === 404 || response.status === 410) {
          const ref = topicRefFromUrl(task.url);
          const forumRow = payload.forumId
            ? db.select().from(forums).where(eq(forums.id, payload.forumId)).get()
            : deriveForum(db, response.body);
          if (ref) markGone(db, ctx.sourceId, forumRow?.id ?? null, ref.id, ref.slug);
          logEvent(db, {
            source: 'worker',
            level: 'warn',
            class: 'diag',
            scope: 'crawl',
            event: 'topic.gone',
            message: `topic ${ref?.id ?? '?'} is gone (${response.status})`,
            url: task.url,
            taskId: task.id,
            runId: task.runId,
            forumId: forumRow?.id ?? null,
            detail: { status: response.status },
          });
          complete(db, task.id);
          stats.processed++;
          continue;
        }
        // Home-page topics arrive without a forum; take it from the topic's own breadcrumb
        // rather than guessing, so a release is never filed under the wrong language section.
        const explicit = payload.forumId
          ? db.select().from(forums).where(eq(forums.id, payload.forumId)).get()
          : undefined;
        const derived = explicit ?? deriveForum(db, response.body);
        if (!derived) throw new Error(`no forum for ${task.url}`);
        const forumRow = derived;
        // A block whose only download is a `.torrent` needs its hash before it can be stored,
        // because `variants.infohash` is NOT NULL and the feed keys on it.
        const parsedTopic = parseTopicPage(response.body, baseUrl);
        const torrentHashes = ctx.http.getBuffer
          ? await resolveTorrentHashes({ getBuffer: ctx.http.getBuffer.bind(ctx.http) }, parsedTopic.variants)
          : new Map<string, string>();
        const result = persistTopic(
          db,
          response.body,
          task.url,
          baseUrl,
          { sourceId: ctx.sourceId, forumId: forumRow.id },
          { torrentHashes, views: payload.views ?? null },
        );
        if (payload.views !== undefined && payload.views !== null) {
          db.update(topics).set({ views: payload.views }).where(eq(topics.id, result.topicId)).run();
        }
        stats.dropped += result.variantsDropped;
        const status = deriveStatus({
          httpStatus: response.status,
          variants: result.variantsInserted,
          hasDownload: hasDownload(firstPostBody(response.body)),
          hasPostLink: postLinkExists(db, result.topicId),
          variantsDropped: result.variantsDropped,
        });
        if (status !== 'parsed') {
          db.update(topics).set({ status }).where(eq(topics.id, result.topicId)).run();
          logEvent(db, {
            source: 'worker',
            level: status === 'parse_failed' ? 'warn' : 'info',
            class: 'diag',
            scope: 'parse',
            event: `topic.${status}`,
            message: `topic recorded as ${status}`,
            url: task.url,
            taskId: task.id,
            runId: task.runId,
            forumId: forumRow.id,
            detail: {
              status,
              variantsInserted: result.variantsInserted,
              variantsUnresolved: result.variantsUnresolved,
              variantsDropped: result.variantsDropped,
            },
          });
          complete(db, task.id);
          stats.processed++;
          continue;
        }
      }

      complete(db, task.id);
      stats.processed++;
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        // The breaker tripping is infrastructure, not this task's fault. Without this the
        // drain loop would swallow the throw, keep claiming tasks, and burn one attempt per
        // second until the whole queue is dead-lettered — while `circuit_open_until` was
        // never persisted, because `main.ts` only sets it for an error that escapes.
        release(db, task.id);
        throw error;
      }
      const outcome = fail(db, task.id, nowMs(), describeError(error));
      stats.failed++;
      if (outcome.dead) stats.dead++;
    }
  }

  return stats;
}

/** The link kinds that make a magnet-less post worth a human's attention. Chrome is `spam`. */
const POST_LINK_KINDS = ['shortener', 'stream', 'gdrive', 'download'] as const;

export function postLinkExists(db: Db, topicId: number): boolean {
  return (
    db
      .select({ id: links.id })
      .from(links)
      .where(and(eq(links.topicId, topicId), inArray(links.kind, [...POST_LINK_KINDS])))
      .get() !== undefined
  );
}

/**
 * Record a deleted topic so it can be listed as a dead link instead of vanishing. A 404 carries no
 * canonical link, so the id and slug come from the URL we requested.
 */
export function markGone(db: Db, sourceId: number, forumId: number | null, sourceTopicId: number, slug: string): void {
  const now = new Date().toISOString();
  const existing = db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.sourceId, sourceId), eq(topics.sourceTopicId, sourceTopicId)))
    .get();
  if (existing) {
    db.update(topics).set({ status: 'gone', lastSeenAt: now }).where(eq(topics.id, existing.id)).run();
    return;
  }
  // A delta/home-page task carries no forum id and a 404 body carries no breadcrumb, so an
  // unseen topic cannot be filed — but a topic we already know can always be marked gone, which
  // is exactly the case that used to vanish silently from the dead-link list.
  if (forumId === null) return;
  db.insert(topics)
    .values({
      sourceId,
      forumId,
      sourceTopicId,
      slug,
      rawTitle: slug,
      kind: 'movie',
      status: 'gone',
      lastSeenAt: now,
    })
    .run();
}

function deriveForum(db: Db, html: string) {
  for (const ref of forumRefsFromHtml(html)) {
    const forum = db.select().from(forums).where(eq(forums.sourceForumId, ref.sourceForumId)).get();
    if (forum && forum.inScope) return forum;
  }
  return undefined;
}

/**
 * `Page N of M`, or null when the page does not state a count. The current page matters: on the
 * last page the text is `Page 46 of 46`, and matching only `Page 1 of …` left `done` unreachable
 * for every forum whose final page was fetched.
 */
function pageCountOf(html: string): number | null {
  const match = /Page (\d+) of ([0-9,]+)/i.exec(html);
  if (!match?.[2]) return null;
  const parsed = Number(match[2].replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** A broken forum costs one request per window instead of one per tick — 1 m doubling to 1 h. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export function backoffMsFor(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/**
 * Persist the failure on the forum's cursor row. That row is the only thing that survives a
 * restart, and creating it here is what stops a forum that never parsed a page from being
 * invisible to `nextBackfillForums` — forums 26 and 71 had no row, read back as page 1, and took
 * both slots of every tick forever.
 */
function noteBackfillFailure(db: Db, forumId: number, error: unknown, now: number): void {
  const existing = db.select().from(backfillState).where(eq(backfillState.forumId, forumId)).get();
  const failures = (existing?.failures ?? 0) + 1;
  const retryAfter = new Date(now + backoffMsFor(failures)).toISOString();
  const lastError = describeError(error);

  if (!existing) {
    db.insert(backfillState).values({ forumId, nextPage: 1, failures, lastError, retryAfter }).run();
    return;
  }
  db.update(backfillState)
    .set({ failures, lastError, retryAfter })
    .where(eq(backfillState.id, existing.id))
    .run();
}

/**
 * Backfill for one forum: fetch its next page, enqueue the topics at priority 1, then advance
 * the persisted cursor. The cursor commits in the same transaction as the topics, so a restart
 * can neither skip a page nor repeat one.
 */
export async function runBackfillPage(
  ctx: CrawlContext,
  sourceForumId: number,
  now = Date.now(),
): Promise<{ page: number; done: boolean }> {
  const { db, http, baseUrl } = ctx;
  const forum = db.select().from(forums).where(eq(forums.sourceForumId, sourceForumId)).get();
  if (!forum) throw new Error(`forum ${sourceForumId} is not seeded; is it in config/forums.json?`);
  if (!forum.inScope) throw new Error(`forum ${sourceForumId} is out of scope`);
  const slug = forum.slug;
  if (!slug) throw new Error(`forum ${sourceForumId} has no slug; cannot build a listing URL`);

  try {
    return await attemptBackfillPage(ctx, { id: forum.id, slug }, sourceForumId);
  } catch (error) {
    noteBackfillFailure(db, forum.id, error, now);
    throw error;
  }
}

async function attemptBackfillPage(
  ctx: CrawlContext,
  forum: { id: number; slug: string },
  sourceForumId: number,
): Promise<{ page: number; done: boolean }> {
  const { db, http, baseUrl } = ctx;
  const state = db.select().from(backfillState).where(eq(backfillState.forumId, forum.id)).get();
  if (state?.done) return { page: state.nextPage, done: true };
  const page = state?.nextPage ?? 1;

  const requested = forumUrl(baseUrl, { id: sourceForumId, slug: forum.slug }, page);
  const response = await http.get(requested);
  const { topics } = parseListingPage(response.body, baseUrl);
  if (topics.length === 0) {
    if (hasTopicList(response.body) || isEmptyForumPage(response.body)) {
      // An empty forum has nothing to page into and nothing to enqueue, so completing it is the
      // only sane outcome. The container alone is not the test: IPS omits `cTopicList` for a board
      // with no topics and renders an empty-state block instead (forums 26 and 71).
      advanceBackfillCursor(db, forum.id, page, 1);
      logEvent(ctx.db, {
        source: 'worker',
        level: 'info',
        class: 'diag',
        scope: 'crawl',
        event: 'backfill.complete',
        message: `forum ${sourceForumId} page ${page}: empty forum`,
        forumId: forum.id,
        detail: { page, reason: 'empty' },
      });
      return { page, done: true };
    }
    throw new Error(`backfill page ${page} of forum ${sourceForumId} yielded no topics`);
  }
  const totalPages = pageCountOf(response.body);

  // The site 303-redirects a page past a board's end back to the board root. Following the
  // redirect is right (the body is a valid listing), but advancing the cursor is not: this is how
  // 14 single-page boards reached page 2131 and re-fetched their own page 1 forever (30,443
  // `backfill.page` events). A board with no pagination and a short page is at its end too.
  const redirected = response.url !== requested;
  if (page > 1 && (redirected || (totalPages === null && topics.length < 25))) {
    advanceBackfillCursor(db, forum.id, page, page);
    logEvent(ctx.db, {
      source: 'worker',
      level: 'info',
      class: 'diag',
      scope: 'crawl',
      event: 'backfill.complete',
      message: `forum ${sourceForumId} page ${page}: past the last page`,
      forumId: forum.id,
      detail: { page, reason: redirected ? 'redirected' : 'short-page' },
    });
    return { page, done: true };
  }

  db.transaction(
    () => {
      for (const topic of topics) {
        enqueue(db, { url: topic.url, kind: 'topic', priority: 1, payload: { forumId: forum.id, views: topic.views } });
      }
      advanceBackfillCursor(db, forum.id, page, totalPages);
    },
    { behavior: 'immediate' },
  );

  const after = db.select().from(backfillState).where(eq(backfillState.forumId, forum.id)).get();
  logEvent(ctx.db, {
    source: 'worker',
    level: 'info',
    class: 'diag',
    scope: 'crawl',
    event: 'backfill.page',
    message: `forum ${sourceForumId} page ${page}: ${topics.length} topics`,
    forumId: forum.id,
    detail: { page, topics: topics.length, totalPages },
  });
  return { page, done: after?.done ?? false };
}

/**
 * The cursor only moves forward, and only ever to `page + 1`. With no parsed page count the
 * forum stays "in progress" (done = false) instead of being marked complete forever.
 */
function advanceBackfillCursor(db: Db, forumId: number, page: number, totalPages: number | null): void {
  const existing = db.select().from(backfillState).where(eq(backfillState.forumId, forumId)).get();
  const nextPage = page + 1;
  const done = totalPages !== null && page >= totalPages;

  if (!existing) {
    db.insert(backfillState).values({ forumId, nextPage, totalPages, done }).run();
    return;
  }
  if (existing.done) return;
  if (nextPage < existing.nextPage) return;

  db.update(backfillState)
    .set({
      nextPage: Math.max(existing.nextPage, nextPage),
      totalPages: totalPages ?? existing.totalPages,
      done,
      // Reaching a page that parses is the only evidence the forum is healthy again.
      failures: 0,
      lastError: null,
      retryAfter: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(backfillState.id, existing.id)))
    .run();
}

/**
 * Which forums deserve the next backfill page.
 *
 * Ordered by page level first — "page 1 of every forum before page 2 of any"
 * (`2026-11-09-tamil-hindi-cache-design.md:241`) — then by least-recently-touched, so a forum that
 * sorts last in the allowlist still advances. The old lowest-id-first order starved 39 of 41
 * forums forever: the first two never became `done`, so nothing else was ever picked.
 *
 * A forum inside its failure backoff is dropped before the sort. It sorts as page 1 with no
 * timestamp, so leaving it in would hand it every tick's slots — exactly how forums 26 and 71 froze
 * the other 36 at page 2.
 */
export function nextBackfillForums(ctx: CrawlContext, limit: number, now = Date.now()): number[] {
  const hubs = new Set(ctx.config.filter((forum) => forum.hub).map((forum) => forum.id));
  const inScope = ctx.config.filter((forum) => !forum.hub).map((forum) => forum.id);
  return ctx.db
    .select()
    .from(forums)
    .where(and(eq(forums.inScope, true), sql`${forums.sourceForumId} IN ${inScope}`))
    .all()
    .filter((forum) => !hubs.has(forum.sourceForumId))
    .map((forum) => ({
      forum,
      state: ctx.db.select().from(backfillState).where(eq(backfillState.forumId, forum.id)).get(),
    }))
    .filter((entry) => !entry.state?.done)
    .filter((entry) => !isBackingOff(entry.state, now))
    .sort((a, b) => {
      const pageA = a.state?.nextPage ?? 1;
      const pageB = b.state?.nextPage ?? 1;
      if (pageA !== pageB) return pageA - pageB;
      const touchedA = a.state?.updatedAt ?? '';
      const touchedB = b.state?.updatedAt ?? '';
      if (touchedA !== touchedB) return touchedA < touchedB ? -1 : 1;
      return a.forum.sourceForumId - b.forum.sourceForumId;
    })
    .slice(0, limit)
    .map((entry) => entry.forum.sourceForumId);
}

function isBackingOff(state: { retryAfter: string | null } | undefined, now: number): boolean {
  if (!state?.retryAfter) return false;
  const at = Date.parse(state.retryAfter);
  return Number.isFinite(at) && at > now;
}

/** Every non-hub in-scope forum has reached its last page. */
export function backfillComplete(ctx: CrawlContext): boolean {
  const hubs = new Set(ctx.config.filter((forum) => forum.hub).map((forum) => forum.id));
  const targets = ctx.db
    .select()
    .from(forums)
    .where(eq(forums.inScope, true))
    .all()
    .filter((forum) => !hubs.has(forum.sourceForumId));
  if (targets.length === 0) return false;
  return targets.every((forum) => {
    const state = ctx.db.select().from(backfillState).where(eq(backfillState.forumId, forum.id)).get();
    return state?.done === true;
  });
}

void isNull;
