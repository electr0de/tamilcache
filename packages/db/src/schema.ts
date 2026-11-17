import { sqliteTable, integer, text, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const id = () => integer('id').primaryKey({ autoIncrement: true });

/**
 * ISO-8601 with milliseconds, e.g. `2026-11-09T12:56:33.123Z`.
 *
 * `CURRENT_TIMESTAMP` emits `2026-11-09 12:56:33`; since `' ' < 'T'` those values sort
 * *before* every `new Date().toISOString()` value in the same column, silently corrupting
 * ORDER BY and range filters. Must match `migrate()` in `client.ts` exactly.
 */
const isoNow = () => sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const now = () => text('created_at').notNull().default(isoNow());

export const sources = sqliteTable('sources', {
  id: id(),
  baseUrl: text('base_url').notNull().unique(),
  label: text('label').notNull(),
  status: text('status', { enum: ['healthy', 'failing', 'unknown'] }).notNull().default('unknown'),
  lastOkAt: text('last_ok_at'),
  failCount: integer('fail_count').notNull().default(0),
});

export const forums = sqliteTable('forums', {
  id: id(),
  sourceId: integer('source_id').notNull().references(() => sources.id),
  sourceForumId: integer('source_forum_id').notNull(),
  name: text('name').notNull(),
  slug: text('slug'),
  inScope: integer('in_scope', { mode: 'boolean' }).notNull().default(false),
  languageHint: text('language_hint'),
  category: text('category'),
}, (t) => ({ uq: uniqueIndex('forums_uq').on(t.sourceId, t.sourceForumId) }));

export const topics = sqliteTable('topics', {
  id: id(),
  sourceId: integer('source_id').notNull().references(() => sources.id),
  forumId: integer('forum_id').notNull().references(() => forums.id),
  sourceTopicId: integer('source_topic_id').notNull(),
  slug: text('slug').notNull(),
  rawTitle: text('raw_title').notNull(),
  poster: text('poster'),
  firstSeenAt: text('first_seen_at').notNull().default(isoNow()),
  lastSeenAt: text('last_seen_at').notNull().default(isoNow()),
  contentHash: text('content_hash'),
  kind: text('kind', { enum: ['movie', 'show', 'other'] }).notNull(),
  /**
   * What the topic's links are, not whether a function succeeded (see `deriveStatus()`):
   *
   * - `parsed`       a magnet or `.torrent` produced at least one variant
   * - `external`     no download, but a shortener / stream / Drive link — a human can resolve it
   * - `no_link`      no download and no post links (site chrome only)
   * - `gone`         upstream 404/410 — the only state in the dead-link list
   * - `parse_failed` a download is on the page and our parser could not turn it into a variant
   *
   * `no_magnet` is legacy: rows written before the split, rewritten by the reclassify pass.
   */
  status: text('status', {
    enum: [
      'new',
      'parsed',
      'error',
      'ignored',
      'no_magnet',
      'external',
      'no_link',
      'gone',
      'parse_failed',
      'below_floor',
    ],
  })
    .notNull()
    .default('new'),
  parseError: text('parse_error'),
  /** Listing view count, refreshed on every listing fetch. Tie-break only; NULL means "not read". */
  views: integer('views'),
  /** Provider (TMDB) resolution state for this topic. */
  providerStatus: text('provider_status', {
    enum: ['pending', 'matched', 'ambiguous', 'none', 'skipped'],
  })
    .notNull()
    .default('pending'),
  /** JSON `{ tmdbId, title, year, originalLanguage, score, reasons }` for the review queue. */
  providerProposal: text('provider_proposal'),
  providerCheckedAt: text('provider_checked_at'),
  /** Who decided `kind`: the parser, a provider, or a human in the review queue. */
  kindSource: text('kind_source', { enum: ['parse', 'tmdb', 'tvdb', 'human'] }),
}, (t) => ({
  uq: uniqueIndex('topics_uq').on(t.sourceId, t.sourceTopicId),
  forumIdx: index('topics_forum_idx').on(t.forumId),
}));

export const variants = sqliteTable('variants', {
  id: id(),
  topicId: integer('topic_id').notNull().references(() => topics.id, { onDelete: 'cascade' }),
  qualityLabel: text('quality_label'),
  resolution: text('resolution'),
  sourceTagRaw: text('source_tag_raw').notNull(),
  sourceTag: text('source_tag').notNull(),
  codec: text('codec'),
  audioCodecs: text('audio_codecs'),
  /**
   * Union of every place on the topic page that named audio languages (title, block header,
   * post prose). Positive evidence: a `hindi` anywhere in here always wins.
   */
  audioLangs: text('audio_langs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /**
   * Languages named by the topic-level places (title, labelled prose). Stored apart from
   * `audioLangs` because a block header is per-block evidence: a Tamil-dub block must not
   * inherit `english` from the topic title.
   */
  topicAudioLangs: text('topic_audio_langs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /**
   * How many of those places produced a list. Two agreeing places (or one plus a TMDB
   * `original_language`) is what lets `classify()` say `not_hindi` without a human.
   */
  audioSourceCount: integer('audio_source_count').notNull().default(0),
  /** The owning topic's view count at persist time, so SQL can break a tie without a join. */
  topicViews: integer('topic_views'),
  sizeBytes: integer('size_bytes').notNull(),
  infohash: text('infohash').notNull(),
  magnet: text('magnet'),
  torrentUrl: text('torrent_url'),
  torrentLocalPath: text('torrent_local_path'),
  normTitle: text('norm_title'),
  mediaId: integer('media_id').references(() => media.id),
  season: integer('season'),
  epFrom: integer('ep_from'),
  epTo: integer('ep_to'),
  isPack: integer('is_pack', { mode: 'boolean' }).notNull().default(false),
  categoryId: integer('category_id'),
  publishedAt: text('published_at'),
  decision: text('decision', {
    enum: ['hindi_dubbed', 'hindi_original', 'not_hindi', 'unknown'],
  }).notNull().default('unknown'),
  /** `human` is a decision a person made in the UI (pasting a magnet is one). */
  decisionSource: text('decision_source', {
    enum: ['provider', 'rule', 'override', 'auto', 'human'],
  }),
  confidence: real('confidence'),
  classifierVersion: integer('classifier_version').notNull().default(0),
  reviewReason: text('review_reason'),
  qualityRank: integer('quality_rank').notNull().default(0),
  /** Chosen per (topic, resolution): largest 1080p, smallest 4K. See `selectPreferred`. */
  isPreferred: integer('is_preferred', { mode: 'boolean' }).notNull().default(false),
}, (t) => ({
  uq: uniqueIndex('variants_uq').on(t.topicId, t.infohash),
  hashIdx: index('variants_hash_idx').on(t.infohash),
  decisionIdx: index('variants_decision_idx').on(t.decision),
  // Review queue: `WHERE review_reason IS NOT NULL`. Partial keeps the index tiny.
  reviewIdx: index('variants_review_idx').on(t.reviewReason).where(sql`review_reason IS NOT NULL`),
  preferredIdx: index('variants_preferred_idx').on(t.isPreferred).where(sql`is_preferred = 1`),
}));

export const links = sqliteTable('links', {
  id: id(),
  variantId: integer('variant_id').references(() => variants.id, { onDelete: 'cascade' }),
  topicId: integer('topic_id').references(() => topics.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  kind: text('kind', {
    // `download` is an external host the shortener list does not know: still a link a person can
    // follow, so it must not be dropped as noise (`other`).
    enum: ['gdrive', 'shortener', 'stream', 'torrent', 'spam', 'other', 'download'],
  }).notNull(),
  label: text('label'),
  resolvedUrl: text('resolved_url'),
  resolverStatus: text('resolver_status'),
}, (t) => ({
  uq: uniqueIndex('links_topic_url_idx').on(t.topicId, t.url),
  // `variant_id` cascades on variant delete; without this, one topic delete scans `links`.
  variantIdx: index('links_variant_idx').on(t.variantId),
}));

export const media = sqliteTable('media', {
  id: id(),
  tmdbId: integer('tmdb_id').notNull().unique(),
  type: text('type', { enum: ['movie', 'tv'] }).notNull(),
  title: text('title').notNull(),
  year: integer('year'),
  originalLanguage: text('original_language'),
  imdbId: text('imdb_id'),
  tvdbId: integer('tvdb_id'),
  seasons: integer('seasons'),
  posterPath: text('poster_path'),
  overview: text('overview'),
  /**
   * TMDB fields the detail call already returns. They were discarded at parse time until schema
   * v9, which is why nine years of `/movie|tv/{id}` responses bought no rating, genre or backdrop.
   */
  genres: text('genres', { mode: 'json' }).$type<string[]>().notNull().default([]),
  voteAverage: real('vote_average'),
  voteCount: integer('vote_count'),
  runtime: integer('runtime'),
  backdropPath: text('backdrop_path'),
  status: text('status'),
}, (t) => ({
  // Manual and media rows are keyed by IMDb id; a partial index still allows unlimited NULLs.
  imdbUq: uniqueIndex('media_imdb_uq').on(t.imdbId).where(sql`imdb_id IS NOT NULL`),
}));

export const mediaEpisodes = sqliteTable('media_episodes', {
  id: id(),
  mediaId: integer('media_id').notNull().references(() => media.id, { onDelete: 'cascade' }),
  season: integer('season').notNull(),
  episode: integer('episode').notNull(),
  airDate: text('air_date'),
  name: text('name'),
}, (t) => ({ uq: uniqueIndex('media_episodes_uq').on(t.mediaId, t.season, t.episode) }));

export const metadataCache = sqliteTable('metadata_cache', {
  id: id(),
  queryKey: text('query_key').notNull().unique(),
  payload: text('payload').notNull(),
  fetchedAt: text('fetched_at').notNull().default(isoNow()),
});

export const rules = sqliteTable('rules', {
  id: id(),
  priority: integer('priority').notNull().default(100),
  predicate: text('predicate').notNull(),
  action: text('action', {
    enum: ['hindi_dubbed', 'hindi_original', 'not_hindi', 'ignore'],
  }).notNull(),
  note: text('note'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  hits: integer('hits').notNull().default(0),
  createdAt: now(),
});

export const overrides = sqliteTable('overrides', {
  id: id(),
  evidenceHash: text('evidence_hash').notNull().unique(),
  action: text('action', { enum: ['hindi_dubbed', 'hindi_original', 'not_hindi'] }).notNull(),
  note: text('note'),
  createdAt: now(),
});

export const crawlTasks = sqliteTable('crawl_tasks', {
  id: id(),
  url: text('url').notNull().unique(),
  kind: text('kind', { enum: ['listing', 'topic', 'delta_page'] }).notNull(),
  priority: integer('priority').notNull().default(1),
  state: text('state', { enum: ['pending', 'running', 'done', 'error'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  payload: text('payload'),
  runId: integer('run_id'),
}, (t) => ({ pick: index('crawl_tasks_pick_idx').on(t.state, t.priority, t.id) }));

export const crawlRuns = sqliteTable('crawl_runs', {
  id: id(),
  kind: text('kind', { enum: ['delta', 'backfill'] }).notNull(),
  startedAt: text('started_at').notNull().default(isoNow()),
  finishedAt: text('finished_at'),
  tasksTotal: integer('tasks_total').notNull().default(0),
  tasksDone: integer('tasks_done').notNull().default(0),
  tasksFailed: integer('tasks_failed').notNull().default(0),
});

export const backfillState = sqliteTable('backfill_state', {
  id: id(),
  forumId: integer('forum_id').notNull().references(() => forums.id).unique(),
  nextPage: integer('next_page').notNull().default(1),
  totalPages: integer('total_pages'),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  /**
   * Consecutive failed attempts. A page that throws records one and schedules `retryAfter`; a page
   * that parses clears all three. Without them a failing forum starves the backfill: it never gets
   * a cursor row, so `nextBackfillForums` sees page 1 and hands it every tick's slots.
   */
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  retryAfter: text('retry_after'),
  updatedAt: text('updated_at').notNull().default(isoNow()),
});

export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * One row per event. `class` is the retention contract: `audit` rows (human decisions, Sonarr
 * grabs, lane changes) are never pruned; `diag` rows expire. See docs/LOGS.md.
 */
export const logEvents = sqliteTable('log_events', {
  id: id(),
  ts: text('ts').notNull(),
  source: text('source', { enum: ['worker', 'api'] }).notNull(),
  level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull(),
  class: text('class', { enum: ['audit', 'diag'] }).notNull(),
  scope: text('scope').notNull(),
  event: text('event').notNull(),
  message: text('message').notNull(),
  url: text('url'),
  taskId: integer('task_id'),
  runId: integer('run_id'),
  forumId: integer('forum_id'),
  variantId: integer('variant_id'),
  detail: text('detail'),
}, (t) => ({
  byTs: index('log_events_ts_idx').on(t.ts),
  byLevel: index('log_events_level_idx').on(t.level, t.ts),
  byScope: index('log_events_scope_idx').on(t.scope, t.ts),
  byClass: index('log_events_class_idx').on(t.class, t.ts),
  byUrl: index('log_events_url_idx').on(t.url),
  byRun: index('log_events_run_idx').on(t.runId),
}));
