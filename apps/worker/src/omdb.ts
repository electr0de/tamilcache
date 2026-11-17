import type { MediaKind } from '@tamilcache/shared';

export interface OmdbHit {
  imdbId: string;
  title: string;
  year: number | null;
  mediaType: MediaKind;
  poster: string | null;
}

/** The 1,000/day free tier is counted by OMDb per key per day, so the counter must outlive a process. */
export interface OmdbQuota {
  used: () => Promise<number>;
  increment: () => Promise<number>;
}

/** Raised *before* any request, so a spent budget costs zero network calls. */
export class OmdbQuotaExceededError extends Error {
  constructor(public readonly limit: number) {
    super(`OMDb daily limit of ${limit} requests reached; it resets at 00:00 UTC`);
  }
}

export interface OmdbClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: (url: string) => Promise<Response>;
  quota?: OmdbQuota;
  /** Free keys allow 1,000/day; stop at it so a manual search never gets an OMDb error page. */
  dailyLimit?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RawSearchItem {
  Title?: string;
  Year?: string;
  imdbID?: string;
  Type?: string;
  Poster?: string;
}

interface RawSearch {
  Search?: RawSearchItem[];
  Response?: string;
  Error?: string;
}

const yearOf = (raw: string | undefined): number | null => {
  const parsed = Number((raw ?? '').slice(0, 4));
  return Number.isFinite(parsed) && parsed > 1800 ? parsed : null;
};

/**
 * Thin OMDb client. Never called by the worker: it exists for a human who is looking at a title
 * TMDB does not have, and every call costs one of 1,000 free daily requests.
 */
export class OmdbClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (url: string) => Promise<Response>;
  private readonly quota: OmdbQuota | undefined;
  private readonly dailyLimit: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OmdbClientOptions) {
    if (!options.apiKey) throw new Error('OmdbClient: OMDB_API_KEY is required');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://www.omdbapi.com';
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url));
    this.quota = options.quota;
    this.dailyLimit = options.dailyLimit ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async search(term: string, year: number | null = null): Promise<OmdbHit[]> {
    if (this.quota) {
      const used = await this.quota.used();
      if (used >= this.dailyLimit) throw new OmdbQuotaExceededError(this.dailyLimit);
      await this.quota.increment();
    }

    const params = new URLSearchParams({ apikey: this.apiKey, s: term });
    if (year !== null) params.set('y', String(year));
    const url = `${this.baseUrl}/?${params.toString()}`;

    let response = await this.fetchImpl(url);
    if (response.status >= 500) {
      await this.sleep(500);
      response = await this.fetchImpl(url);
    }
    if (!response.ok) throw new Error(`OMDb ${response.status}`);

    const body = (await response.json()) as RawSearch;
    // OMDb answers HTTP 200 with `Response: 'False'` for "no results". That is not a failure.
    if (body.Response === 'False') return [];

    return (body.Search ?? []).flatMap((item): OmdbHit[] => {
      if (!item.imdbID || !item.Title) return [];
      const mediaType: MediaKind | null =
        item.Type === 'series' ? 'tv' : item.Type === 'movie' ? 'movie' : null;
      if (!mediaType) return []; // episodes are not attachable titles
      return [
        {
          imdbId: item.imdbID,
          title: item.Title,
          year: yearOf(item.Year),
          mediaType,
          poster: item.Poster && item.Poster !== 'N/A' ? item.Poster : null,
        },
      ];
    });
  }
}
