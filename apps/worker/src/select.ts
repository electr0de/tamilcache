import { eq } from 'drizzle-orm';
import type { Db } from '@tamilcache/db';
import { topics, variants } from '@tamilcache/db/schema';
import { isKeptResolution, KEPT_RESOLUTIONS } from '@tamilcache/shared';

export interface SelectionSummary {
  scanned: number;
  preferred: number;
  changed: number;
}

interface Candidate {
  id: number;
  resolution: string;
  sizeBytes: number;
  topicViews: number | null;
  publishedAt: string | null;
  titleKey: string;
}

/**
 * The film a release belongs to, when there is no TMDB match to key on.
 *
 * `normaliseTitle()` produces a *release* name and includes the size (`…-hindi.5gb-tmv`), so two
 * encodes of the same film at the same resolution produced two different keys and both stayed
 * preferred — the dedupe silently did nothing for the 21% of variants without a `media_id`. Cut
 * the name at its first quality token; everything before it is the film and its year.
 */
const QUALITY_TOKEN =
  /\.(?:2160p|1440p|1080p|720p|576p|480p|360p|4k)\b|\.(?:web-?dl|webrip|web-?rip|blu-?ray|bdrip|brrip|hdrip|hdtv|sdtv|predvd|dvdrip|dvd9|dvd5|hdrip|hdcam|cam|dvdscr)\b/;

export function filmKey(normTitle: string | null, rawTitle: string): string {
  const source = (normTitle ?? rawTitle).toLowerCase();
  const cut = source.search(QUALITY_TOKEN);
  return cut > 0 ? source.slice(0, cut) : source;
}

/** 2160p prefers the smaller file; every other kept resolution prefers the larger one. */
const prefersSmallest = (resolution: string): boolean => resolution === '2160p';

function beats(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.sizeBytes !== incumbent.sizeBytes) {
    return prefersSmallest(candidate.resolution)
      ? candidate.sizeBytes < incumbent.sizeBytes
      : candidate.sizeBytes > incumbent.sizeBytes;
  }
  const views = candidate.topicViews ?? 0;
  const otherViews = incumbent.topicViews ?? 0;
  if (views !== otherViews) return views > otherViews;
  if ((candidate.publishedAt ?? '') !== (incumbent.publishedAt ?? '')) {
    return (candidate.publishedAt ?? '') > (incumbent.publishedAt ?? '');
  }
  return candidate.id < incumbent.id;
}

/**
 * One preferred release per title per resolution, across every board the title was posted in.
 *
 * `persistTopic` can only rank inside one topic, and the same film is routinely posted in several
 * language sections — so before this pass a title could hand Radarr two different 1080p releases,
 * chosen by whichever topic happened to be crawled last. Resolution stays part of the key on
 * purpose: a 1080p and a 2160p of one film are both legitimate, and the *arr's quality profile
 * makes the final choice.
 */
export function selectPreferredAcrossTitles(db: Db): SelectionSummary {
  const rows = db
    .select({
      id: variants.id,
      resolution: variants.resolution,
      sizeBytes: variants.sizeBytes,
      topicViews: variants.topicViews,
      publishedAt: variants.publishedAt,
      mediaId: variants.mediaId,
      normTitle: variants.normTitle,
      rawTitle: topics.rawTitle,
      infohash: variants.infohash,
      isPreferred: variants.isPreferred,
    })
    .from(variants)
    .innerJoin(topics, eq(variants.topicId, topics.id))
    .all();

  const winners = new Map<string, Candidate>();
  let scanned = 0;
  for (const row of rows) {
    if (!isKeptResolution(row.resolution)) continue;
    if (row.infohash === '') continue;
    scanned++;
    const titleKey = row.mediaId !== null ? `m${row.mediaId}` : filmKey(row.normTitle, row.rawTitle);
    const key = `${titleKey}|${row.resolution}`;
    const candidate: Candidate = {
      id: row.id,
      resolution: row.resolution,
      sizeBytes: row.sizeBytes,
      topicViews: row.topicViews,
      publishedAt: row.publishedAt,
      titleKey,
    };
    const incumbent = winners.get(key);
    if (!incumbent || beats(candidate, incumbent)) winners.set(key, candidate);
  }

  const winnerIds = new Set([...winners.values()].map((row) => row.id));
  let changed = 0;
  db.transaction(
    () => {
      for (const row of rows) {
        const want = winnerIds.has(row.id);
        if (row.isPreferred === want) continue;
        db.update(variants).set({ isPreferred: want }).where(eq(variants.id, row.id)).run();
        changed++;
      }
    },
    { behavior: 'immediate' },
  );

  return { scanned, preferred: winnerIds.size, changed };
}

export { KEPT_RESOLUTIONS };
