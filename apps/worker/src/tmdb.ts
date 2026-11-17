import type { TmdbCandidate } from '@tamilcache/shared';

export interface TmdbExternalIds {
  imdbId: string | null;
  tvdbId: number | null;
}

export interface TmdbEpisode {
  season: number;
  episode: number;
  airDate: string | null;
  name: string | null;
}

export interface TmdbDetails {
  /** false when `external_ids` failed, so callers must not overwrite known ids with nulls. */
  externalIdsOk?: boolean;
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
  originalLanguage: string | null;
  imdbId: string | null;
  tvdbId: number | null;
  seasons: number | null;
  posterPath: string | null;
  overview: string | null;
  /**
   * Already present in every `/movie|tv/{id}` response and discarded here until schema v9. Nothing
   * about these costs an extra request; the parser was simply throwing them away.
   */
  genres: string[];
  voteAverage: number | null;
  voteCount: number | null;
  /** Movie `runtime`, or a series' first `episode_run_time`. */
  runtime: number | null;
  backdropPath: string | null;
  status: string | null;
}

/** TMDB asked us to slow down; the caller must stop the whole pass, not just skip one title. */
export class TmdbRateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`TMDB rate limited; retry after ${retryAfterMs}ms`);
  }
}

export interface TmdbClientOptions {
  apiKey: string;
  fetchImpl?: (url: string) => Promise<Response>;
  /** TMDB allows ~50 rps; we are a single-user crawler and stay far below it. */
  minIntervalMs?: number;
  baseUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface RawSearchResult {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  original_language?: string;
  popularity?: number;
}

/** Movies carry `runtime`; series carry `episode_run_time[]` (and no `runtime`). */
function runtimeOf(detail: Record<string, unknown>): number | null {
  if (typeof detail['runtime'] === 'number') return detail['runtime'];
  const times = detail['episode_run_time'];
  if (Array.isArray(times) && typeof times[0] === 'number') return times[0];
  return null;
}

const yearOf = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value.slice(0, 4));
  return Number.isFinite(parsed) && parsed > 1800 ? parsed : null;
};

/**
 * Thin, cache-less TMDB client: every call is one HTTP request and nothing else. Caching lives in
 * `provider-pass.ts` (the `metadata_cache` table) so this stays trivially testable with an
 * injected `fetchImpl`.
 */
export class TmdbClient {
  private lastCallAt = -Infinity;

