import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { logEvent, type Db } from '@tamilcache/db';
import { appState, crawlTasks, forums, links, logEvents, media, overrides, rules, sources, topics, variants } from '@tamilcache/db/schema';
import { evidenceHash, magnetInfohash, normaliseTitle, qualityRank, rankCandidates, ruleSchema, searchHint, type MediaKind } from '@tamilcache/shared';
import { z } from 'zod';
import {
  bindManual,
  bindTopicToTmdb,
  mediaKindOf,
  OmdbClient,
  OmdbQuotaExceededError,
  previewRule,
  replayAll,
  resetProviderCheck,
  selectPreferredAcrossTitles,
  TmdbAmbiguousImdbError,
  TmdbClient,
  TvdbClient,
  type OmdbQuota,
  type TvdbTokenStore,
} from '@tamilcache/worker';
import { libraryPage, suggestTitles, titleByMediaId } from '../library.js';
import { browse, crawlHealth, escapeLike, stats, titleDetail } from '../queries.js';
import { runChecks } from '../verify.js';
import { clearState, getState, setState } from '@tamilcache/worker';

const DECISION_ACTIONS = ['hindi_dubbed', 'hindi_original', 'not_hindi', 'ignore'] as const;

/** A topic's links decide which queue it belongs to; these are the four a human can act on. */
const magnetBodySchema = z.object({
  magnet: z.string().regex(/^magnet:\?xt=urn:btih:[a-z0-9]{32,40}/i),
  resolution: z.enum(['1080p', '1440p', '2160p']),
  sizeBytes: z.number().int().positive(),
  sourceTag: z.string().min(1),
  audioLangs: z.array(z.string()).default([]),
  codec: z.string().nullish(),
  season: z.number().int().nullish(),
  epFrom: z.number().int().nullish(),
  epTo: z.number().int().nullish(),
});

const UNRESOLVED_STATUSES = ['external', 'no_link', 'gone', 'parse_failed', 'below_floor'] as const;
/** Chrome never becomes a user-facing link, and neither does an attachment (already indexed). */
const ACTIONABLE_LINK_KINDS = ['shortener', 'stream', 'gdrive', 'download'] as const;

/**
 * The unresolved queue. Every other UI surface starts `FROM variants`, so a topic whose page had
 * no magnet — 4,111 of 8,682 rows — could not appear anywhere, no matter what the screen offered.
 * This starts `FROM topics` for exactly that reason.
 *
 * Paged and searchable because the set is ~4,400 rows: the old shape returned a bare array capped
 * at 200, so 92% of the backlog was unreachable and there was no way to work one board.
 */
interface UnresolvedPage {
  rows: Array<{
    id: number;
    sourceTopicId: number;
    slug: string;
    rawTitle: string;
    status: string;
    views: number | null;
    kind: string;
    firstSeenAt: string;
    lastSeenAt: string;
    forumId: number;
    forumName: string;
    baseUrl: string;
    links: Array<{ url: string; kind: string; label: string }>;
  }>;
  total: number;
  page: number;
  pages: number;
  counts: Record<string, number>;
}

function unresolvedPage(
  db: Db,
  params: { statuses: readonly string[]; q?: string | undefined; forumId?: number | undefined; page: number; limit: number },
): UnresolvedPage {
  const conditions: SQL[] = [inArray(topics.status, params.statuses as never)];
  if (params.q) {
    conditions.push(sql`lower(${topics.rawTitle}) LIKE ${`%${escapeLike(params.q.toLowerCase())}%`} ESCAPE '\\'`);
  }
  if (params.forumId !== undefined) conditions.push(eq(topics.forumId, params.forumId));

  const total =
    db.select({ n: sql<number>`count(*)` }).from(topics).where(and(...conditions)).get()?.n ?? 0;

  const rows = db
    .select({
      id: topics.id,
      sourceTopicId: topics.sourceTopicId,
      slug: topics.slug,
      rawTitle: topics.rawTitle,
      status: topics.status,
      views: topics.views,
      kind: topics.kind,
      firstSeenAt: topics.firstSeenAt,
      lastSeenAt: topics.lastSeenAt,
      forumId: topics.forumId,
      forumName: forums.name,
      baseUrl: sources.baseUrl,
    })
    .from(topics)
    .innerJoin(forums, eq(topics.forumId, forums.id))
    .innerJoin(sources, eq(forums.sourceId, sources.id))
    .where(and(...conditions))
    // View counts are still NULL for most rows, so the useful order is "never looked at first":
    // a queue sorted by recency silently buries the posts nobody has opened.
    .orderBy(sql`${topics.views} IS NULL DESC`, desc(topics.views), asc(topics.lastSeenAt), asc(topics.id))
    .limit(params.limit)
    .offset((params.page - 1) * params.limit)
    .all();

  // One statement for the whole page: the previous shape ran a query per row (up to 201).
  const ids = rows.map((row) => row.id);
  const linksByTopic = new Map<number, Array<{ url: string; kind: string; label: string }>>();
  if (ids.length > 0) {
    for (const link of db
      .select({ topicId: links.topicId, url: links.url, kind: links.kind, label: links.label })
      .from(links)
      .where(and(inArray(links.topicId, ids), inArray(links.kind, [...ACTIONABLE_LINK_KINDS])))
      .all()) {
      if (link.topicId === null || link.url === null) continue;
      const list = linksByTopic.get(link.topicId) ?? [];
      list.push({ url: link.url, kind: link.kind ?? 'other', label: link.label ?? '' });
      linksByTopic.set(link.topicId, list);
    }
  }

  const counts: Record<string, number> = Object.fromEntries(UNRESOLVED_STATUSES.map((status) => [status, 0]));
  for (const row of db
    .select({ status: topics.status, n: sql<number>`count(*)` })
    .from(topics)
    .where(inArray(topics.status, [...UNRESOLVED_STATUSES]))
    .groupBy(topics.status)
    .all()) {
    counts[row.status] = row.n;
  }

  return {
    rows: rows.map((row) => ({ ...row, links: linksByTopic.get(row.id) ?? [] })),
    total,
    page: params.page,
    pages: Math.max(1, Math.ceil(total / params.limit)),
    counts,
  };
}

