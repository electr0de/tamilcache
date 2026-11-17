import { describe, expect, it } from 'vitest';
import { isKeptResolution, selectPreferred } from '../src/selection.js';

const GB = 1024 ** 3;

describe('isKeptResolution', () => {
  it.each(['1080p', '1440p', '2160p'])('keeps %s', (resolution) => {
    expect(isKeptResolution(resolution)).toBe(true);
  });

  it.each(['720p', '480p', '360p', null])('drops %s', (resolution) => {
    expect(isKeptResolution(resolution)).toBe(false);
  });
});

describe('selectPreferred', () => {
  it('keeps the largest 1080p encode', () => {
    const preferred = selectPreferred([
      { id: 1, resolution: '1080p', sizeBytes: 2 * GB },
      { id: 2, resolution: '1080p', sizeBytes: 3 * GB },
      { id: 3, resolution: '1080p', sizeBytes: 1 * GB },
    ]);
    expect([...preferred]).toEqual([2]);
  });

  it('keeps the smallest 4K encode', () => {
    const preferred = selectPreferred([
      { id: 1, resolution: '2160p', sizeBytes: 23 * GB },
      { id: 2, resolution: '2160p', sizeBytes: 9 * GB },
      { id: 3, resolution: '2160p', sizeBytes: 14 * GB },
    ]);
    expect([...preferred]).toEqual([2]);
  });

  it('keeps one preferred per resolution independently', () => {
    const preferred = selectPreferred([
      { id: 1, resolution: '1080p', sizeBytes: 2 * GB },
      { id: 2, resolution: '1080p', sizeBytes: 3 * GB },
      { id: 3, resolution: '2160p', sizeBytes: 23 * GB },
      { id: 4, resolution: '2160p', sizeBytes: 9 * GB },
    ]);
    expect([...preferred].sort()).toEqual([2, 4]);
  });

  it('ignores resolutions below 1080p entirely', () => {
    expect(selectPreferred([{ id: 1, resolution: '720p', sizeBytes: 900 * 1024 ** 2 }]).size).toBe(0);
  });

  it('ignores variants with no usable size', () => {
    expect(selectPreferred([{ id: 1, resolution: '1080p', sizeBytes: 0 }]).size).toBe(0);
  });

  it('treats 1440p like 1080p (largest wins)', () => {
    const preferred = selectPreferred([
      { id: 1, resolution: '1440p', sizeBytes: 5 * GB },
      { id: 2, resolution: '1440p', sizeBytes: 8 * GB },
    ]);
    expect([...preferred]).toEqual([2]);
  });

  it('is deterministic when sizes tie', () => {
    const rows = [
      { id: 1, resolution: '1080p', sizeBytes: 2 * GB },
      { id: 2, resolution: '1080p', sizeBytes: 2 * GB },
    ];
    expect([...selectPreferred(rows)]).toEqual([...selectPreferred(rows)]);
  });
});