  private readonly apiKey: string;
  private readonly fetchImpl: (url: string) => Promise<Response>;
  private readonly minIntervalMs: number;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TmdbClientOptions) {
    if (!options.apiKey) throw new Error('TmdbClient: TMDB_API_KEY is required');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url));
    this.minIntervalMs = options.minIntervalMs ?? 50;
    this.baseUrl = options.baseUrl ?? 'https://api.themoviedb.org/3';
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** One retry on 5xx: TMDB returns 502s often enough that a single failure is not a signal. */
  private async get<T>(path: string, params: Record<string, string> = {}, attempt = 1): Promise<T> {
    const elapsed = this.now() - this.lastCallAt;
    const wait = this.minIntervalMs - elapsed;
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = this.now();

    const query = new URLSearchParams({ api_key: this.apiKey, ...params });
    const url = `${this.baseUrl}${path}?${query.toString()}`;
    const response = await this.fetchImpl(url);
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new TmdbRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
    }
    if (response.status >= 500 && attempt === 1) {
      await this.sleep(500);
      return this.get<T>(path, params, 2);
    }
    if (!response.ok) throw new Error(`TMDB ${response.status} for ${path}`);
    return (await response.json()) as T;
  }

  /**
   * `/search/multi` in one call, filtered to movies and TV. `year` narrows the search server-side
   * for movies; TV ignores it there, so the year is re-checked during scoring.
   */
  async search(query: string, options: { year?: number | null } = {}): Promise<TmdbCandidate[]> {
    const params: Record<string, string> = { query, include_adult: 'false' };
    if (options.year) params['year'] = String(options.year);

    const body = await this.get<{ results?: RawSearchResult[] }>('/search/multi', params);
    const results = body.results ?? [];

    return results.flatMap((result): TmdbCandidate[] => {
      const mediaType = result.media_type;
      if (mediaType !== 'movie' && mediaType !== 'tv') return [];
      if (typeof result.id !== 'number') return [];
      const title = result.title ?? result.name ?? '';
      if (!title) return [];
      return [
        {
          id: result.id,
          mediaType,
          title,
          year: yearOf(mediaType === 'movie' ? result.release_date : result.first_air_date),
          originalLanguage: result.original_language ?? null,
          popularity: result.popularity ?? 0,
        },
      ];
    });
  }

  async details(mediaType: 'movie' | 'tv', id: number): Promise<TmdbDetails> {
    const detail = await this.get<Record<string, unknown>>(`/${mediaType}/${id}`);
    // `external_ids` is best-effort: it 502s on its own often enough that losing it must not
    // lose the match. Without it we simply have no imdb/tvdb id, which only costs a client hint.
    let externalIdsOk = true;
    const external = await this.get<Record<string, unknown>>(`/${mediaType}/${id}/external_ids`).catch(() => {
      externalIdsOk = false;
      return {} as Record<string, unknown>;
    });

    const title = String(detail['title'] ?? detail['name'] ?? '');
    const date = String(detail['release_date'] ?? detail['first_air_date'] ?? '');
    // Season 0 is "specials" and is never stored, so counting it would overstate coverage.
    const seasons = Array.isArray(detail['seasons'])
      ? (detail['seasons'] as Array<Record<string, unknown>>).filter(
          (season) => typeof season['season_number'] === 'number' && (season['season_number'] as number) > 0,
        ).length
      : null;

    return {
      id,
      mediaType,
      title,
      year: yearOf(date),
      originalLanguage: typeof detail['original_language'] === 'string' ? detail['original_language'] : null,
      imdbId: typeof external['imdb_id'] === 'string' && external['imdb_id'] ? external['imdb_id'] : null,
      // TMDB now returns null here for most regional shows; Sonarr matching must not depend on it.
      tvdbId: typeof external['tvdb_id'] === 'number' ? external['tvdb_id'] : null,
      seasons,
      posterPath: typeof detail['poster_path'] === 'string' ? detail['poster_path'] : null,
      overview: typeof detail['overview'] === 'string' && detail['overview'] ? detail['overview'] : null,
      genres: Array.isArray(detail['genres'])
        ? (detail['genres'] as Array<{ name?: unknown }>)
            .map((genre) => genre.name)
            .filter((name): name is string => typeof name === 'string')
        : [],
      voteAverage: typeof detail['vote_average'] === 'number' ? detail['vote_average'] : null,
      voteCount: typeof detail['vote_count'] === 'number' ? detail['vote_count'] : null,
      runtime: runtimeOf(detail),
      backdropPath: typeof detail['backdrop_path'] === 'string' ? detail['backdrop_path'] : null,
      status: typeof detail['status'] === 'string' ? detail['status'] : null,
      externalIdsOk,
    };
  }

  /**
   * The bridge from an IMDb id to a TMDB id. OMDb and TVDB identify titles by IMDb; TMDB numbers
   * them itself, so `/find` is the only way in. Returns both namespaces: a title can be ambiguous,
   * and the caller must ask rather than pick.
   */
  async findByImdbId(imdbId: string): Promise<TmdbCandidate[]> {
    const body = await this.get<{
      movie_results?: RawSearchResult[];
      tv_results?: RawSearchResult[];
    }>(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' });

    const map = (results: RawSearchResult[] | undefined, mediaType: 'movie' | 'tv'): TmdbCandidate[] =>
      (results ?? []).flatMap((result) => {
        if (typeof result.id !== 'number') return [];
        const title = result.title ?? result.name ?? '';
        if (!title) return [];
        return [
          {
            id: result.id,
            mediaType,
            title,
            year: yearOf(mediaType === 'movie' ? result.release_date : result.first_air_date),
            originalLanguage: result.original_language ?? null,
            popularity: result.popularity ?? 0,
          },
        ];
      });

    return [...map(body.movie_results, 'movie'), ...map(body.tv_results, 'tv')];
  }

  async seasonEpisodes(tvId: number, season: number): Promise<TmdbEpisode[]> {
    const body = await this.get<{ episodes?: Array<Record<string, unknown>> }>(`/tv/${tvId}/season/${season}`);
    return (body.episodes ?? []).flatMap((episode): TmdbEpisode[] => {
      const number = episode['episode_number'];
      if (typeof number !== 'number') return [];
      return [
        {
          season,
          episode: number,
          airDate: typeof episode['air_date'] === 'string' ? episode['air_date'] : null,
          name: typeof episode['name'] === 'string' ? episode['name'] : null,
        },
      ];
    });
  }

  /** Which season numbers to fetch. TMDB's `seasons` array includes specials (season 0). */
  async seasonNumbers(tvId: number): Promise<number[]> {
    const body = await this.get<{ seasons?: Array<Record<string, unknown>> }>(`/tv/${tvId}`);
    const seasons = (body.seasons ?? [])
      .map((season) => (typeof season['season_number'] === 'number' ? season['season_number'] : null))
      .filter((value): value is number => value !== null && value > 0);
    return [...new Set(seasons)].sort((a, b) => a - b);
  }
}