const LEVEL_ORDER = ['debug', 'info', 'warn', 'error'] as const;

/** `level=warn` means "warn and above", which is how the question is actually asked. */
function levelsAtOrAbove(level: string): string[] {
  const index = LEVEL_ORDER.indexOf(level as (typeof LEVEL_ORDER)[number]);
  return index < 0 ? [...LEVEL_ORDER] : LEVEL_ORDER.slice(index);
}

/** Accepts `1h`, `24h`, `7d`, `all`, or an ISO timestamp. */
function sinceIso(since: string): string | null {
  if (since === 'all') return null;
  const relative = /^(\d+)([hd])$/.exec(since);
  if (!relative) return since;
  const hours = relative[2] === 'd' ? Number(relative[1]) * 24 : Number(relative[1]);
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}
const manualBindSchema = z.object({
  imdbId: z.string().min(3),
  mediaType: z.enum(['movie', 'tv']),
  title: z.string().min(1),
  year: z.number().int().nullable().optional(),
  originalLanguage: z.string().min(2).max(3),
  seasons: z.number().int().positive().nullable().optional(),
  poster: z.string().url().nullable().optional(),
});

const actionSchema = z.enum(DECISION_ACTIONS);

/** An empty predicate matches every row: never accept it for a corpus-wide rule. */
const nonEmptyRuleSchema = ruleSchema.refine((value) => Object.keys(value).length > 0, {
  message: 'predicate must have at least one condition',
});

/** `kind` query param → the scorer's MediaKind. Anything else means "do not score". */
function mediaKindParam(value: string | undefined): MediaKind | null {
  return value === 'tv' || value === 'movie' ? value : null;
}

