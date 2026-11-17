export interface SummaryResolutionMap {
  /** `sizeBytes` → resolution, only for sizes the summary pairs unambiguously. */
  bySize: Map<number, string>;
  resolutions: string[];
  ambiguous: boolean;
}

const RES_TOKEN = /\b(2160p|1440p|1080p|720p|576p|480p|360p|4K)\b/gi;
const SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*(GB|MB)\b/gi;

function toBytes(value: string, unit: string): number {
  const n = Number(value);
  const multiplier = unit.toUpperCase() === 'GB' ? 1024 ** 3 : 1024 ** 2;
  return Math.round(n * multiplier);
}

/**
 * The topic body carries a summary line *above* the quality blocks, e.g.
 *
 *   Jailer 2 (2026) Tamil TRUE WEB-DL - [1080p & 720p - AVC / HEVC - (AAC 2.0) - 2.8GB - 1.4GB & 950MB]
 *
 * A block that omits its own resolution can often be identified from that list by size. Pairing
 * is positional and conservative: the first size belongs to the first resolution, and any extra
 * sizes fall to the last one (a `1080p & 720p` list with three sizes means 1080p has one encode
 * and 720p has two). A size that appears more than once makes the whole map ambiguous — guessing
 * there would silently mislabel a release, which is worse than dropping it.
 */
export function resolutionBySizeFromSummary(line: string): SummaryResolutionMap {
  const resolutions = [...line.matchAll(RES_TOKEN)]
    .map((match) => (match[1] ?? '').toLowerCase())
    .map((value) => (value === '4k' ? '2160p' : value));

  const sizes = [...line.matchAll(SIZE_TOKEN)].map((match) => toBytes(match[1] ?? '0', match[2] ?? 'MB'));

  const bySize = new Map<number, string>();
  if (resolutions.length === 0 || sizes.length === 0) {
    return { bySize, resolutions, ambiguous: false };
  }

  const seen = new Map<number, string>();
  let ambiguous = false;

  sizes.forEach((size, index) => {
    const resolution = resolutions[Math.min(index, resolutions.length - 1)] as string;
    const previous = seen.get(size);
    if (previous !== undefined && previous !== resolution) {
      ambiguous = true;
      return;
    }
    seen.set(size, resolution);
  });

  if (ambiguous) return { bySize: new Map(), resolutions, ambiguous };

  for (const [size, resolution] of seen) bySize.set(size, resolution);
  return { bySize, resolutions, ambiguous };
}
