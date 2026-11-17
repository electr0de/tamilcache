import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '@tamilcache/db';
import { forums, sources } from '@tamilcache/db/schema';
import { eq } from 'drizzle-orm';

export interface ForumConfig {
  id: number;
  slug: string;
  language: string;
  /**
   * A language section (`tamil-language`, `hindi-language`, …) is a container page: it lists its
   * subforums and has no `cTopicList`. Fetching it as a listing yields nothing, so it is kept in
   * the allowlist for breadcrumb attribution but never queued for a listing or backfill page.
   */
  hub?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

/** `config/forums.json` is the scope allowlist: everything not listed never enters the frontier. */
export function loadForumConfig(path = process.env['FORUMS_CONFIG'] ?? join(here, '../../..', 'config/forums.json')): ForumConfig[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected an array of forums`);
  return parsed.map((entry) => {
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'number' || typeof row['slug'] !== 'string') {
      throw new Error(`${path}: each forum needs { id: number, slug: string }`);
    }
    return {
      id: row['id'],
      slug: row['slug'],
      language: typeof row['language'] === 'string' ? row['language'] : 'unknown',
      ...(row['hub'] === true ? { hub: true } : {}),
    };
  });
}

export interface ScopeEntry {
  id: number;
  include: boolean;
  reason: string;
}

/**
 * `config/scope.json` records an include/exclude decision for **every** board the site serves.
 *
 * The allowlist alone cannot express "we looked at this board and chose not to crawl it": an
 * excluded board and a board nobody noticed look identical in `forums.json`. The coverage audit
 * fails on that ambiguity, which is what stops coverage drifting when the site adds a section.
 */
export function loadScope(path = process.env['SCOPE_CONFIG'] ?? join(here, '../../..', 'config/scope.json')): Map<number, ScopeEntry> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const boards = (parsed as { boards?: unknown }).boards;
  if (!Array.isArray(boards)) throw new Error(`${path}: expected { boards: [...] }`);
  const scope = new Map<number, ScopeEntry>();
  for (const entry of boards) {
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'number' || typeof row['include'] !== 'boolean' || typeof row['reason'] !== 'string') {
      throw new Error(`${path}: each board needs { id: number, include: boolean, reason: string }`);
    }
    scope.set(row['id'], { id: row['id'], include: row['include'], reason: row['reason'] });
  }
  return scope;
}

/**
 * A configured board must be included; an excluded board must not be configured; an included board
 * must exist in the allowlist. Any mismatch is a coverage bug, not a preference.
 */
export function scopeViolations(config: ForumConfig[], scope: Map<number, ScopeEntry>): string[] {
  const problems: string[] = [];
  for (const forum of config) {
    const entry = scope.get(forum.id);
    if (!entry) problems.push(`board ${forum.id} (${forum.slug}) has no scope decision`);
    else if (!entry.include && !forum.hub) problems.push(`board ${forum.id} (${forum.slug}) is configured but excluded`);
  }
  for (const entry of scope.values()) {
    if (entry.include && !config.some((forum) => forum.id === entry.id)) {
      problems.push(`board ${entry.id} is included but missing from config/forums.json`);
    }
  }
  return problems;
}

export function mirrorList(raw = process.env['MIRRORS'] ?? 'www.1tamilmv.io'): string[] {
  return raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0)
    .map((host) => (host.startsWith('http') ? host : `https://${host}`));
}

/** Idempotent: safe to run on every boot. */
export function seedSourcesAndForums(db: Db, baseUrl: string, config: ForumConfig[]): { sourceId: number; forumIds: Map<number, number> } {
  let source = db.select().from(sources).where(eq(sources.baseUrl, baseUrl)).get();
  if (!source) {
    source = db
      .insert(sources)
      .values({ baseUrl, label: new URL(baseUrl).hostname, status: 'healthy' })
      .returning()
      .get();
  }

  const forumIds = new Map<number, number>();
  for (const forum of config) {
    const existing = db
      .select()
      .from(forums)
      .where(eq(forums.sourceForumId, forum.id))
      .get();
    const row =
      existing ??
      db
        .insert(forums)
        .values({
          sourceId: source.id,
          sourceForumId: forum.id,
          name: forum.slug,
          slug: forum.slug,
          inScope: true,
          languageHint: forum.language,
        })
        .returning()
        .get();
    forumIds.set(forum.id, row.id);
  }

  return { sourceId: source.id, forumIds };
}

/**
 * The site routes on the numeric id: `/forums/forum/57-predvd-dvdscr-cam-tc/` is the Hindi forum,
 * while the slug alone is ambiguous (five languages share `predvd-dvdscr-cam-tc`) and resolves to
 * the board index. Every forum therefore carries its id into the path.
 */
export function forumUrl(
  baseUrl: string,
  forum: { id: number; slug: string },
  page?: number,
): string {
  const slug = forum.slug.replace(new RegExp(`^${forum.id}-`), '');
  const suffix = page && page > 1 ? `/page/${page}/` : '/';
  return `${baseUrl.replace(/\/$/, '')}/index.php?/forums/forum/${forum.id}-${slug}${suffix}`;
}
