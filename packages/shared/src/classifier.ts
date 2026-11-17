import { createHash } from 'node:crypto';
import { evaluatePredicate, type RuleEvidence, type RulePredicate } from './rules.js';

export type Decision = 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | 'unknown';
export type DecisionSource = 'override' | 'rule' | 'provider' | 'auto' | 'human';
export type ReviewReason =
  | 'NO_AUDIO_TAG'
  | 'NO_PROVIDER_MATCH'
  | 'AMBIGUOUS_TITLE'
  | 'UNKNOWN_SOURCE';

export interface RuleRow {
  /** Absent only for a caller that evaluates a rule it never stored (e.g. a dry-run preview). */
  id?: number;
  action: 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | 'ignore';
  predicate: RulePredicate;
}

export interface ClassifyInput {
  /** Already ordered by priority ascending. */
  ruleSet: RuleRow[];
  override?: 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | null;
  /** TMDB `original_language` for the matched title, e.g. `'hi'`. */
  providerOriginalLanguage?: string | null;
}

export interface Classification {
  decision: Decision;
  source: DecisionSource | null;
  confidence: number;
  reviewReason: ReviewReason | null;
  /** The rule that decided the row, so a caller can count its hits. Null when no rule fired. */
  ruleId: number | null;
}

/**
 * Pure and ordered: override → rules → provider → auto → unknown.
 *
 * No network, no clock, no DB access, so `replay()` can re-run it over the whole table
 * idempotently and it is trivially unit-testable.
 */
export function classify(evidence: RuleEvidence, input: ClassifyInput): Classification {
  if (input.override) {
    return { decision: input.override, source: 'override', confidence: 1, reviewReason: null, ruleId: null };
  }

  for (const rule of input.ruleSet) {
    if (!evaluatePredicate(rule.predicate, evidence)) continue;
    const ruleId = rule.id ?? null;
    if (rule.action === 'ignore') {
      return { decision: 'not_hindi', source: 'rule', confidence: 0.9, reviewReason: null, ruleId };
    }
    return { decision: rule.action, source: 'rule', confidence: 0.9, reviewReason: null, ruleId };
  }

  const original = input.providerOriginalLanguage?.toLowerCase() ?? null;
  // Every place on the page that named languages: the block header (per block) plus the title
  // and labelled prose (topic-level). A `hindi` anywhere in here is positive evidence and wins.
  const named = [...new Set([...evidence.audioLangs, ...(evidence.topicAudioLangs ?? [])])];
  const places =
    evidence.audioSourceCount && evidence.audioSourceCount > 0
      ? evidence.audioSourceCount
      : named.length > 0
        ? 1
        : 0;
  const hasHindi = named.includes('hindi');

  // A Hindi-original film is Hindi regardless of how it was tagged, so the provider beats
  // the "is hindi among the audio languages" heuristic.
  if (original === 'hi') {
    return { decision: 'hindi_original', source: 'provider', confidence: 0.95, reviewReason: null, ruleId: null };
  }

  if (hasHindi) {
    return { decision: 'hindi_dubbed', source: 'auto', confidence: 0.85, reviewReason: null, ruleId: null };
  }

  // "Sure it is not Hindi" needs either two places agreeing (title + header, header + prose) or
  // one place plus a third-party answer about the film. One place alone is a single uploader's
  // word, so it stays in the review queue where a click costs nothing.
  if (named.length > 0 && (places >= 2 || original)) {
    return { decision: 'not_hindi', source: 'auto', confidence: places >= 2 ? 0.9 : 0.85, reviewReason: null, ruleId: null };
  }

  const reviewReason: ReviewReason = named.length === 0 ? 'NO_AUDIO_TAG' : 'NO_PROVIDER_MATCH';

  return { decision: 'unknown', source: null, confidence: 0, reviewReason, ruleId: null };
}

/**
 * Stable hash of the evidence a human decision was made on. Key order and language order are
 * normalised so re-crawls of the same topic keep pointing at the same override.
 */
export function evidenceHash(evidence: RuleEvidence): string {
  const canonical = JSON.stringify({
    forumId: evidence.forumId,
    slug: evidence.slug,
    audioLangs: [...evidence.audioLangs].sort(),
    resolution: evidence.resolution,
    poster: evidence.poster,
  });
  return createHash('sha1').update(canonical).digest('hex');
}
