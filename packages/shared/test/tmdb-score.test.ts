import { describe, expect, it } from 'vitest';
import { ACCEPT_THRESHOLD, decideMatch, decideMatchAcrossTypes, rankCandidates, scoreCandidates, type TmdbCandidate } from '../src/tmdb-score.js';
import { queryFromSlug, queryFromTitle, yearsInSlug } from '../src/search-query.js';

const candidate = (over: Partial<TmdbCandidate> = {}): TmdbCandidate => ({
  id: 1,
  mediaType: 'movie',
  title: 'Untitled',
  year: 2026,
  originalLanguage: 'en',
  popularity: 5,
  ...over,
});

describe('queryFromSlug', () => {
  it('splits the searchable title and year from real slugs', () => {
    expect(queryFromSlug('panthadikkaam-2026-s01-ep-01-05-true-web-dl-1080p-720p-avc-dd51-192kbps-18gb')).toEqual({
      query: 'panthadikkaam',
      year: 2026,
    });
    expect(queryFromSlug('a-minecraft-movie-2025-hindi-hdtc-1080p-720p-x264-2gb-1gb-400mb-hq-clean-audio')).toEqual({
      query: 'a minecraft movie',
      year: 2025,
    });
    expect(queryFromSlug('jailer-2-2026-tamil-true-web-dl-1080p')).toEqual({ query: 'jailer 2', year: 2026 });
  });

  it('returns the whole slug when there is no year', () => {
    expect(queryFromSlug('some-film-tamil-webrip')).toEqual({ query: 'some film tamil webrip', year: null });
  });

  // The year inside a title is not the release year. Taking the first year put `2009`
  // into the search, which `yearTooFar()` then used to discard the correct film.
  it('takes the last year, so a year in the title does not win', () => {
    expect(
      queryFromSlug('im-handsome-since-2009-2026-telugu-true-web-dl-1080p-720p-avc-dd51-640kbps-4gb'),
    ).toEqual({ query: 'im handsome since 2009', year: 2026 });
  });

  it('does not claim a year when there is no title before it', () => {
    expect(queryFromSlug('1920-2008-hindi-dvdrip-720p')).toEqual({ query: '1920', year: null });
  });

  it('searches a film that is named after a year without claiming that year', () => {
    expect(queryFromSlug('1917-hindi-dubbed-1080p')).toEqual({ query: '1917', year: null });
  });

  it('reports every year so the scorer can tolerate an ambiguous slug', () => {
    expect(yearsInSlug('thiruchitrambalam-2022-2024-re-release-hindi-1080p')).toEqual([2022, 2024]);
    expect(yearsInSlug('jailer-2-2026-tamil')).toEqual([2026]);
    expect(yearsInSlug('some-film-tamil-webrip')).toEqual([]);
  });

  // The title is everything before the *preferred* year, so `2022` stays in the query; only the
  // year the slug prefers moved. Dropping `2022` would mean slicing at the first year, which puts
  // `im-handsome-since-2009-2026-…` back to the `im handsome since` query round 1 fixed.
  it('prefers the last year but keeps the earlier one available', () => {
    expect(queryFromSlug('thiruchitrambalam-2022-2024-re-release-hindi-1080p')).toEqual({
      query: 'thiruchitrambalam 2022',
      year: 2024,
    });
  });

  it('still finds a year that is the only one', () => {
    expect(queryFromSlug('sardar-2-2026-tamil-v2-hq-predvd-1080p')).toEqual({ query: 'sardar 2', year: 2026 });
  });
});

describe('queryFromTitle', () => {
  it('strips tagging vocabulary from a block header', () => {
    const result = queryFromTitle('Panthadikkaam (2026) S01 EP (01-05) Malayalam TRUE WEB-DL');
    expect(result.year).toBe(2026);
    expect(result.query.toLowerCase()).not.toContain('malayalam');
    expect(result.query.toLowerCase()).not.toContain('web');
    expect(result.query.toLowerCase()).toContain('panthadikkaam');
  });

  it('keeps apostrophes out of the search terms', () => {
    expect(queryFromTitle("I'm Handsome (Since 2009) (2026) Telugu")).toEqual({
      query: 'Im Handsome Since 2009',
      year: 2026,
    });
  });
});

