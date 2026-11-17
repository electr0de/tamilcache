import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolutionBySizeFromSummary } from '../src/summary-resolution.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('resolutionBySizeFromSummary', () => {
  it('pairs the real summary line from multi-quality.html', () => {
    const map = resolutionBySizeFromSummary(
      'Jailer 2 (2026) Tamil TRUE WEB-DL - [1080p & 720p - AVC / HEVC - (AAC 2.0) - 2.8GB - 1.4GB & 950MB]',
    );
    expect(map.resolutions).toEqual(['1080p', '720p']);
    expect(map.bySize.get(Math.round(2.8 * GB))).toBe('1080p');
    expect(map.bySize.get(Math.round(1.4 * GB))).toBe('720p');
    // The extra size falls to the last resolution rather than becoming unknown.
    expect(map.bySize.get(950 * MB)).toBe('720p');
  });

  it('normalises 4K to 2160p', () => {
    const map = resolutionBySizeFromSummary('[4K & 1080p - AVC - 23GB - 5GB]');
    expect(map.resolutions).toEqual(['2160p', '1080p']);
    expect(map.bySize.get(Math.round(23 * GB))).toBe('2160p');
  });

  it('flags ambiguity instead of guessing when a size repeats under two resolutions', () => {
    const map = resolutionBySizeFromSummary('[1080p & 720p - 900MB]');
    // one size, two resolutions: the size maps to 1080p positionally, no conflict
    expect(map.ambiguous).toBe(false);

    const conflicting = resolutionBySizeFromSummary('[1080p] [720p] - 900MB - 900MB');
    expect(conflicting.ambiguous).toBe(true);
    expect(conflicting.bySize.size).toBe(0);
  });

  it('returns an empty map for a line with no resolutions', () => {
    const map = resolutionBySizeFromSummary('Some Film (2026) Tamil - 700MB');
    expect(map.bySize.size).toBe(0);
    expect(map.resolutions).toEqual([]);
  });

  it('reads the summary from a real fixture', () => {
    const html = readFileSync(join(import.meta.dirname, 'fixtures', 'multi-quality.html'), 'utf8');
    const summary = /\[[^\]]*\d{3,4}p[^\]]*\]/.exec(html.replace(/&amp;/g, '&'));
    expect(summary).not.toBeNull();
    const map = resolutionBySizeFromSummary(summary?.[0] ?? '');
    expect(map.bySize.size).toBeGreaterThan(0);
  });
});
