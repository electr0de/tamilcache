/** Resolutions we cache. Anything below 1080p is dropped at persist time. */
export const KEPT_RESOLUTIONS = ['1080p', '1440p', '2160p'] as const;
export type KeptResolution = (typeof KEPT_RESOLUTIONS)[number];

/** Higher resolutions are preferred under a different rule, so the size bias flips at 4K. */
const HIGH_RES = new Set<string>(['2160p']);

export function isKeptResolution(resolution: string | null): resolution is KeptResolution {
  return resolution !== null && (KEPT_RESOLUTIONS as readonly string[]).includes(resolution);
}

export interface Selectable {
  id: number;
  resolution: string | null;
  sizeBytes: number;
}

/**
 * Which variant to hand to the *arrs for a given (title, resolution).
 *
 * 1080p: keep the **largest** file — at that resolution a bigger encode is a better encode.
 * 4K:    keep the **smallest** file — two 2160p encodes of the same film are visually
 *        indistinguishable, and the smaller one is cheaper to store and seed.
 *
 * Returns the ids that are preferred. Every other variant stays in the database as an
 * alternative so nothing is lost and the decision can be revisited.
 */
export function selectPreferred<T extends Selectable>(variants: T[]): Set<number> {
  const byResolution = new Map<string, T[]>();
  for (const variant of variants) {
    if (!isKeptResolution(variant.resolution)) continue;
    const bucket = byResolution.get(variant.resolution) ?? [];
    bucket.push(variant);
    byResolution.set(variant.resolution, bucket);
  }

  const preferred = new Set<number>();
  for (const [resolution, bucket] of byResolution) {
    const wantsSmallest = HIGH_RES.has(resolution);
    let best: T | null = null;
    for (const variant of bucket) {
      if (variant.sizeBytes <= 0) continue;
      if (!best) {
        best = variant;
        continue;
      }
      const better = wantsSmallest ? variant.sizeBytes < best.sizeBytes : variant.sizeBytes > best.sizeBytes;
      if (better) best = variant;
    }
    if (best) preferred.add(best.id);
  }
  return preferred;
}
