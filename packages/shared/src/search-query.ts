export interface SearchQuery {
  query: string;
  year: number | null;
}

const YEAR_TOKEN = /(?<=^|-)((?:19|20)\d{2})(?=-|$)/g;

/** Every standalone 4-digit year in a slug, in order. The release year is ambiguous when there is more than one. */
export function yearsInSlug(slug: string): number[] {
  return [...slug.matchAll(YEAR_TOKEN)].flatMap((match) => (match[1] === undefined ? [] : [Number(match[1])]));
}

/** True when the text is nothing but year tokens (`1920`, `1920 2008`). */
function isYearBlock(text: string): boolean {
  return text.split(' ').every((word) => /^(?:19|20)\d{2}$/.test(word));
}

/**
 * A topic slug is the most reliable place to get a *searchable* title:
 *
 *   panthadikkaam-2026-s01-ep-01-05-true-web-dl-1080p-720p-avc-dd51-192kbps-18gb-…
 *   a-minecraft-movie-2025-hindi-hdtc-1080p-720p-x264-2gb-1gb-400mb-hq-clean-audio
 *
 * Everything after the year is noise (season, episode range, source, codec, audio, sizes), so
 * the query is the slug prefix and the *preferred* year is the last 4-digit year. Preferred, not
 * certain: a re-release slug names two years and either can be the release year, which is why
 * `yearsInSlug` reports all of them for the scorer. Block-header titles are a poor substitute:
 * they keep "S01 EP (01-05) Malayalam" glued to the name.
 */
export function queryFromSlug(slug: string): SearchQuery {
  const matches = [...slug.matchAll(YEAR_TOKEN)];
  const last = matches.at(-1);
  const yearText = last?.[1];
  if (!last || last.index === undefined || yearText === undefined) {
    return { query: slug.replace(/-/g, ' ').trim(), year: null };
  }

  const title = slug.slice(0, last.index).replace(/-/g, ' ').trim();
  // No title before the year: the year token itself is the only searchable text.
  if (title.length === 0) return { query: yearText, year: null };
  // The "title" is a year, because the film is named after one (`1920`, released 2008). Search it,
  // but claim no release year — the block names several and the scorer tolerates all of them.
  if (isYearBlock(title)) return { query: title, year: null };

  return { query: title, year: Number(yearText) };
}

const NOISE = /\b(?:s\d{1,2}|season|ep|episode|e\d{1,3}|\d{3,4}p|4k|uhd|hdr|x264|x265|hevc|avc|aac|ac3|dd|ddp|dts|atmos|esub|hc|hq|clean|untouched|proper|repack|web|webrip|webdl|bluray|bdrip|brrip|hdtv|dvd|predvd|pdvd|hdts|hdtc|cam|org|original|auds|audio|multi|tamil|telugu|hindi|malayalam|kannada|english|eng|hin|tam|tel|mal|kan)\b/gi;

export interface SearchHint {
  query: string | null;
  year: number | null;
}

/**
 * What to prefill a TMDB search with for a topic.
 *
 * `queryFromSlug` first — that is the exact call the provider pass makes, so a reviewer sees what
 * the crawler asked. `queryFromTitle` only when the slug strips to nothing, which is the one case
 * where the header title carries information the slug lost.
 */
export function searchHint(slug: string, rawTitle: string): SearchHint {
  const fromSlug = queryFromSlug(slug);
  const best = fromSlug.query.length > 0 ? fromSlug : queryFromTitle(rawTitle);
  return { query: best.query.length > 0 ? best.query : null, year: best.year };
}

/** Fallback when a slug is unusable: strip the tagging vocabulary out of a header title. */
export function queryFromTitle(title: string): SearchQuery {
  const yearMatch = /\((19|20)\d{2}\)/.exec(title);
  const year = yearMatch ? Number(yearMatch[0].slice(1, 5)) : null;
  const cleaned = title
    .replace(/['\u2018\u2019\u02bc]/g, '')
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[[\](){}]/g, ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { query: cleaned, year };
}