describe('scoreCandidates', () => {
  const jailer2 = candidate({ id: 1234139, title: 'Jailer 2', year: 2026, originalLanguage: 'ta', popularity: 26 });
  const rave = candidate({ id: 337401, mediaType: 'tv', title: 'Jailer 2 - Rave', year: 2026, originalLanguage: 'ta', popularity: 1 });

  it('ranks the movie above the tv specials for a movie query', () => {
    const [top] = scoreCandidates([rave, jailer2], { query: 'jailer 2', kind: 'movie', year: 2026 });
    expect(top?.id).toBe(1234139);
  });

  it('rewards an exact title and year', () => {
    const [top] = scoreCandidates([jailer2], { query: 'jailer 2', kind: 'movie', year: 2026 });
    expect(top?.reasons).toEqual(expect.arrayContaining(['title exact', 'year exact', 'type']));
    expect(top?.score).toBeGreaterThanOrEqual(ACCEPT_THRESHOLD);
  });

  it('does not let a popular but unrelated title win on popularity alone', () => {
    const csi = candidate({ id: 1431, mediaType: 'tv', title: 'CSI: Crime Scene Investigation', year: 2000, originalLanguage: 'en', popularity: 180 });
    const scene = candidate({ id: 1402181, title: 'Scene', year: 2026, originalLanguage: 'ta', popularity: 41 });
    const [top] = scoreCandidates([csi, scene], { query: 'scene', kind: 'movie', year: 2026 });
    expect(top?.id).toBe(1402181);
  });
});

describe('normalise apostrophes', () => {
  // `I'm Handsome` → `i m handsome` did not match the slug's `im handsome`, which cost the
  // 60-point exact-title bonus and left the row at 35.
  it('treats an apostrophe as nothing, so `im` matches `I\'m`', () => {
    const [best] = scoreCandidates(
      [{ id: 1, mediaType: 'movie', title: "I'm Handsome (Since 2009)", year: 2026, originalLanguage: 'te', popularity: 1 }],
      { query: 'im handsome since 2009', kind: 'movie', year: 2026 },
    );
    expect(best?.reasons).toContain('title exact');
    expect(best?.score).toBeGreaterThanOrEqual(95);
  });
});

describe('decideMatch', () => {
  it('accepts a clear, high-scoring match', () => {
    const outcome = decideMatch(
      [candidate({ id: 1, title: 'Jailer 2', year: 2026, originalLanguage: 'ta', popularity: 26 })],
      { query: 'jailer 2', kind: 'movie', year: 2026 },
    );
    expect(outcome.status).toBe('matched');
  });

  it('accepts the Ramayana case: prefix title + year + regional language lands exactly on the threshold', () => {
    const outcome = decideMatch(
      [candidate({ id: 656908, title: 'Ramayana: Rise of a Legend', year: 2026, originalLanguage: 'hi', popularity: 154 })],
      { query: 'ramayana', kind: 'movie', year: 2026 },
    );
    expect(outcome.status).toBe('matched');
    if (outcome.status === 'matched') expect(outcome.candidate.originalLanguage).toBe('hi');
  });

  it('refuses to bind a generic title to an exact-title match from another decade', () => {
    const outcome = decideMatch(
      [
        candidate({ id: 1431, mediaType: 'tv', title: 'CSI: Crime Scene Investigation', year: 2000, popularity: 180 }),
        candidate({ id: 1595292, title: 'Scene.', year: 2006, popularity: 1 }),
      ],
      { query: 'scene', kind: 'movie', year: 2026 },
    );
    // Both are more than a year off, so they are not even candidates.
    expect(outcome.status).toBe('none');
  });

  it('does not disqualify a candidate whose year is another year named in the slug', () => {
    const outcome = decideMatch(
      [{ id: 1, mediaType: 'movie', title: 'Thiruchitrambalam', year: 2022, originalLanguage: 'ta', popularity: 5 }],
      { query: 'thiruchitrambalam', kind: 'movie', year: 2024, years: [2022, 2024] },
    );
    expect(outcome.status).toBe('matched');
  });

  it('still rejects a film whose year matches nothing in the slug', () => {
    const outcome = decideMatch(
      [{ id: 1, mediaType: 'movie', title: 'Scene', year: 2006, originalLanguage: 'en', popularity: 5 }],
      { query: 'scene', kind: 'movie', year: 2026, years: [2026] },
    );
    expect(outcome.status).not.toBe('matched');
  });

  it('calls two near-identical candidates ambiguous even when the leader scores well', () => {
    const a = candidate({ id: 1, title: 'Kara', year: 2026, originalLanguage: 'ta', popularity: 3 });
    const b = candidate({ id: 2, title: 'Kara', year: 2026, originalLanguage: 'kn', popularity: 2 });
    expect(decideMatch([a, b], { query: 'kara', kind: 'movie', year: 2026 }).status).toBe('ambiguous');
  });

  it('reports none for no candidates', () => {
    expect(decideMatch([], { query: 'nothing', kind: 'movie', year: 2026 }).status).toBe('none');
  });

  it('tolerates a one-year release gap (festival vs streaming date)', () => {
    const outcome = decideMatch([candidate({ id: 3, title: 'Kara', year: 2025, originalLanguage: 'ta' })], {
      query: 'kara',
      kind: 'movie',
      year: 2026,
    });
    // 60 exact + 10 year±1 + 10 type + 5 regional = 85: a single year of slack still binds.
    expect(outcome.status).toBe('matched');
  });
});

