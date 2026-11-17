import { z } from 'zod';

export interface RuleEvidence {
  forumId: number;
  forumName: string;
  slug: string;
  rawTitle: string;
  poster: string | null;
  sourceTagRaw: string;
  resolution: string | null;
  /** Languages named by this block's own header line. */
  audioLangs: string[];
  /**
   * Languages named by the topic-level places (title, labelled prose). Optional so a rule or a
   * caller can describe a block without re-stating the topic; absent means "no topic evidence".
   */
  topicAudioLangs?: string[];
  /**
   * How many distinct places named audio languages (0..3). Optional for the same reason, and
   * because rows written before schema v6 carry 0: `classify()` reads a missing/zero count with
   * a non-empty language list as a single place, which is exactly the pre-v6 rule.
   */
  audioSourceCount?: number;
}

const regexString = z
  .string()
  .refine(
    (value) => {
      try {
        new RegExp(value, 'i');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'invalid regex' },
  );

export const ruleSchema = z.object({
  forumIds: z.array(z.number().int()).optional(),
  titleMatches: regexString.optional(),
  slugMatches: regexString.optional(),
  posterMatches: z.string().optional(),
  sourceMatches: regexString.optional(),
  resolutions: z.array(z.string()).optional(),
  audioLangs: z.array(z.string()).optional(),
});

export type RulePredicate = z.infer<typeof ruleSchema>;

const isEmpty = (value: unknown[] | undefined): boolean => value === undefined || value.length === 0;

/**
 * All specified conditions must hold (AND). An empty array means "must be empty", not "any":
 * `audioLangs: []` is how a rule targets releases whose audio language is unstated —
 * the single most common review-queue reason.
 */
export function evaluatePredicate(predicate: RulePredicate, evidence: RuleEvidence): boolean {
  if (!isEmpty(predicate.forumIds) && !predicate.forumIds?.includes(evidence.forumId)) return false;
  if (predicate.titleMatches && !new RegExp(predicate.titleMatches, 'i').test(evidence.rawTitle)) return false;
  if (predicate.slugMatches && !new RegExp(predicate.slugMatches, 'i').test(evidence.slug)) return false;
  // Containment, not equality: posters are named "J.A.R.V.I.S." / "S.P.I.D.E.R" and a rule
  // should be teachable as "this uploader's poster", not as an exact filename.
  if (predicate.posterMatches && !(evidence.poster ?? '').toLowerCase().includes(predicate.posterMatches.toLowerCase())) {
    return false;
  }
  if (predicate.sourceMatches && !new RegExp(predicate.sourceMatches, 'i').test(evidence.sourceTagRaw)) {
    return false;
  }
  if (!isEmpty(predicate.resolutions)) {
    if (!evidence.resolution || !predicate.resolutions?.includes(evidence.resolution)) return false;
  }
  if (predicate.audioLangs !== undefined) {
    if (predicate.audioLangs.length === 0) {
      if (evidence.audioLangs.length > 0) return false;
    } else if (!predicate.audioLangs.some((lang) => evidence.audioLangs.includes(lang))) {
      return false;
    }
  }
  return true;
}