function integerParam(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${name} must be a positive integer`);
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return parsed;
}

interface DecideBody {
  variantIds?: number[];
  action?: 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | 'ignore';
  applyToSimilar?: boolean;
  predicate?: unknown;
  dryRun?: boolean;
}

/**
 * The OMDb free tier is 1,000 requests per key per day, counted by the provider — not per process.
 * Writing `app_state` directly (rather than `setState`) keeps the per-request increment out of the
 * audit log; the route logs one `omdb_search` event per manual search, which is the useful record.
 */
function appStateQuota(db: Db): OmdbQuota {
  const day = () => new Date().toISOString().slice(0, 10);
  const read = (key: 'omdb_used_date' | 'omdb_used_today'): string | null =>
    db.select().from(appState).where(eq(appState.key, key)).get()?.value ?? null;
  const write = (key: string, value: string): void => {
    db.insert(appState)
      .values({ key, value })
      .onConflictDoUpdate({ target: appState.key, set: { value } })
      .run();
  };
  return {
    used: async () => (read('omdb_used_date') === day() ? Number(read('omdb_used_today') ?? '0') : 0),
    increment: async () => {
      const today = day();
      const next = read('omdb_used_date') === today ? (Number(read('omdb_used_today') ?? '0') || 0) + 1 : 1;
      write('omdb_used_date', today);
      write('omdb_used_today', String(next));
      return next;
    },
  };
}

/** TVDB v4 JWTs are short-lived; persisting one avoids a login per API restart. */
function appStateTokenStore(db: Db): TvdbTokenStore {
  return {
    get: () => db.select().from(appState).where(eq(appState.key, 'tvdb_token')).get()?.value ?? null,
    set: (value: string | null) => {
      if (value === null) {
        db.delete(appState).where(eq(appState.key, 'tvdb_token')).run();
      } else {
        db.insert(appState)
          .values({ key: 'tvdb_token', value })
          .onConflictDoUpdate({ target: appState.key, set: { value } })
          .run();
      }
    },
  };
}

export function registerRestRoutes(
  app: FastifyInstance,
  db: Db,
  originFor: (request: { headers: Record<string, unknown>; protocol?: string }) => string,
  dataDir = process.env['DATA_DIR'] ?? './data',
  /** Test seam: a caller-supplied client replaces the env-configured one. */
  tmdbOverride?: TmdbClient | null,
  omdbOverride?: OmdbClient | null,
  tvdbOverride?: TvdbClient | null,
): void {
  const tmdbKey = process.env['TMDB_API_KEY']?.trim() ?? '';
  const tmdb = tmdbOverride !== undefined ? tmdbOverride : tmdbKey ? new TmdbClient({ apiKey: tmdbKey }) : null;
  const omdbKey = process.env['OMDB_API_KEY']?.trim() ?? '';
  const omdb =
    omdbOverride !== undefined
      ? omdbOverride
      : omdbKey
        ? new OmdbClient({ apiKey: omdbKey, quota: appStateQuota(db) })
        : null;
  const tvdbKey = process.env['TVDB_API_KEY']?.trim() ?? '';
  const tvdb =
    tvdbOverride !== undefined
      ? tvdbOverride
      : tvdbKey
        ? new TvdbClient({
            apiKey: tvdbKey,
            pin: process.env['TVDB_PIN']?.trim() ?? null,
            tokenStore: appStateTokenStore(db),
          })
        : null;

  /** Bind a topic to a human-chosen TMDB id (review queue: "this is the right film"). */
  app.post('/api/v1/titles/:topicId/bind', async (request, reply) => {
    if (!tmdb) return reply.code(503).send({ error: 'TMDB_API_KEY is not configured' });
    const { topicId } = request.params as { topicId: string };
    const parsedTopicId = integerParam(topicId, 'topicId');
    const body = request.body as { tmdbId?: number; mediaType?: 'movie' | 'tv' };
    if (typeof body.tmdbId !== 'number') return reply.code(400).send({ error: 'tmdbId is required' });

    const topic = db.select().from(topics).where(eq(topics.id, parsedTopicId)).get();
    if (!topic) return reply.code(404).send({ error: 'topic not found' });

    const bound = await bindTopicToTmdb(db, tmdb, topic.id, body.tmdbId, body.mediaType ?? (topic.kind === 'show' ? 'tv' : 'movie'));
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'review',
      event: 'bind',
      message: `bound topic ${topic.id} to TMDB ${body.tmdbId}`,
      detail: { actor: 'web', topicId: topic.id, tmdbId: body.tmdbId },
    });
    return { ...bound, replay: replayAll(db) };
  });

  /**
   * Attach a title TMDB does not have. A reviewer supplies the identity (IMDb), the original
   * language and, for shows, the season count; the row is filed under `imdb_id`.
   */
  app.post('/api/v1/titles/:topicId/bind-manual', async (request, reply) => {
    const { topicId } = request.params as { topicId: string };
    const parsedTopicId = integerParam(topicId, 'topicId');
    const parsed = manualBindSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const topic = db.select().from(topics).where(eq(topics.id, parsedTopicId)).get();
    if (!topic) return reply.code(404).send({ error: 'topic not found' });

    try {
      const bound = await bindManual(db, tmdb, topic.id, {
        imdbId: parsed.data.imdbId,
        mediaType: parsed.data.mediaType,
        title: parsed.data.title,
        year: parsed.data.year ?? null,
        originalLanguage: parsed.data.originalLanguage,
        seasons: parsed.data.seasons ?? null,
        ...(parsed.data.poster === undefined ? {} : { poster: parsed.data.poster }),
      });
      logEvent(db, {
        source: 'api',
        level: 'info',
        class: 'audit',
        scope: 'review',
        event: 'bind_manual',
        message: `manually bound topic ${topic.id} to imdb ${parsed.data.imdbId}`,
        detail: { actor: 'web', topicId: topic.id, imdbId: parsed.data.imdbId, viaTmdb: bound.viaTmdb },
      });
      return { ...bound, replay: replayAll(db) };
    } catch (error) {
      if (error instanceof TmdbAmbiguousImdbError) {
        return reply.code(409).send({ error: error.message, candidates: error.candidates });
      }
      throw error;
    }
  });

  /** Forget a provider attempt so the next worker tick searches again. */
  app.post('/api/v1/titles/:topicId/recheck', async (request) => {
    const { topicId } = request.params as { topicId: string };
    const parsedTopicId = integerParam(topicId, 'topicId');
    resetProviderCheck(db, parsedTopicId);
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'review',
      event: 'recheck',
      message: `provider check reset for topic ${parsedTopicId}`,
      detail: { actor: 'web', topicId: parsedTopicId, queued: true },
    });
    return { ok: true, queued: true };
  });

  /**
   * Manual TMDB search from the UI, for when the proposal is wrong or absent.
   *
   * `kind` opts into scoring. The picker always passes it: without a score the list is TMDB's own
   * popularity order, which is exactly what `scoreCandidate` exists to correct.
   */
  app.get('/api/v1/tmdb/search', async (request, reply) => {
    if (!tmdb) return reply.code(503).send({ error: 'TMDB_API_KEY is not configured' });
    const query = request.query as Record<string, string | undefined>;
    const term = query['q']?.trim();
    if (!term) return reply.code(400).send({ error: 'q is required' });
    const year = query['year'] ? Number(query['year']) : null;
    const candidates = await tmdb.search(term, { year });
    const kind = mediaKindParam(query['kind']);
    return { results: kind ? rankCandidates(candidates, { query: term, kind, year }) : candidates };
  });

  /** Manual OMDb search. The worker never calls this: every call spends 1 of 1,000 daily requests. */
  app.get('/api/v1/omdb/search', async (request, reply) => {
    if (!omdb) return reply.code(503).send({ error: 'OMDB_API_KEY is not configured' });
    const query = request.query as Record<string, string | undefined>;
    const term = query['q']?.trim();
    if (!term) return reply.code(400).send({ error: 'q is required' });
    const yearRaw = query['year'];
    const year = yearRaw ? Number(yearRaw) : null;

    try {
      const hits = await omdb.search(term, Number.isFinite(year ?? NaN) ? year : null);
      logEvent(db, {
        source: 'api',
        level: 'info',
        class: 'audit',
        scope: 'review',
        event: 'omdb_search',
        message: `manual omdb search: ${term}`,
        detail: { actor: 'web', term, year, hits: hits.length },
      });
      return { results: hits };
    } catch (error) {
      if (error instanceof OmdbQuotaExceededError) return reply.code(429).send({ error: error.message });
      throw error;
    }
  });

  /** Which optional providers this install can use. One call, no secrets, no side effects. */
  app.get('/api/v1/providers', async () => ({ omdb: omdb !== null, tvdb: tvdb !== null }));

  app.get('/api/v1/tvdb/search', async (request, reply) => {
    if (!tvdb) return reply.code(503).send({ error: 'TVDB_API_KEY is not configured' });
    const term = (request.query as Record<string, string | undefined>)['q']?.trim();
    if (!term) return reply.code(400).send({ error: 'q is required' });
    return { results: await tvdb.search(term) };
  });

  /** Series detail: language, country, seasons, episodes and the IMDb/TMDB remote ids. */
  app.get('/api/v1/tvdb/series/:id', async (request, reply) => {
    if (!tvdb) return reply.code(503).send({ error: 'TVDB_API_KEY is not configured' });
    const { id } = request.params as { id: string };
    const parsed = Number(id);
    if (!Number.isInteger(parsed) || parsed <= 0) return reply.code(400).send({ error: 'id must be a positive integer' });
    try {
      return await tvdb.series(parsed);
    } catch (error) {
      // The client already retried a 5xx once; a failed re-login lands here too. Log the detail and
      // answer generically: the upstream path is not the client's business.
      logEvent(db, {
        source: 'api',
        level: 'warn',
        class: 'diag',
        scope: 'review',
        event: 'tvdb_series',
        message: 'TVDB series lookup failed',
        detail: { id: parsed, error: error instanceof Error ? error.message : String(error) },
      });
      return reply.code(502).send({ error: 'TVDB request failed' });
    }
  });

  app.get('/api/v1/stats', async () => stats(db));

  app.get('/api/v1/browse', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const num = (key: string): number | undefined => {
      const value = Number(query[key]);
      return Number.isFinite(value) && query[key] !== undefined && query[key] !== '' ? value : undefined;
    };
    return browse(db, {
      decision: query['decision'],
      resolution: query['resolution'],
      sourceTag: query['sourceTag'],
      forumId: num('forumId'),
      minSize: num('minSize'),
      maxSize: num('maxSize'),
      hasMagnet: query['hasMagnet'] === undefined ? undefined : query['hasMagnet'] === 'true',
      includeAlternatives: query['alternatives'] === '1',
      q: query['q'],
      sort: (query['sort'] as 'quality' | 'newest' | 'size' | undefined) ?? 'quality',
      limit: Math.min(num('limit') ?? 50, 200),
      offset: num('offset') ?? 0,
    });
  });

  app.get('/api/v1/library', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const num = (key: string): number | undefined => {
      const value = Number(query[key]);
      return Number.isFinite(value) && query[key] !== undefined && query[key] !== '' ? value : undefined;
    };
    return libraryPage(db, {
      type: (query['type'] as 'all' | 'movie' | 'tv' | undefined) ?? 'all',
      q: query['q'],
      quality: query['quality'],
      health: (query['health'] as 'all' | 'missing' | 'no_hindi' | 'unmatched' | undefined) ?? 'all',
      sort: (query['sort'] as 'latest' | 'title' | 'coverage' | undefined) ?? 'latest',
      limit: num('limit') ?? 48,
      offset: num('offset') ?? 0,
    });
  });

  // Registered before `/library/:mediaId` so Fastify resolves the static path first.
  app.get('/api/v1/library/suggest', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return { titles: suggestTitles(db, query['q'] ?? '') };
  });

  app.get('/api/v1/library/:mediaId', async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string };
    const detail = titleByMediaId(db, Number(mediaId));
    if (detail === null) return reply.code(404).send({ error: 'not found' });
    return detail;
  });

  app.get('/api/v1/forums', async () =>
    db.select().from(forums).all().map((row) => ({ id: row.id, name: row.name, slug: row.slug, language: row.languageHint })),
  );

  app.get('/api/v1/titles/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const detail = titleDetail(db, key);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return detail;
  });

  /** Grouped review queue: one entry per reason, each with the evidence needed to decide. */
  app.get('/api/v1/review', async () => {
    const rows = db
      .select({
        id: variants.id,
        decision: variants.decision,
        reviewReason: variants.reviewReason,
        resolution: variants.resolution,
        sourceTagRaw: variants.sourceTagRaw,
        audioLangs: variants.audioLangs,
        sizeBytes: variants.sizeBytes,
        normTitle: variants.normTitle,
        topicId: topics.id,
        slug: topics.slug,
        rawTitle: topics.rawTitle,
        poster: topics.poster,
        forumId: topics.forumId,
        forumName: forums.name,
        baseUrl: sources.baseUrl,
        sourceTopicId: topics.sourceTopicId,
        kindSource: topics.kindSource,
        tmdbId: media.tmdbId,
        originalLanguage: media.originalLanguage,
        mediaTitle: media.title,
        providerStatus: topics.providerStatus,
        providerProposal: topics.providerProposal,
        kind: topics.kind,
      })
      .from(variants)
      .innerJoin(topics, eq(variants.topicId, topics.id))
      .innerJoin(forums, eq(topics.forumId, forums.id))
      .innerJoin(sources, eq(forums.sourceId, sources.id))
      .leftJoin(media, eq(variants.mediaId, media.id))
      .where(eq(variants.decision, 'unknown'))
      .limit(1000)
      .all();

    // Each item carries the TMDB query to prefill the picker with. `searchHint` is the same rule
    // the Title page uses, and both ask exactly what the provider pass asked.
    type Row = (typeof rows)[number];
    // Omit, not intersect: `Row['kind']` already narrows to 'movie', and intersecting would make tv
    // `kind` is optional: a topic whose kind is neither movie nor show has no provider namespace,
    // and claiming 'movie' would prefill the picker with the wrong search.
    type ReviewItem = Omit<Row, 'kind' | 'baseUrl' | 'sourceTopicId' | 'tmdbId'> & {
      kind?: MediaKind;
      tmdbId: number | null;
      searchQuery: string | null;
      searchYear: number | null;
      link: string;
    };

    const groups = new Map<string, { reason: string; count: number; items: ReviewItem[] }>();
    for (const row of rows) {
      const reason = row.reviewReason ?? 'UNKNOWN';
      const group = groups.get(reason) ?? { reason, count: 0, items: [] };
      group.count++;
      if (group.items.length < 50) {
        const hint = searchHint(row.slug, row.rawTitle);
        const { kind: storedKind, baseUrl, sourceTopicId, tmdbId, ...rest } = row;
        const kind = mediaKindOf(storedKind);
        group.items.push({
          ...rest,
          // Manual rows carry a synthetic negative id; it is database-internal and must not travel.
          tmdbId: tmdbId !== null && tmdbId > 0 ? tmdbId : null,
          ...(kind ? { kind } : {}),
          searchQuery: hint.query,
          searchYear: hint.year,
          link: `${baseUrl.replace(/\/$/, '')}/index.php?/forums/topic/${sourceTopicId}-${row.slug}/`,
        });
      }
      groups.set(reason, group);
    }
    return { total: rows.length, groups: [...groups.values()] };
  });

  app.get('/api/v1/unresolved', async (request, reply) => {
    const query = request.query as { status?: string; q?: string; forum?: string; page?: string; limit?: string };
    const statuses = query.status === undefined || query.status === 'all' ? UNRESOLVED_STATUSES : [query.status];
    for (const status of statuses) {
      if (!UNRESOLVED_STATUSES.includes(status as (typeof UNRESOLVED_STATUSES)[number])) {
        return reply.code(400).send({ error: `unknown status: ${status}` });
      }
    }
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 50);
    if (!Number.isInteger(page) || page < 1) return reply.code(400).send({ error: 'page must be an integer >= 1' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return reply.code(400).send({ error: 'limit must be an integer between 1 and 200' });
    }
    return unresolvedPage(db, {
      statuses,
      q: query.q,
      forumId: query.forum === undefined ? undefined : Number(query.forum),
      page,
      limit,
    });
  });

  /**
   * A human pastes the magnet a shortener was hiding. The feed ranks on resolution and size, so
   * both are required: a variant we cannot rank would either be dropped or mislead Radarr.
   */
  app.post('/api/v1/topics/:id/magnet', async (request, reply) => {
    const topicId = Number((request.params as { id: string }).id);
    const parsed = magnetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const input = parsed.data;

    const topic = db.select().from(topics).where(eq(topics.id, topicId)).get();
    if (!topic) return reply.code(404).send({ error: 'no such topic' });

    const infohash = magnetInfohash(input.magnet);
    if (!infohash) return reply.code(400).send({ error: 'unparseable magnet: no btih hash' });
    const duplicate = db.select({ id: variants.id }).from(variants).where(eq(variants.infohash, infohash)).get();
    if (duplicate) return reply.code(409).send({ error: 'infohash already indexed', variantId: duplicate.id });

    const sourceTag = input.sourceTag;
    const normTitle = normaliseTitle({
      title: topic.rawTitle,
      year: null,
      resolution: input.resolution,
      sourceTag,
      codec: input.codec ?? null,
      audioCodecs: null,
      audioLangs: input.audioLangs,
      sizeBytes: input.sizeBytes,
      season: input.season ?? null,
      epFrom: input.epFrom ?? null,
      epTo: input.epTo ?? null,
      isPack: false,
    });

    const inserted = db
      .insert(variants)
      .values({
        topicId,
        qualityLabel: `${input.resolution} ${sourceTag}`,
        resolution: input.resolution,
        sourceTagRaw: sourceTag,
        sourceTag,
        codec: input.codec ?? null,
        audioLangs: input.audioLangs,
        topicAudioLangs: input.audioLangs,
        sizeBytes: input.sizeBytes,
        infohash,
        magnet: input.magnet,
        normTitle,
        season: input.season ?? null,
        epFrom: input.epFrom ?? null,
        epTo: input.epTo ?? null,
        isPack: false,
        categoryId: topic.kind === 'show' ? 5030 : 2040,
        qualityRank: qualityRank(input.resolution, sourceTag),
        decision: 'hindi_dubbed',
        decisionSource: 'human',
        confidence: 1,
        isPreferred: true,
      })
      .returning()
      .get();

    db.update(topics)
      .set({ status: 'parsed', lastSeenAt: new Date().toISOString() })
      .where(eq(topics.id, topicId))
      .run();
    // A pasted magnet must not become a second preferred row for the same title+resolution: the
    // feed would then serve the same film twice at 1080p, and `dedupeByInfohash` cannot collapse
    // them because the magnets differ.
    selectPreferredAcrossTitles(db);
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'diag',
      scope: 'review',
      event: 'magnet.resolved',
      message: `human supplied a magnet for topic ${topic.sourceTopicId}`,
      variantId: inserted.id,
      detail: { resolution: input.resolution, sizeBytes: input.sizeBytes },
    });
    return inserted;
  });

  /**
   * Re-check a dead topic with one queued fetch rather than an in-request one: the API must never
   * block on the forum, and the worker already owns the status derivation.
   */
  app.post('/api/v1/topics/:id/recheck', async (request, reply) => {
    const topicId = Number((request.params as { id: string }).id);
    const topic = db.select().from(topics).where(eq(topics.id, topicId)).get();
    if (!topic) return reply.code(404).send({ error: 'no such topic' });
    const forum = db.select().from(forums).where(eq(forums.id, topic.forumId)).get();
    const source = forum ? db.select().from(sources).where(eq(sources.id, forum.sourceId)).get() : undefined;
    if (!source) return reply.code(409).send({ error: 'topic has no source' });

    const url = `${source.baseUrl.replace(/\/$/, '')}/index.php?/forums/topic/${topic.sourceTopicId}-${topic.slug}/`;
    const existing = db.select({ id: crawlTasks.id }).from(crawlTasks).where(eq(crawlTasks.url, url)).get();
    if (existing) {
      db.update(crawlTasks)
        .set({ state: 'pending', priority: 0, attempts: 0, nextAttemptAt: null })
        .where(eq(crawlTasks.id, existing.id))
        .run();
    } else {
      db.insert(crawlTasks)
        .values({ url, kind: 'topic', priority: 0, payload: JSON.stringify({ forumId: topic.forumId }) })
        .run();
    }
    return { queued: true, url };
  });

  app.get('/api/v1/coverage', async () => {
    const raw = getState(db, 'coverage_report');
    if (raw === null) return { report: null, generatedAt: null };
    try {
      return { report: JSON.parse(raw) as unknown, generatedAt: getState(db, 'coverage_generated_at') };
    } catch {
      return { report: null, generatedAt: null };
    }
  });

  app.post('/api/v1/review/preview', async (request, reply) => {
    const body = request.body as DecideBody;
    const parsed = nonEmptyRuleSchema.safeParse(body.predicate ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid predicate', issues: parsed.error.issues });
    const action = actionSchema.safeParse(body.action ?? 'hindi_dubbed');
    if (!action.success) return reply.code(400).send({ error: 'invalid action' });
    return previewRule(db, parsed.data, action.data);
  });

  app.post('/api/v1/review/decide', async (request, reply) => {
    const body = request.body as DecideBody;
    const parsedAction = actionSchema.safeParse(body.action ?? 'hindi_dubbed');
    if (!parsedAction.success) return reply.code(400).send({ error: 'invalid action' });
    const action = parsedAction.data;
    const dryRun = body.dryRun === true;

    if (body.applyToSimilar) {
      if (!body.predicate) return reply.code(400).send({ error: 'predicate is required with applyToSimilar' });
      const parsed = nonEmptyRuleSchema.safeParse(body.predicate);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid predicate', issues: parsed.error.issues });
      const preview = previewRule(db, parsed.data, action);
      if (dryRun) return { ...preview, dryRun: true };

      // Identical rule already present: do not insert a second copy, just replay.
      const predicateJson = JSON.stringify(parsed.data);
      const existing = db
        .select()
        .from(rules)
        .where(and(eq(rules.predicate, predicateJson), eq(rules.action, action)))
        .get();
      if (!existing) {
        db.insert(rules)
          .values({ priority: 100, predicate: predicateJson, action, note: 'taught from review queue' })
          .run();
      }
      const replay = replayAll(db);
      return { affected: preview.affected, replay, dryRun: false, ruleCreated: !existing };
    }

    const ids = body.variantIds ?? [];
    if (ids.length === 0) return reply.code(400).send({ error: 'variantIds or predicate required' });

    const rows = db
      .select({
        id: variants.id,
        resolution: variants.resolution,
        audioLangs: variants.audioLangs,
        sourceTagRaw: variants.sourceTagRaw,
        poster: topics.poster,
        slug: topics.slug,
        rawTitle: topics.rawTitle,
        forumId: topics.forumId,
        forumName: forums.name,
      })
      .from(variants)
      .innerJoin(topics, eq(variants.topicId, topics.id))
      .innerJoin(forums, eq(topics.forumId, forums.id))
      .where(inArray(variants.id, ids))
      .all();

    if (dryRun) return { affected: rows.length, dryRun: true };

    db.transaction(
      () => {
        for (const row of rows) {
          const hash = evidenceHash({
            forumId: row.forumId,
            forumName: row.forumName,
            slug: row.slug,
            rawTitle: row.rawTitle,
            poster: row.poster,
            sourceTagRaw: row.sourceTagRaw,
            resolution: row.resolution,
            audioLangs: row.audioLangs,
          });
          db.insert(overrides)
            .values({ evidenceHash: hash, action: action === 'ignore' ? 'not_hindi' : action })
            .onConflictDoUpdate({ target: overrides.evidenceHash, set: { action: action === 'ignore' ? 'not_hindi' : action } })
            .run();
        }
      },
      { behavior: 'immediate' },
    );

    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'review',
      event: 'decide',
      message: `review decision: ${action} on ${rows.length} variant(s)`,
      detail: {
        actor: 'web',
        action,
        affected: rows.length,
        // Already narrowed to `false | undefined` by the `if (body.applyToSimilar)` block above,
        // so a `=== true` comparison here is dead code the compiler rightly rejects.
        applyToSimilar: Boolean(body.applyToSimilar),
        mode: ids.length > 0 ? 'ids' : 'predicate',
      },
    });
    return { affected: rows.length, replay: replayAll(db), dryRun: false };
  });

  app.get('/api/v1/rules', async () => db.select().from(rules).all());

  app.post('/api/v1/rules', async (request, reply) => {
    const body = request.body as { predicate?: unknown; action?: string; priority?: number; note?: string };
    const parsed = nonEmptyRuleSchema.safeParse(body.predicate ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid predicate', issues: parsed.error.issues });
    const parsedAction = actionSchema.safeParse(body.action ?? 'hindi_dubbed');
    if (!parsedAction.success) return reply.code(400).send({ error: 'invalid action' });
    const row = db
      .insert(rules)
      .values({
        priority: body.priority ?? 100,
        predicate: JSON.stringify(parsed.data),
        action: parsedAction.data as 'hindi_dubbed',
        note: body.note ?? null,
      })
      .returning()
      .get();
    const replay = replayAll(db);
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'curation',
      event: 'rule.create',
      message: `rule ${row.id} created: ${row.action}`,
      detail: { actor: 'web', ruleId: row.id, action: row.action, priority: row.priority },
    });
    return { rule: row, replay };
  });

  app.patch('/api/v1/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ruleId = integerParam(id, 'id');
    const body = request.body as { enabled?: boolean; priority?: number; action?: string; predicate?: unknown };
    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) patch['enabled'] = body.enabled;
    if (body.priority !== undefined) patch['priority'] = body.priority;
    if (body.action !== undefined) {
      const parsedAction = actionSchema.safeParse(body.action);
      if (!parsedAction.success) return reply.code(400).send({ error: 'invalid action' });
      patch['action'] = parsedAction.data;
    }
    if (body.predicate !== undefined) {
      const parsed = ruleSchema.safeParse(body.predicate);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid predicate', issues: parsed.error.issues });
      patch['predicate'] = JSON.stringify(parsed.data);
    }
    const row = db.update(rules).set(patch).where(eq(rules.id, ruleId)).returning().get();
    if (!row) return reply.code(404).send({ error: 'not found' });
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'curation',
      event: 'rule.patch',
      message: `rule ${ruleId} patched: ${Object.keys(patch).join(', ')}`,
      detail: { actor: 'web', ruleId, fields: Object.keys(patch) },
    });
    return { rule: row, replay: replayAll(db) };
  });

  app.delete('/api/v1/rules/:id', async (request) => {
    const { id } = request.params as { id: string };
    const ruleId = integerParam(id, 'id');
    db.delete(rules).where(eq(rules.id, ruleId)).run();
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'curation',
      event: 'rule.delete',
      message: `rule ${ruleId} deleted`,
      detail: { actor: 'web', ruleId },
    });
    return { replay: replayAll(db) };
  });

  /**
   * Upload a .torrent for a variant whose magnet was missing. The infohash is derived from the
   * bytes (never trusted from the client), the file is written to the data dir so `/download`
   * can serve it, and a torrent already used by another variant is rejected — otherwise a decoy
   * upload would displace a real release through the emit-time dedupe.
   */
  app.post('/api/v1/torrents/:variantId', async (request, reply) => {
    const { variantId } = request.params as { variantId: string };
    const parsedVariantId = integerParam(variantId, 'variantId');
    const file = await (request as unknown as { file: () => Promise<{ toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });
    const buffer = await file.toBuffer();

    let infohash: string;
    try {
      const { torrentInfohash } = await import('@tamilcache/shared');
      infohash = torrentInfohash(buffer);
    } catch {
      return reply.code(400).send({ error: 'not a valid .torrent file' });
    }

    const existing = db.select().from(variants).where(eq(variants.id, parsedVariantId)).get();
    if (!existing) return reply.code(404).send({ error: 'variant not found' });

    const clash = db
      .select()
      .from(variants)
      .where(and(eq(variants.infohash, infohash), ne(variants.id, existing.id)))
      .get();
    if (clash) {
      return reply.code(409).send({ error: 'this torrent already belongs to another release', variantId: clash.id });
    }

    const magnet = existing.magnet ?? `magnet:?xt=urn:btih:${infohash}`;
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, `${existing.id}.torrent`);
    writeFileSync(path, buffer);

    db.update(variants).set({ infohash, magnet, torrentLocalPath: path }).where(eq(variants.id, existing.id)).run();
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'torznab',
      event: 'upload',
      message: `torrent attached to variant ${existing.id} (${infohash})`,
      variantId: existing.id,
      detail: { actor: 'web', infohash, bytes: buffer.length },
    });

    return { variantId: existing.id, infohash, magnet, torrentLocalPath: path };
  });

  /** Lane control. The worker polls these flags; only it makes outbound requests. */
  app.post('/api/v1/crawl/delta', async () => {
    setState(db, 'delta_requested', '1', 'api');
    return { queued: true };
  });

  app.post('/api/v1/crawl/backfill', async (request) => {
    const body = request.body as { armed?: boolean; paused?: boolean } | undefined;
    if (body?.armed !== undefined) setState(db, 'backfill_armed', body.armed ? '1' : '0', 'api');
    if (body?.paused !== undefined) setState(db, 'backfill_paused', body.paused ? '1' : '0', 'api');
    return { armed: getState(db, 'backfill_armed'), paused: getState(db, 'backfill_paused') };
  });

  app.get('/api/v1/crawl', async () => ({
    armed: getState(db, 'backfill_armed') === '1',
    paused: getState(db, 'backfill_paused') === '1',
    deltaRequested: getState(db, 'delta_requested') === '1',
    lastDeltaAt: getState(db, 'last_delta_at'),
    backfillCompleteAt: getState(db, 'backfill_complete_at'),
    circuitOpenUntil: getState(db, 'circuit_open_until'),
    tmdbBackoffUntil: getState(db, 'tmdb_backoff_until'),
    ...crawlHealth(db),
  }));

  app.get('/api/v1/logs', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query['limit'] ?? 200) || 200, 1), 500);
    const offset = Math.max(Number(query['offset'] ?? 0) || 0, 0);
    const conditions: SQL[] = [];

    if (query['level']) {
      const levels = levelsAtOrAbove(query['level']);
      conditions.push(sql`${logEvents.level} IN (${sql.join(levels.map((level) => sql`${level}`), sql`, `)})`);
    }
    // The columns are enum-typed, so narrow rather than cast: an unknown value is ignored
    // instead of producing a 500 or an untyped comparison.
    const klass = query['class'];
    if (klass === 'audit' || klass === 'diag') conditions.push(eq(logEvents.class, klass));
    if (query['scope']) {
      const scopes = query['scope'].split(',').filter(Boolean);
      conditions.push(sql`${logEvents.scope} IN (${sql.join(scopes.map((scope) => sql`${scope}`), sql`, `)})`);
    }
    const source = query['source'];
    if (source === 'worker' || source === 'api') conditions.push(eq(logEvents.source, source));
    if (query['url']) conditions.push(eq(logEvents.url, query['url']));
    for (const [key, column] of [
      ['runId', logEvents.runId],
      ['taskId', logEvents.taskId],
      ['forumId', logEvents.forumId],
      ['variantId', logEvents.variantId],
    ] as const) {
      const raw = query[key];
      if (raw) conditions.push(eq(column, Number(raw)));
    }
    if (query['q']) {
      const like = `%${query['q'].replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
      conditions.push(
        sql`(${logEvents.message} LIKE ${like} ESCAPE '\\' OR ${logEvents.event} LIKE ${like} ESCAPE '\\' OR ${logEvents.url} LIKE ${like} ESCAPE '\\')`,
      );
    }
    const since = query['since'] ? sinceIso(query['since']) : null;
    if (since) conditions.push(sql`${logEvents.ts} >= ${since}`);

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = db
      .select()
      .from(logEvents)
      .where(where)
      .orderBy(desc(logEvents.ts), desc(logEvents.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      db.select({ count: sql<number>`count(*)` }).from(logEvents).where(where).get()?.count ?? 0;
    return { rows, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  });

  app.get('/api/v1/logs/summary', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const since = sinceIso(query['since'] ?? '24h');
    const windowWhere = since ? sql`${logEvents.ts} >= ${since}` : undefined;
    const byLevel = db
      .select({ level: logEvents.level, count: sql<number>`count(*)` })
      .from(logEvents)
      .where(windowWhere)
      .groupBy(logEvents.level)
      .all();
    const byScope = db
      .select({ scope: logEvents.scope, count: sql<number>`count(*)` })
      .from(logEvents)
      .where(windowWhere)
      .groupBy(logEvents.scope)
      .all();
    const diag = db.select({ count: sql<number>`count(*)` }).from(logEvents).where(eq(logEvents.class, 'diag')).get();
    const audit = db.select({ count: sql<number>`count(*)` }).from(logEvents).where(eq(logEvents.class, 'audit')).get();
    return {
      byLevel: Object.fromEntries(byLevel.map((row) => [row.level, row.count])),
      byScope: Object.fromEntries(byScope.map((row) => [row.scope, row.count])),
      diagRows: diag?.count ?? 0,
      auditRows: audit?.count ?? 0,
    };
  });

  app.get('/api/v1/verify', async () => {
    const checks = runChecks(db);
    return { ok: checks.every((check) => check.pass), checks };
  });

  app.get('/api/v1/health', async (request) => {
    const pending = db.select({ count: sql<number>`count(*)` }).from(variants).where(eq(variants.decision, 'unknown')).get();
    return { ok: true, selfOrigin: originFor(request), reviewBacklog: pending?.count ?? 0 };
  });

  app.post('/api/v1/links/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { kind?: string };
    const parsedId = integerParam(id, 'id');
    const link = db.select().from(links).where(eq(links.id, parsedId)).get();
    if (!link) return { ok: false };
    const linkKinds = ['gdrive', 'shortener', 'stream', 'torrent', 'spam', 'other'] as const;
    if (body.kind) {
      const parsedKind = z.enum(linkKinds).safeParse(body.kind);
      if (!parsedKind.success) return { ok: false, error: 'invalid kind' };
      db.update(links).set({ kind: parsedKind.data }).where(eq(links.id, link.id)).run();
      logEvent(db, {
        source: 'api',
        level: 'info',
        class: 'audit',
        scope: 'curation',
        event: 'link.kind',
        message: `link ${link.id} reclassified: ${link.kind} → ${parsedKind.data}`,
        detail: { actor: 'web', linkId: link.id, from: link.kind, to: parsedKind.data },
      });
    }
    return { ok: true };
  });

  void and;
}
