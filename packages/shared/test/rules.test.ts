import { describe, expect, it } from 'vitest';
import { evaluatePredicate, ruleSchema } from '../src/rules.js';

const evidence = {
  forumId: 22,
  forumName: 'Telugu Language',
  slug: 'x-2026-telugu-hq-clean',
  rawTitle: 'X (2026) Telugu HQ Clean',
  poster: 'J.A.R.V.I.S.',
  sourceTagRaw: 'HQ HDRip',
  resolution: '720p',
  audioLangs: ['telugu'],
};

describe('ruleSchema', () => {
  it('accepts a combined predicate', () => {
    expect(ruleSchema.parse({ forumIds: [22, 23], titleMatches: 'hq clean', audioLangs: [] }).forumIds).toEqual([22, 23]);
  });

  it('rejects an invalid regex', () => {
    expect(() => ruleSchema.parse({ titleMatches: '(' })).toThrow(/regex/i);
  });

  it('accepts an empty predicate (matches everything)', () => {
    expect(ruleSchema.parse({})).toEqual({});
  });
});

describe('evaluatePredicate', () => {
  it('matches forum + title', () => {
    expect(evaluatePredicate({ forumIds: [22], titleMatches: 'hq clean' }, evidence)).toBe(true);
  });

  it('fails when the forum differs', () => {
    expect(evaluatePredicate({ forumIds: [64] }, evidence)).toBe(false);
  });

  it('treats audioLangs: [] as "no language tag", not "any"', () => {
    expect(evaluatePredicate({ audioLangs: [] }, evidence)).toBe(false);
    expect(evaluatePredicate({ audioLangs: [] }, { ...evidence, audioLangs: [] })).toBe(true);
  });

  it('requires overlap when audioLangs has values', () => {
    expect(evaluatePredicate({ audioLangs: ['tamil'] }, evidence)).toBe(false);
    expect(evaluatePredicate({ audioLangs: ['telugu', 'hindi'] }, evidence)).toBe(true);
  });

  it('matches posters case-insensitively by containment', () => {
    expect(evaluatePredicate({ posterMatches: 'j.a.r.v.i.s' }, evidence)).toBe(true);
    expect(evaluatePredicate({ posterMatches: 'J.A.R.V.I.S.' }, evidence)).toBe(true);
    expect(evaluatePredicate({ posterMatches: 'someone else' }, evidence)).toBe(false);
    expect(evaluatePredicate({ posterMatches: 'jarvis' }, evidence)).toBe(false);
  });

  it('supports source and resolution filters', () => {
    expect(evaluatePredicate({ sourceMatches: 'hdrip' }, evidence)).toBe(true);
    expect(evaluatePredicate({ resolutions: ['1080p'] }, evidence)).toBe(false);
    expect(evaluatePredicate({ resolutions: ['720p'] }, evidence)).toBe(true);
  });

  it('treats an empty forumIds array as "no forum filter"', () => {
    expect(evaluatePredicate({ forumIds: [] }, evidence)).toBe(true);
  });

  it('requires every specified condition (AND)', () => {
    expect(evaluatePredicate({ forumIds: [22], titleMatches: 'nope' }, evidence)).toBe(false);
  });
});
