import { describe, it, expect } from 'vitest';
import { qualityRank } from '../src/quality-rank.js';

describe('qualityRank', () => {
  it('ranks BluRay above WEB-DL above WEBRip at the same resolution', () => {
    expect(qualityRank('1080p', 'BluRay')).toBeGreaterThan(qualityRank('1080p', 'WEB-DL'));
    expect(qualityRank('1080p', 'WEB-DL')).toBeGreaterThan(qualityRank('1080p', 'WEBRip'));
  });

  it('ranks any 1080p above the same source at 720p', () => {
    expect(qualityRank('1080p', 'HDTS')).toBeGreaterThan(qualityRank('720p', 'HDTS'));
  });

  it('returns 0 for unknown inputs', () => {
    expect(qualityRank(null, null)).toBe(0);
    expect(qualityRank('1080p', 'NOT_A_TOKEN')).toBe(4000);
  });

  it('is deterministic', () => {
    expect(qualityRank('1080p', 'WEB-DL')).toBe(qualityRank('1080p', 'WEB-DL'));
  });
});
