import { describe, it, expect } from 'vitest';
import { imdbIdDigits, normaliseImdbId } from '../src/imdb-id.js';

describe('normaliseImdbId', () => {
  it.each([
    ['tt6478412', 'tt6478412'],
    ['6478412', 'tt6478412'],
    ['  TT6478412 ', 'tt6478412'],
    ['tt1234567', 'tt1234567'],
    ['0', null],
    ['tt', null],
    ['garbage', null],
    ['', null],
    [null, null],
  ])('normalises %s → %s', (input, expected) => {
    expect(normaliseImdbId(input)).toBe(expected);
  });
});

describe('imdbIdDigits', () => {
  // Sonarr and Radarr both `int.TryParse` the torznab `imdb` attribute and rebuild
  // `tt{id:D7}` themselves — emitting `tt6478412` makes it parse to 0.
  it('emits the bare integer the clients expect', () => {
    expect(imdbIdDigits('tt6478412')).toBe(6478412);
    expect(imdbIdDigits(null)).toBeNull();
  });
});
