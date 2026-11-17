import { describe, expect, it } from 'vitest';
import { classify, evidenceHash } from '../src/classifier.js';

const evidence = {
  forumId: 22,
  forumName: 'Telugu',
  slug: 'x-2026-telugu-hq-clean',
  rawTitle: 'X (2026) Telugu HQ Clean',
  poster: null,
  sourceTagRaw: 'HQ HDRip',
  resolution: '720p',
  audioLangs: [] as string[],
};

describe('classify precedence', () => {
  it('override beats everything', () => {
    const result = classify(evidence, {
      ruleSet: [{ action: 'not_hindi', predicate: {} }],
      override: 'hindi_dubbed',
      providerOriginalLanguage: 'te',
    });
    expect(result).toMatchObject({ decision: 'hindi_dubbed', source: 'override', confidence: 1 });
  });

  it('a rule beats the provider', () => {
    const result = classify(evidence, {
      ruleSet: [{ action: 'hindi_dubbed', predicate: {} }],
      providerOriginalLanguage: 'te',
    });
    expect(result).toMatchObject({ decision: 'hindi_dubbed', source: 'rule' });
  });

  it('rules are evaluated in order, first match wins', () => {
    const result = classify(evidence, {
      ruleSet: [
        { action: 'not_hindi', predicate: { forumIds: [99] } },
        { action: 'hindi_original', predicate: { forumIds: [22] } },
        { action: 'not_hindi', predicate: {} },
      ],
    });
    expect(result.decision).toBe('hindi_original');
  });

  it('provider hindi ⇒ hindi_original when no rule matches', () => {
    const result = classify(evidence, { ruleSet: [], providerOriginalLanguage: 'hi' });
    expect(result).toMatchObject({ decision: 'hindi_original', source: 'provider', confidence: 0.95 });
  });

  it('hindi audio token ⇒ hindi_dubbed', () => {
    const result = classify({ ...evidence, audioLangs: ['hindi', 'telugu'] }, { ruleSet: [] });
    expect(result).toMatchObject({ decision: 'hindi_dubbed', source: 'auto' });
  });

  it('non-hindi audio with a non-hindi provider ⇒ not_hindi', () => {
    const result = classify({ ...evidence, audioLangs: ['telugu'] }, { ruleSet: [], providerOriginalLanguage: 'te' });
    expect(result).toMatchObject({ decision: 'not_hindi', source: 'auto' });
  });

  it('hindi audio on a Hindi-original film ⇒ hindi_original', () => {
    const result = classify({ ...evidence, audioLangs: ['hindi'] }, { ruleSet: [], providerOriginalLanguage: 'hi' });
    expect(result.decision).toBe('hindi_original');
  });

  it('no audio tag and no provider ⇒ unknown with NO_AUDIO_TAG', () => {
    const result = classify(evidence, { ruleSet: [] });
    expect(result).toMatchObject({ decision: 'unknown', reviewReason: 'NO_AUDIO_TAG', source: null });
  });

  it('audio tag but no provider ⇒ NO_PROVIDER_MATCH', () => {
    const result = classify({ ...evidence, audioLangs: ['tamil'] }, { ruleSet: [] });
    expect(result).toMatchObject({ decision: 'unknown', reviewReason: 'NO_PROVIDER_MATCH' });
  });

  it('an ignore rule maps to not_hindi with source rule', () => {
    const result = classify(evidence, { ruleSet: [{ action: 'ignore', predicate: {} }] });
    expect(result).toMatchObject({ decision: 'not_hindi', source: 'rule' });
  });
});

/**
 * `audioLangs` is what the block header said; `topicAudioLangs` is what the title and the post
 * prose said. Two agreeing places (or one place plus a third party) is what makes "not Hindi"
 * safe to conclude without a human.
 */
