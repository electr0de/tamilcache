import { describe, expect, it } from 'vitest';
import { searchHint } from '../src/search-query.js';

describe('searchHint', () => {
  it('uses the slug when it carries a year', () => {
    expect(searchHint('jailer-2-2026-tamil-true-web-dl-1080p', 'Jailer 2 (2026) Tamil')).toEqual({
      query: 'jailer 2',
      year: 2026,
    });
  });

  it('keeps the whole slug, dashes stripped, when it has no year', () => {
    expect(searchHint('some-film-tamil-webrip', 'Some Film (?)')).toEqual({
      query: 'some film tamil webrip',
      year: null,
    });
  });

  it('falls back to the header title when the slug is empty, keeping its casing', () => {
    expect(searchHint('', 'Kara (2026) Telugu HQ Clean')).toEqual({ query: 'Kara', year: 2026 });
  });

  it('reports null when neither source yields a query', () => {
    // A header that is nothing but tagging vocabulary strips to an empty query.
    expect(searchHint('', '1080p x264')).toEqual({ query: null, year: null });
  });
});
