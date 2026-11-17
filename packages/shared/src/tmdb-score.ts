export type MediaKind = 'movie' | 'tv';

export interface TmdbCandidate {
  id: number;
  mediaType: MediaKind;
  title: string;
  year: number | null;
  originalLanguage: string | null;
  popularity: number;
}

export interface ScoreContext {
  query: string;
  kind: MediaKind;
  year: number | null;
  /** Every year the slug mentions. A candidate matching any of them is not disqualified. */
  years?: number[] | undefined;
  /** Languages the site's own forum/audio tags suggest — a weak hint, never a filter. */
  languageHint?: string | null;
}

export interface ScoredCandidate extends TmdbCandidate {
  score: number;
  reasons: string[];
}

/** Accept at or above this. Below it the topic goes to the review queue with a proposal. */
export const ACCEPT_THRESHOLD = 70;

/** Two candidates closer than this are not separable: a human should look. */
const MARGIN = 10;

const REGIONAL = new Set(['ta', 'te', 'ml', 'kn', 'hi', 'bn', 'mr', 'pa']);

// An apostrophe is nothing, not a word break: `I'm` must normalise to `im`, the way the slug's
// `im` does. Leaving a space there loses the 60-point exact-title bonus to a 20-point "most words".
const APOSTROPHES = /['\u2018\u2019\u02bc]/g;

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripArticles(value: string): string {
  return value.replace(/^(the|a|an) /, '');
}

function titleScore(query: string, candidate: string): { score: number; reason: string | null } {
  const q = stripArticles(normalise(query));
  const c = stripArticles(normalise(candidate));
  if (!q || !c) return { score: 0, reason: null };

  if (q === c) return { score: 60, reason: 'title exact' };
  if (c.startsWith(q) || q.startsWith(c)) return { score: 40, reason: 'title prefix' };
  if (c.includes(q) || q.includes(c)) return { score: 30, reason: 'title contains' };

  const qWords = q.split(' ').filter((word) => word.length > 2);
  const cWords = new Set(c.split(' '));
  const shared = qWords.filter((word) => cWords.has(word)).length;
  if (shared === 0) return { score: 0, reason: null };

  const ratio = shared / Math.max(qWords.length, 1);
  if (ratio >= 0.6) return { score: 20, reason: 'most words' };
  if (ratio >= 0.4) return { score: 10, reason: 'some words' };
  return { score: 0, reason: null };
}

export function scoreCandidate(candidate: TmdbCandidate, context: ScoreContext): ScoredCandidate {
  const reasons: string[] = [];
  let score = 0;

  const title = titleScore(context.query, candidate.title);
  score += title.score;
  if (title.reason) reasons.push(title.reason);

  if (context.year !== null && candidate.year !== null) {
    const delta = Math.abs(context.year - candidate.year);
    if (delta === 0) {
      score += 25;
      reasons.push('year exact');
    } else if (delta === 1) {
      score += 10;
      reasons.push('year ±1');
    }
  }

  if (candidate.mediaType === context.kind) {
    score += 10;
    reasons.push('type');
  }

  if (candidate.originalLanguage && REGIONAL.has(candidate.originalLanguage)) {
    score += 5;
    reasons.push('regional language');
  }
  if (context.languageHint && candidate.originalLanguage === context.languageHint) {
    score += 5;
    reasons.push('language hint');
  }

  // Popularity only breaks ties. Log scale, capped, so a 180-popularity `CSI` cannot outrank an
  // exact regional match with popularity 4.
  score += Math.min(5, Math.round(Math.log10(Math.max(candidate.popularity, 1)) * 2));

  return { ...candidate, score, reasons };
}

/**
 * A candidate whose year is more than one off every year the slug named is rejected outright.
 *
 * Without this, an exact-title match on a different decade scores 60+10 (title + type) = 70 and
 * auto-accepts: "Scene" (2026) would bind to "Scene." (2006). One year of slack is allowed
 * because a film's festival date and its streaming date often straddle a new year.
 *
 * The slug, however, can name two years — `thiruchitrambalam-2022-2024-re-release-hindi-1080p` is
 * the 2022 film re-released in 2024. `context.year` is the *preferred* year (the last token), not
 * a fact, so a candidate matching any year the slug mentions is kept. Scoring still rewards the
 * preferred year alone: tolerance decides who is a candidate, not who wins.
 */
function yearTooFar(candidate: TmdbCandidate, context: ScoreContext): boolean {
  if (context.year === null || candidate.year === null) return false;
  const years = context.years && context.years.length > 0 ? context.years : [context.year];
  return years.every((year) => Math.abs(year - candidate.year!) > 1);
}

/**
 * Type is a hard constraint, not a +10 bonus. Without this, the movie query `jailer 2` (2026)
 * binds to the TV special "Jailer 2 - Rave" at exactly 70 (prefix 40 + year 25 + regional 5).
 */
function wrongType(candidate: TmdbCandidate, context: ScoreContext): boolean {
  return candidate.mediaType !== context.kind;
}

export function scoreCandidates(candidates: TmdbCandidate[], context: ScoreContext): ScoredCandidate[] {
  return candidates
    .filter((candidate) => !wrongType(candidate, context) && !yearTooFar(candidate, context))
    .map((candidate) => scoreCandidate(candidate, context))
    .sort((a, b) => b.score - a.score || b.popularity - a.popularity);
}

/**
 * Scores and sorts *without* dropping anything.
 *
 * `scoreCandidates` applies the auto-accept constraints: a wrong type or a year more than one off
 * is discarded outright. That is right for the unattended provider pass and wrong for a human
 * picker, where a bad year parsed out of the slug must never hide the film the reviewer is
 * looking for. Same scorer, no filter.
 */
export function rankCandidates(candidates: TmdbCandidate[], context: ScoreContext): ScoredCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(candidate, context))
    .sort((a, b) => b.score - a.score || b.popularity - a.popularity);
}

