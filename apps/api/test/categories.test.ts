import { describe, expect, it } from 'vitest';
import { parseCategories } from '../src/categories.js';

describe('parseCategories', () => {
  it('parses a single category', () => {
    expect(parseCategories('2040')).toEqual([{ from: 2040, to: 2040 }]);
  });

  it('parses the comma list Prowlarr sends', () => {
    expect(parseCategories('2040,5030')).toEqual([
      { from: 2040, to: 2040 },
      { from: 5030, to: 5030 },
    ]);
  });

  it('treats a parent category as its whole subtree', () => {
    expect(parseCategories('2000')).toEqual([{ from: 2000, to: 2999 }]);
    expect(parseCategories('5000')).toEqual([{ from: 5000, to: 5999 }]);
  });

  it('accepts a repeated parameter', () => {
    expect(parseCategories(['2040', '5030'])).toEqual([
      { from: 2040, to: 2040 },
      { from: 5030, to: 5030 },
    ]);
  });

  it('ignores junk and duplicates', () => {
    expect(parseCategories('2040,abc,2040,')).toEqual([{ from: 2040, to: 2040 }]);
  });

  it('returns null when nothing usable was requested', () => {
    expect(parseCategories(undefined)).toBeNull();
    expect(parseCategories('abc')).toBeNull();
  });
});
