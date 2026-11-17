import { describe, expect, it } from 'vitest';
import { shouldUseFts, toFtsQuery } from '../src/search-text.js';

describe('toFtsQuery', () => {
  it('quotes terms and adds a prefix star', () => {
    expect(toFtsQuery('jailer 2')).toBe('"jailer"*');
  });

  it('neutralises FTS syntax so a query cannot error', () => {
    expect(toFtsQuery('a AND b')).toBe('"and"*');
    expect(toFtsQuery('"unterminated')).toBe('"unterminated"*');
    expect(toFtsQuery('foo-bar')).toBe('"foo"* "bar"*');
    expect(toFtsQuery('kara.2026')).toBe('"kara"* "2026"*');
  });

  it('returns null when nothing searchable is left', () => {
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('...')).toBeNull();
    expect(toFtsQuery('ab')).toBeNull();
  });
});

describe('shouldUseFts', () => {
  it('uses the index for words of three or more characters', () => {
    expect(shouldUseFts('jailer')).toBe(true);
  });

  it('falls back for short fragments', () => {
    expect(shouldUseFts('ja')).toBe(false);
  });
});