export type MatchOutcome =
  | { status: 'matched'; candidate: ScoredCandidate }
  | { status: 'ambiguous'; proposal: ScoredCandidate | null; runnerUp: ScoredCandidate | null }
  | { status: 'none' };

/**
 * Auto-accept needs a high score *and* a clear margin: two candidates within 10 points means the
 * title is genuinely ambiguous and a human should look, even when the leader scored well.
 */
export function decideMatch(candidates: TmdbCandidate[], context: ScoreContext): MatchOutcome {
  const scored = scoreCandidates(candidates, context);
  const best = scored[0] ?? null;
  const runnerUp = scored[1] ?? null;

  if (!best) return { status: 'none' };
  // A non-finite score is a defect (poisoned cache payload, missing popularity): treat it as
  // "no match" rather than letting both `NaN < 70` and `NaN - x < 10` evaluate false and
  // silently accept it.
  if (!Number.isFinite(best.score)) return { status: 'ambiguous', proposal: null, runnerUp: null };
  if (best.score < ACCEPT_THRESHOLD) return { status: 'ambiguous', proposal: best, runnerUp };
  if (runnerUp && !Number.isFinite(runnerUp.score - best.score)) return { status: 'ambiguous', proposal: best, runnerUp };
  if (runnerUp && best.score - runnerUp.score < 10) return { status: 'ambiguous', proposal: best, runnerUp };
  return { status: 'matched', candidate: best };
}

/**
 * Decides identity *and* kind from one `/search/multi` payload, for the case where the kind is a
 * hypothesis rather than a fact.
 *
 * `scoreCandidates` treats type as a hard constraint, so it can only run once the kind is known.
 * Scoring each namespace in its own context makes `wrongType` never fire and cancels the +10 type
 * bonus across the two groups, leaving title and year — exactly the evidence we have when the
 * kind is unknown. The surviving leader wins outright; two namespaces we cannot separate go to
 * review instead of being forced into `movie`, because a `tv` hint must be able to break a tie.
 */
export function decideMatchAcrossTypes(
  candidates: TmdbCandidate[],
  context: { query: string; year: number | null; years?: number[]; kindHint?: MediaKind | null },
): MatchOutcome {
  const group = (kind: MediaKind): ScoredCandidate[] =>
    rankCandidates(candidates.filter((candidate) => candidate.mediaType === kind), {
      query: context.query, kind, year: context.year, years: context.years,
    });

  const years = context.years && context.years.length > 0 ? context.years : context.year === null ? [] : [context.year];
  const bestOf = (list: ScoredCandidate[]): ScoredCandidate | null => {
    const top = list[0] ?? null;
    if (!top || !Number.isFinite(top.score)) return null;
    if (years.length > 0 && top.year !== null && years.every((year) => Math.abs(year - top.year!) > 1)) return null;
    return top;
  };

  const movieBest = bestOf(group('movie'));
  const showBest = bestOf(group('tv'));

  // A hinted namespace wins an exact tie instead of popularity deciding for us.
  const hint: MediaKind | null = context.kindHint ?? null;
  const ordered: Array<[ScoredCandidate | null, ScoredCandidate | null]> =
    hint === 'tv' ? [[showBest, movieBest], [movieBest, showBest]] : [[movieBest, showBest], [showBest, movieBest]];

  for (const [leader, rival] of ordered) {
    if (!leader || leader.score < ACCEPT_THRESHOLD) continue;
    // The challenger may live in the SAME namespace: two near-identical movies are still ambiguous,
    // and comparing only against the other namespace would auto-bind the luckier of the two.
    const withinKind = (leader.mediaType === 'movie' ? group('movie') : group('tv'))[1] ?? null;
    const challenger =
      [rival, withinKind]
        .filter((candidate): candidate is ScoredCandidate => candidate !== null)
        .sort((a, b) => b.score - a.score)[0] ?? null;
    // A challenger at all only means we can tell them apart when it is `MARGIN` worse.
    const gap = leader.score - (challenger ? challenger.score : -Infinity);
    // An exact tie is what the hint exists for: popularity is capped at 5 points, so two
    // namespaces with the same title, year and language are always within the margin and would
    // otherwise never match at all. The hint only loses when the challenger is clearly better,
    // and it must never break a SAME-namespace tie — two identical movies are still two films.
    if (gap >= MARGIN) return { status: 'matched', candidate: leader };
    const tieIsWithinKind = withinKind !== null && withinKind.mediaType === leader.mediaType;
    if (hint !== null && !tieIsWithinKind && leader.mediaType === hint && gap > -MARGIN) {
      return { status: 'matched', candidate: leader };
    }
    return { status: 'ambiguous', proposal: leader, runnerUp: challenger };
  }

  const proposal = movieBest && showBest ? (movieBest.score >= showBest.score ? movieBest : showBest) : (movieBest ?? showBest);
  return proposal ? { status: 'ambiguous', proposal, runnerUp: null } : { status: 'none' };
}
