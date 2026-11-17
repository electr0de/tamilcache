import { parseSeasonEpisode } from './episode-range.js';

export type Kind = 'movie' | 'show' | 'other';
export type KindConfidence = 'strong' | 'weak' | 'none';

export interface KindInput {
  slug: string;
  rawTitle: string;
  forumSlug?: string | null;
  recurrence?: { topics: number; days: number } | null;
}

export interface KindEvidence {
  kind: Kind | 'unknown';
  confidence: KindConfidence;
  reasons: string[];
}

const EP_ONLY = /(?:^|[-_. ])ep[-_. ]?\(?\d/i;
const DAY = /(?:^|[-_. ])day[-_. ]?\d/i;
const MOVIE_TOKEN = /(?:^|[-_. ])movie(?:[-_. ]|$)/i;
const OTHER_TOKEN = /trailer|teaser|(?:^|[-_. ])songs?(?![a-z])|soundtrack|(?:^|[-_. ])bgm|promo|audio[-_. ]?launch/i;

// A post titled by a calendar date (`…-14th-november-2025-…`) is a daily serial with no episode
// tag. Weak on its own: it must stay well under the 60 points an episode token carries.
const DATED = /(?:^|[-_. ])\d{1,2}(?:st|nd|rd|th)(?:[-_. ]|$)|(?:^|[-_. ])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_. ]?\d{1,2}(?:[-_. ]|$)/i;

// A release year with no episode tag is the weakest movie signal there is — never enough to
// outrank a real episode token, only enough to keep `unknown` from swallowing a plain film post.
const YEAR = /(?:^|[-_. ])(?:19|20)\d{2}(?:[-_. ]|$)/;

/**
 * Kind is a hypothesis, never a gate. `unknown` is a first-class answer: the provider ladder then
 * decides identity and kind together in one TMDB call.
 */
export function kindEvidence(input: KindInput): KindEvidence {
  const { slug, rawTitle, forumSlug, recurrence } = input;
  const text = `${slug} ${rawTitle}`;
  const reasons: string[] = [];

  if (OTHER_TOKEN.test(text)) return { kind: 'other', confidence: 'strong', reasons: ['trailer/songs marker'] };

  let show = 0;
  let movie = 0;

  if (parseSeasonEpisode(slug) !== null) { show += 60; reasons.push('episode token'); }
  if (EP_ONLY.test(slug) && !reasons.includes('episode token')) { show += 45; reasons.push('episode token'); }
  if (DAY.test(slug)) { show += 25; reasons.push('daily episode'); }
  if (DATED.test(slug)) { show += 25; reasons.push('dated post'); }
  if (recurrence && recurrence.topics >= 3 && recurrence.days >= 3) { show += 60; reasons.push('posted repeatedly'); }
  if (forumSlug === 'web-series-tv-shows') { show += 20; reasons.push('tv forum'); }
  if (MOVIE_TOKEN.test(text)) { movie += 25; reasons.push('movie marker'); }
  if (YEAR.test(slug)) { movie += 10; reasons.push('dated release'); }

  const top: Kind = show >= movie ? 'show' : 'movie';
  const topScore = Math.max(show, movie);
  const secondScore = Math.min(show, movie);
  if (topScore === 0) return { kind: 'unknown', confidence: 'none', reasons };

  const confidence: KindConfidence = topScore >= 60 && topScore - secondScore >= 40 ? 'strong' : 'weak';
  return { kind: top, confidence, reasons };
}