describe('evidence agreement', () => {
  const base = { ...evidence, sourceTagRaw: 'TRUE WEB-DL' };

  it('two places naming no Hindi decide not_hindi without a provider', () => {
    const result = classify(
      { ...base, audioLangs: ['tamil'], topicAudioLangs: ['tamil'], audioSourceCount: 2 },
      { ruleSet: [] },
    );
    expect(result).toMatchObject({ decision: 'not_hindi', source: 'auto' });
  });

  it('one place naming no Hindi stays ambiguous', () => {
    const result = classify({ ...base, audioLangs: ['tamil'], audioSourceCount: 1 }, { ruleSet: [] });
    expect(result).toMatchObject({ decision: 'unknown', reviewReason: 'NO_PROVIDER_MATCH' });
  });

  it('one place plus a non-Hindi provider decides not_hindi', () => {
    const result = classify(
      { ...base, audioLangs: ['tamil'], audioSourceCount: 1 },
      { ruleSet: [], providerOriginalLanguage: 'ta' },
    );
    expect(result.decision).toBe('not_hindi');
  });

  it('Hindi in the topic title wins over agreement everywhere else', () => {
    const result = classify(
      { ...base, audioLangs: ['tamil'], topicAudioLangs: ['tamil', 'hindi'], audioSourceCount: 2 },
      { ruleSet: [] },
    );
    expect(result).toMatchObject({ decision: 'hindi_dubbed', source: 'auto' });
  });

  it('a legacy row with no stored count keeps the pre-v6 single-place rule', () => {
    expect(classify({ ...base, audioLangs: ['tamil'] }, { ruleSet: [] })).toMatchObject({
      decision: 'unknown',
      reviewReason: 'NO_PROVIDER_MATCH',
    });
    expect(
      classify({ ...base, audioLangs: ['tamil'] }, { ruleSet: [], providerOriginalLanguage: 'ta' }).decision,
    ).toBe('not_hindi');
  });

  it('a stored count of 0 with languages present is read as one place', () => {
    const result = classify(
      { ...base, audioLangs: ['tamil'], audioSourceCount: 0 },
      { ruleSet: [], providerOriginalLanguage: 'ta' },
    );
    expect(result.decision).toBe('not_hindi');
    expect(classify({ ...base, audioLangs: ['tamil'], audioSourceCount: 0 }, { ruleSet: [] }).reviewReason).toBe(
      'NO_PROVIDER_MATCH',
    );
  });

  it('provider Hindi still wins over agreement', () => {
    const result = classify(
      { ...base, audioLangs: ['tamil'], audioSourceCount: 2 },
      { ruleSet: [], providerOriginalLanguage: 'hi' },
    );
    expect(result.decision).toBe('hindi_original');
  });

  it('no place naming anything stays NO_AUDIO_TAG even with a provider match', () => {
    const result = classify({ ...base, audioSourceCount: 0 }, { ruleSet: [], providerOriginalLanguage: 'te' });
    expect(result).toMatchObject({ decision: 'unknown', reviewReason: 'NO_AUDIO_TAG' });
  });
});

describe('evidenceHash', () => {
  it('is stable across key order', () => {
    const first = { forumId: 7, forumName: 'x', slug: 's', rawTitle: 'r', poster: null, sourceTagRaw: 't', resolution: null, audioLangs: [] };
    const reordered = { audioLangs: [], resolution: null, sourceTagRaw: 't', poster: null, rawTitle: 'r', slug: 's', forumName: 'x', forumId: 7 };
    expect(evidenceHash(first)).toBe(evidenceHash(reordered));
  });

  it('is stable across audio language order', () => {
    expect(evidenceHash({ ...evidence, audioLangs: ['tamil', 'hindi'] })).toBe(
      evidenceHash({ ...evidence, audioLangs: ['hindi', 'tamil'] }),
    );
  });

  it('differs when the audio language set changes', () => {
    expect(evidenceHash(evidence)).not.toBe(evidenceHash({ ...evidence, audioLangs: ['hindi'] }));
  });
});

describe('rule attribution', () => {
  it('reports which rule decided the row', () => {
    const evidence = {
      forumId: 3,
      forumName: 'web-hd-itunes-hd-bluray',
      slug: 'x',
      rawTitle: 'A Film (2026) Tamil TRUE WEB-DL',
      poster: null,
      sourceTagRaw: 'WEB-DL',
      resolution: '1080p',
      audioLangs: ['tamil'],
      topicAudioLangs: ['tamil'],
      audioSourceCount: 2,
    };
    const result = classify(evidence, {
      ruleSet: [{ id: 5, action: 'hindi_original', predicate: { forumIds: [3] } }],
    });
    expect(result.ruleId).toBe(5);
    expect(result.decision).toBe('hindi_original');
  });

  it('reports no rule when the language evidence decides', () => {
    const evidence = {
      forumId: 3,
      forumName: 'web-hd-itunes-hd-bluray',
      slug: 'x',
      rawTitle: 'A Film (2026)',
      poster: null,
      sourceTagRaw: 'WEB-DL',
      resolution: '1080p',
      audioLangs: ['tamil', 'hindi'],
      topicAudioLangs: [],
      audioSourceCount: 1,
    };
    const result = classify(evidence, { ruleSet: [] });
    expect(result.ruleId).toBeNull();
    expect(result.decision).toBe('hindi_dubbed');
  });
});