describe('type is a hard constraint', () => {
  it('rejects a TV special for a movie query even at the threshold score', () => {
    // prefix 40 + year 25 + regional 5 = 70 for a TV candidate against a movie query.
    const tvSpecial = { id: 2, mediaType: 'tv' as const, title: 'Jailer 2 - Rave', year: 2026, originalLanguage: 'ta', popularity: 1 };
    const outcome = decideMatch([tvSpecial], { query: 'jailer 2', kind: 'movie', year: 2026 });
    expect(outcome.status).toBe('none');
  });

  it('keeps the right type', () => {
    const show = { id: 3, mediaType: 'tv' as const, title: 'Panthadikkaam', year: 2026, originalLanguage: 'ml', popularity: 1 };
    expect(decideMatch([show], { query: 'panthadikkaam', kind: 'tv', year: 2026 }).status).toBe('matched');
  });
});

describe('rankCandidates (human picker)', () => {
  const context = { query: 'kara', kind: 'movie' as const, year: 2026 };
  const kara = candidate({ id: 1, title: 'Kara', year: 2026, originalLanguage: 'ta', popularity: 3 });
  const far = candidate({ id: 2, title: 'Kara', year: 2006, originalLanguage: 'ta', popularity: 2 });
  const show = candidate({ id: 3, mediaType: 'tv', title: 'Kara', year: 2025, originalLanguage: 'ta', popularity: 1 });

  it('sorts by score, highest first', () => {
    expect(rankCandidates([show, kara], context).map((c) => c.id)).toEqual([1, 3]);
  });

  it('keeps a candidate from another decade that scoreCandidates would drop', () => {
    expect(scoreCandidates([far], context)).toEqual([]);
    expect(rankCandidates([far], context).map((c) => c.id)).toEqual([2]);
  });

  it('keeps a candidate of the wrong type that scoreCandidates would drop', () => {
    expect(scoreCandidates([show], { ...context, year: 2026 })).toEqual([]);
    expect(rankCandidates([show], { ...context, year: 2026 }).map((c) => c.id)).toEqual([3]);
  });

  it('still carries the score and reasons', () => {
    const [top] = rankCandidates([kara], context);
    expect(top?.score).toBeGreaterThan(0);
    expect(top?.reasons).toEqual(expect.arrayContaining(['title exact', 'year exact']));
  });

  it('returns an empty list for no candidates', () => {
    expect(rankCandidates([], context)).toEqual([]);
  });
});

describe('non-finite scores never match', () => {
  it('parks a candidate whose score is NaN', () => {
    const poisoned = { id: 9, mediaType: 'movie' as const, title: 'Kara', year: 2026, originalLanguage: 'ta', popularity: Number.NaN };
    const outcome = decideMatch([poisoned], { query: 'kara', kind: 'movie', year: 2026 });
    expect(outcome.status).not.toBe('matched');
  });
});

const movieC = (over: Partial<TmdbCandidate> = {}): TmdbCandidate => ({ id: 1, mediaType: 'movie', title: 'Jailer 2', year: 2026, originalLanguage: 'ta', popularity: 5, ...over });
const showC  = (over: Partial<TmdbCandidate> = {}): TmdbCandidate => ({ id: 2, mediaType: 'tv',    title: 'Jailer 2', year: 2026, originalLanguage: 'ta', popularity: 5, ...over });

describe('decideMatchAcrossTypes', () => {
  it('decides identity and kind together when one namespace clearly wins', () => {
    expect(decideMatchAcrossTypes([showC(), movieC({ popularity: 1 })], { query: 'jailer 2', year: 2026, kindHint: 'tv' }))
      .toMatchObject({ status: 'matched', candidate: { mediaType: 'tv' } });
  });
  it('refuses when the two namespaces are within the margin', () => {
    expect(decideMatchAcrossTypes([movieC(), showC()], { query: 'jailer 2', year: 2026 }).status).toBe('ambiguous');
  });
  it('still applies the year rule', () => {
    expect(decideMatchAcrossTypes([movieC({ year: 2006 })], { query: 'scene', year: 2026 }).status).toBe('none');
  });
  it('tolerates a candidate with no date', () => {
    // The title has to match for this to test the date rule at all: an unknown year must not be
    // read as a wrong year, exactly as `yearTooFar()` treats it.
    expect(decideMatchAcrossTypes([movieC({ year: null, title: 'Some Regional Film' })], { query: 'some regional film', year: 2026 }))
      .toMatchObject({ status: 'matched' });
  });
  it('prefers the hinted namespace on an exact tie', () => {
    expect(decideMatchAcrossTypes([movieC(), showC()], { query: 'jailer 2', year: 2026, kindHint: 'movie' }))
      .toMatchObject({ status: 'matched', candidate: { mediaType: 'movie' } });
  });
  it('tolerates every year the slug named', () => {
    expect(decideMatchAcrossTypes([movieC({ title: 'Thiruchitrambalam', year: 2022 })], { query: 'thiruchitrambalam', year: 2024, years: [2022, 2024] }))
      .toMatchObject({ status: 'matched' });
  });
});
