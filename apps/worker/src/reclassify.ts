import { pathToFileURL } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { openDb, type Db } from '@tamilcache/db';
import { crawlTasks, forums, links, topics } from '@tamilcache/db/schema';
import { classifyLink, isExternalLink, topicRefFromUrl } from '@tamilcache/shared';
import { markGone, postLinkExists, type CrawlHttp } from './crawl.js';
import { mirrorList } from './config.js';
import { PoliteHttpClient } from './http-client.js';

export interface ReclassifySummary {
  external: number;
  no_link: number;
  /** Parsed rows with nothing stored: every release was under the 1080p floor. */
  below_floor: number;
}

/**
 * Re-derive every stored link's kind from its URL.
 *
 * `links.kind` is a snapshot of the classifier at write time, and the classifier changes: after
 * `streamdady` became site chrome, 8,682 stored rows still said `stream`, which made every topic
 * look like an external download. Re-classifying is cheap (pure function, no network) and it is
 * the only way the status derivation can be trusted on historical rows.
 */
export function reclassifyLinks(db: Db): number {
  const rows = db.select({ id: links.id, url: links.url, kind: links.kind }).from(links).all();
  let changed = 0;
  db.transaction(
    () => {
      for (const row of rows) {
        const classified = classifyLink(row.url).kind;
        // `classifyLink` is host-only and cannot tell a download from a screenshot, so the parser
        // makes that call with the anchor in hand. Re-deriving here without the anchor must use the
        // same rule, or this pass would quietly undo every `download` back to `other`.
        const kind = classified === 'other' && isExternalLink(row.url) ? 'download' : classified;
        if (kind === row.kind) continue;
        db.update(links).set({ kind }).where(eq(links.id, row.id)).run();
        changed++;
      }
    },
    { behavior: 'immediate' },
  );
  return changed;
}

/**
 * Rows written before the status split keep the old `no_magnet` label. This pass rewrites them
 * from what is already stored — the `links` table — so the unresolved queue has no dead weight
 * and no re-crawl is needed to find the 2,231 gated posts.
 */
export function reclassifyStatuses(db: Db): ReclassifySummary {
  // Every status derived from links, not only the legacy label: a pass that ran with a buggy
  // derivation leaves `external` rows that should be `no_link`, and "no_magnet" alone would skip
  // them forever. `parsed` (has variants) and `gone` (HTTP-derived) are never touched here.
  const rows = db
    .select({ id: topics.id })
    .from(topics)
    .where(inArray(topics.status, ['no_magnet', 'external', 'no_link']))
    .all();
  let external = 0;
  let noLink = 0;
  db.transaction(
    () => {
      for (const row of rows) {
        const hasLink = postLinkExists(db, row.id);
        db.update(topics)
          .set({ status: hasLink ? 'external' : 'no_link' })
          .where(eq(topics.id, row.id))
          .run();
        if (hasLink) external++;
        else noLink++;
      }
    },
    { behavior: 'immediate' },
  );
  // The old crawl inserted every topic as `parsed` and only relabelled it when nothing at all was
  // dropped, so a post whose releases were all sub-1080p kept the `parsed` label with zero rows.
  // A parsed topic that kept even one variant always has one, so "parsed with none" is exactly
  // "everything was under the floor" — no page fetch needed to tell.
  const emptyParsed = db
    .select({ id: topics.id })
    .from(topics)
    .where(
      and(
        eq(topics.status, 'parsed'),
        sql`NOT EXISTS (SELECT 1 FROM variants v WHERE v.topic_id = ${topics.id})`,
      ),
    )
    .all();
  db.transaction(
    () => {
      for (const row of emptyParsed) {
        db.update(topics).set({ status: 'below_floor' }).where(eq(topics.id, row.id)).run();
      }
    },
    { behavior: 'immediate' },
  );

  return { external, no_link: noLink, below_floor: emptyParsed.length };
}

export interface RecheckSummary {
  checked: number;
  gone: number;
  revived: number;
  stillFailing: number;
}

/**
 * One fetch per dead task. A page that is still 404 is recorded as `gone` and the task closed; a
 * page that answers 200 is re-queued so the crawler derives its status properly (it may now be
 * `external`, `parsed` or `parse_failed`) — this code must not guess which.
 */
export async function recheckDead(db: Db, http: CrawlHttp, options: { limit?: number } = {}): Promise<RecheckSummary> {
  const dead = db
    .select({ id: crawlTasks.id, url: crawlTasks.url, payload: crawlTasks.payload })
    .from(crawlTasks)
    .where(eq(crawlTasks.state, 'error'))
    .limit(options.limit ?? 500)
    .all();

  const summary: RecheckSummary = { checked: dead.length, gone: 0, revived: 0, stillFailing: 0 };
  for (const task of dead) {
    const ref = topicRefFromUrl(task.url);
    try {
      const response = await http.get(task.url);
      if (response.status === 404 || response.status === 410) {
        let forumId: number | null = null;
        try {
          const payload = JSON.parse(task.payload ?? '{}') as { forumId?: number };
          forumId = payload.forumId ?? null;
        } catch {
          forumId = null;
        }
        const source = db.select({ id: forums.sourceId }).from(forums).where(eq(forums.id, forumId ?? 0)).get();
        if (ref && forumId !== null && source) markGone(db, source.id, forumId, ref.id, ref.slug);
        db.update(crawlTasks).set({ state: 'done' }).where(eq(crawlTasks.id, task.id)).run();
        summary.gone++;
        continue;
      }
      db.update(crawlTasks).set({ state: 'pending', attempts: 0, nextAttemptAt: null }).where(eq(crawlTasks.id, task.id)).run();
      summary.revived++;
    } catch {
      summary.stillFailing++;
    }
  }
  return summary;
}

// `node dist/reclassify.js [--recheck]`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(process.env['DB_PATH'] ?? './data/tamilcache.db');
  run(db).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

  async function run(database: Db): Promise<void> {
    const linksChanged = reclassifyLinks(database);
    const statuses = reclassifyStatuses(database);
    console.log(JSON.stringify({ links: { reclassified: linksChanged }, reclassified: statuses }, null, 2));
    if (process.argv.includes('--recheck')) {
      const http = new PoliteHttpClient({ mirrors: mirrorList(), delayMs: Number(process.env['CRAWL_DELAY_MS'] ?? 2000) });
      const rechecked = await recheckDead(database, http);
      console.log(JSON.stringify({ rechecked }, null, 2));
    }
    process.exit(0);
  }
}
