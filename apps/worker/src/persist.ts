import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@tamilcache/db';
import { links, topics, variants } from '@tamilcache/db/schema';
import {
  isKeptResolution,
  kindEvidence,
  mapSourceTag,
  normaliseTitle,
  parseSeasonEpisode,
  parseTopicPage,
  qualityRank,
  selectPreferred,
  type ParsedTopic,
} from '@tamilcache/shared';

export interface PersistContext {
  sourceId: number;
  forumId: number;
  forumSlug?: string | null;
}

export interface PersistResult {
  topicId: number;
  created: boolean;
  variantsInserted: number;
  variantsSkipped: number;
  unknownSource: number;
  /** Below 1080p, or with no resolution we could establish. Never stored. */
  variantsDropped: number;
  /** Torrent-only blocks whose attachment could not be turned into a hash (yet). */
  variantsUnresolved: number;
  preferred: number;
}

export interface PersistOptions {
  /**
   * Attachment URL → infohash, resolved by the caller before the write.
   *
   * `variants.infohash` is NOT NULL, and SQLite cannot drop that without rebuilding the table that
   * `variants_fts` and `variants_view` depend on — so a torrent-only block is written with its
   * derived hash, or not written at all. A placeholder hash would also poison `dedupeByInfohash()`,
   * which partitions by infohash.
   */
  torrentHashes?: Map<string, string>;
  /** The listing's view count for this topic, copied onto every variant for the dedupe tie-break. */
  views?: number | null;
}

function hashFor(variant: ParsedTopic['variants'][number], options: PersistOptions): string | null {
  return variant.infohash ?? (variant.torrentUrl ? options.torrentHashes?.get(variant.torrentUrl) ?? null : null);
}

