export interface SeasonEpisode {
  season: number;
  epFrom: number;
  epTo: number;
  isPack: boolean;
}

const SEASON = /(?:^|[-_. ])(?:s(\d{1,3})|season[-_. ]?(\d{1,3}))(?=[-_. ]|e\d|ep\d|$)/i;
// a range end is always followed by a separator or end-of-string; rejecting a trailing
// letter stops `720p` and `450mb` from being read as episode numbers
const RANGE = /(?:ep|episode|e)[-_. ]?\(?(\d{1,3})\)?(?:[-_.]|[-_. ]*to[-_. ]*)(\d{1,3})(?![0-9a-z])/i;
const SINGLE = /(?:ep|episode|e)[-_. ]?\(?(\d{1,3})\)?(?![0-9])/i;

/**
 * Reads season/episode information out of a topic slug (`…-s01-ep-01-05-…`).
 *
 * Returns null when the slug carries no season at all (a movie). A season with no
 * episode number resolves to episode 1 so downstream code always has a usable range;
 * a range whose ends are equal is a single episode, not a one-episode pack.
 */
export function parseSeasonEpisode(input: string): SeasonEpisode | null {
  const s = SEASON.exec(input);
  const seasonRaw = s?.[1] ?? s?.[2];
  if (!seasonRaw) return null;
  const season = Number(seasonRaw);

  const range = RANGE.exec(input);
  if (range?.[1] && range[2]) {
    const epFrom = Number(range[1]);
    const epTo = Number(range[2]);
    if (epFrom > 0 && epTo >= epFrom) {
      return { season, epFrom, epTo, isPack: epTo > epFrom };
    }
  }
  const single = SINGLE.exec(input);
  if (single?.[1]) {
    const ep = Number(single[1]);
    if (ep > 0) return { season, epFrom: ep, epTo: ep, isPack: false };
  }
  return { season, epFrom: 1, epTo: 1, isPack: false };
}