export function persistTopic(
  db: Db,
  html: string,
  url: string,
  baseUrl: string,
  ctx: PersistContext,
  options: PersistOptions = {},
): PersistResult {
  const parsed: ParsedTopic = parseTopicPage(html, baseUrl);
  if (parsed.sourceTopicId === null) throw new Error(`no topic id in ${url}`);

  // The hash (or, failing that, the attachment URL) identifies the release, so a later crawl that
  // finally resolves the attachment counts as a change and rewrites the row.
  const contentHash = createHash('sha1')
    .update(JSON.stringify(parsed.variants.map((variant) => hashFor(variant, options) ?? variant.torrentUrl ?? '').sort()))
    .digest('hex');

  const season = parseSeasonEpisode(parsed.slug);
  const evidence = kindEvidence({ slug: parsed.slug, rawTitle: parsed.rawTitle, forumSlug: ctx.forumSlug ?? null });
  // `unknown` is stored as 'movie' only because the column has no better value; the provider
  // pass re-decides with `decideMatchAcrossTypes()` and writes the answer back.
  const kind = evidence.kind === 'unknown' ? 'movie' : evidence.kind;

  const existing = db
    .select()
    .from(topics)
    .where(and(eq(topics.sourceId, ctx.sourceId), eq(topics.sourceTopicId, parsed.sourceTopicId)))
    .get();

  let topicId: number;
  let created = false;
  let result: PersistResult | null = null;

  const write = (): void => {
    if (existing) {
      topicId = existing.id;
      if (existing.contentHash !== contentHash) {
        // A re-crawl must not undo a provider's or a human's correction: the parser's guess is the
        // weakest evidence we have about what kind of title this is, so it may only fill a blank.
        const authoritative = existing.kindSource === 'tmdb' || existing.kindSource === 'human';
        db.update(topics)
          .set({
            contentHash,
            lastSeenAt: new Date().toISOString(),
            status: 'parsed',
            ...(authoritative ? {} : { kind, kindSource: 'parse' as const }),
          })
          .where(eq(topics.id, topicId))
          .run();
      } else {
        db.update(topics).set({ lastSeenAt: new Date().toISOString() }).where(eq(topics.id, topicId)).run();
      }
    } else {
      const row = db
        .insert(topics)
        .values({
          sourceId: ctx.sourceId,
          forumId: ctx.forumId,
          sourceTopicId: parsed.sourceTopicId as number,
          slug: parsed.slug,
          rawTitle: parsed.rawTitle,
          poster: parsed.poster,
          contentHash,
          kind,
          kindSource: 'parse',
          status: 'parsed',
        })
        .returning()
        .get();
      topicId = row.id;
      created = true;
    }

    let variantsInserted = 0;
    let variantsSkipped = 0;
    let unknownSource = 0;
    let variantsDropped = 0;
    let variantsUnresolved = 0;

    for (const variant of parsed.variants) {
      // Only 1080p and above are cached. Sub-1080p and unresolvable blocks are dropped at the
      // source so they never consume Torznab result slots or review attention.
      if (!isKeptResolution(variant.resolution)) {
        variantsDropped++;
        continue;
      }
      // An attachment could not be read this pass: the block is real, it just has nothing the
      // indexer can serve yet. Counted so the topic can be marked `parse_failed` and retried.
      const infohash = hashFor(variant, options);
      if (infohash === null) {
        variantsUnresolved++;
        continue;
      }
      const mapping = mapSourceTag(variant.sourceTagRaw);
      if (mapping.tag === null) unknownSource++;

      const normalised = mapping.tag
        ? normaliseTitle({
            title: variant.title,
            year: variant.year,
            resolution: variant.resolution,
            sourceTag: mapping.tag,
            codec: variant.codec,
            audioCodecs: variant.audioCodecs,
            audioLangs: variant.audioLangs,
            sizeBytes: variant.sizeBytes,
            season: season?.season ?? null,
            epFrom: season?.epFrom ?? null,
            epTo: season?.epTo ?? null,
            isPack: season?.isPack ?? false,
          })
        : null;

      const inserted = db
        .insert(variants)
        .values({
          topicId,
          qualityLabel: variant.qualityLabel,
          resolution: variant.resolution,
          sourceTagRaw: variant.sourceTagRaw,
          sourceTag: mapping.tag ?? 'UNKNOWN',
          codec: variant.codec,
          audioCodecs: variant.audioCodecs,
          audioLangs: variant.audioLangs,
          topicAudioLangs: variant.topicAudioLangs,
          topicViews: options.views ?? null,
          audioSourceCount: variant.audioSourceCount,
          sizeBytes: variant.sizeBytes,
          infohash,
          magnet: variant.magnet ?? `magnet:?xt=urn:btih:${infohash}`,
          torrentUrl: variant.torrentUrl,
          normTitle: normalised,
          season: season?.season ?? null,
          epFrom: season?.epFrom ?? null,
          epTo: season?.epTo ?? null,
          isPack: season?.isPack ?? false,
          categoryId: kind === 'show' ? 5030 : 2040,
          qualityRank: qualityRank(variant.resolution, mapping.tag),
          reviewReason: mapping.tag ? null : 'UNKNOWN_SOURCE',
        })
        .onConflictDoNothing()
        .returning()
        .get();

      if (inserted) variantsInserted++;
      else variantsSkipped++;
    }

    for (const link of parsed.links) {
      if (link.kind === 'other' || link.kind === 'torrent') continue;
      const duplicate = db
        .select()
        .from(links)
        .where(and(eq(links.topicId, topicId), eq(links.url, link.url)))
        .get();
      if (duplicate) continue;
      db.insert(links).values({ topicId, url: link.url, kind: link.kind, label: link.label }).run();
    }

    // One preferred variant per resolution: largest 1080p, smallest 4K. The rest stay as
    // alternatives so the choice is revisitable and nothing already crawled is lost.
    const stored = db.select().from(variants).where(eq(variants.topicId, topicId)).all();
    const preferredIds = selectPreferred(stored);
    for (const row of stored) {
      const shouldPrefer = preferredIds.has(row.id);
      if (row.isPreferred !== shouldPrefer) {
        db.update(variants).set({ isPreferred: shouldPrefer }).where(eq(variants.id, row.id)).run();
      }
    }

    result = {
      topicId,
      created,
      variantsInserted,
      variantsSkipped,
      unknownSource,
      variantsDropped,
      variantsUnresolved,
      preferred: preferredIds.size,
    };
  };

  db.transaction(write, { behavior: 'immediate' });
  if (!result) throw new Error(`persist produced no result for ${url}`);
  return result;
}
