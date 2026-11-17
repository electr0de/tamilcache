import { normaliseImdbId } from '@tamilcache/shared';

export interface TvdbSearchHit {
  tvdbId: number;
  title: string;
  year: number | null;
  slug: string | null;
  network: string | null;
}

export interface TvdbSeries {
  tvdbId: number;
  title: string;
  year: number | null;
  originalLanguage: string | null;
  originalCountry: string | null;
  firstAired: string | null;
  status: string | null;
  aliases: string[];
  episodes: number | null;
  seasons: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  overview: string | null;
}

export interface TvdbTokenStore {
  get: () => string | null;
  set: (value: string | null) => void;
}

export interface TvdbClientOptions {
  apiKey: string;
  pin?: string | null;
  baseUrl?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  tokenStore?: TvdbTokenStore;
  sleep?: (ms: number) => Promise<void>;
}

/** TVDB speaks ISO-639-2; `classify()` compares ISO-639-1. One table, no guessing. */
const LANGUAGES: Record<string, string> = {
  tam: 'ta',
  tel: 'te',
  hin: 'hi',
  mal: 'ml',
  kan: 'kn',
  ben: 'bn',
  mar: 'mr',
  guj: 'gu',
  pun: 'pa',
  urd: 'ur',
  eng: 'en',
};

const yearOf = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null;
  const parsed = Number(raw.slice(0, 4));
  return Number.isFinite(parsed) && parsed > 1800 ? parsed : null;
};

/**
 * TVDB v4, shows only.
 *
 * Licensing note: the API needs a negotiated contract or a subscriber key, so this client is
 * optional everywhere it is used. It enriches a human decision; it never makes one, and the UI
 * attributes the data it supplies.
 */
export class TvdbClient {
  private readonly apiKey: string;
  private readonly pin: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly tokenStore: TvdbTokenStore | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: string | null;

  constructor(options: TvdbClientOptions) {
    if (!options.apiKey) throw new Error('TvdbClient: TVDB_API_KEY is required');
    this.apiKey = options.apiKey;
    this.pin = options.pin ?? null;
    this.baseUrl = options.baseUrl ?? 'https://api4.thetvdb.com/v4';
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.tokenStore = options.tokenStore;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.token = this.tokenStore?.get() ?? null;
  }

  static language(code: string | null | undefined): string | null {
    if (!code) return null;
    return LANGUAGES[code.toLowerCase()] ?? null;
  }

  private async login(): Promise<string> {
    const body: Record<string, string> = { apikey: this.apiKey };
    if (this.pin) body['pin'] = this.pin;
    const response = await this.fetchImpl(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`TVDB login ${response.status}`);
    const parsed = (await response.json()) as { data?: { token?: string } };
    const token = parsed.data?.token;
    if (!token) throw new Error('TVDB login returned no token');
    this.token = token;
    this.tokenStore?.set(token);
    return token;
  }

  private async get<T>(path: string, attempt = 1): Promise<T> {
    const token = this.token ?? (await this.login());
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401 && attempt === 1) {
      // A stale token from `app_state` is expected after a long idle period: drop it and retry.
      this.token = null;
      this.tokenStore?.set(null);
      return this.get<T>(path, 2);
    }
    if (response.status >= 500 && attempt === 1) {
      await this.sleep(500);
      return this.get<T>(path, 2);
    }
    if (!response.ok) throw new Error(`TVDB ${response.status} for ${path}`);
    return (await response.json()) as T;
  }

  async search(term: string): Promise<TvdbSearchHit[]> {
    const body = await this.get<{ data?: Array<Record<string, unknown>> }>(
      `/search?type=series&query=${encodeURIComponent(term)}`,
    );
    return (body.data ?? []).flatMap((row): TvdbSearchHit[] => {
      const rawId = row['tvdb_id'] ?? row['id'];
      const title = row['name'] ?? row['title'];
      if (typeof rawId !== 'number' && typeof rawId !== 'string') return [];
      const tvdbId = Number(rawId);
      if (!Number.isFinite(tvdbId) || typeof title !== 'string' || !title) return [];
      return [
        {
          tvdbId,
          title,
          year: yearOf(row['first_air_time'] ?? row['year']),
          slug: typeof row['slug'] === 'string' ? row['slug'] : null,
          network: typeof row['network'] === 'string' ? row['network'] : null,
        },
      ];
    });
  }

  async series(id: number): Promise<TvdbSeries> {
    // `meta=episodes` is load-bearing: without it the API returns `episodes: null` for every
    // series, so the field was silently dead until the live probe of 2026-11-14.
    const body = await this.get<{ data?: Record<string, unknown> }>(`/series/${id}/extended?meta=episodes`);
    // A 200 with `data: null` is not a series: rendering a hollow record made the panel claim the
    // title has no linked IMDb/TMDB id instead of surfacing an upstream fault.
    if (!body.data) throw new Error(`TVDB returned no series data for ${id}`);
    const row = body.data;
    const aliases = Array.isArray(row['aliases'])
      ? (row['aliases'] as Array<Record<string, unknown>>)
          .map((alias) => alias['name'])
          .filter((name): name is string => typeof name === 'string')
      : [];
    const status = row['status'];
    // Remote ids are cross-references: `sourceName` is the contract, `type` is the fallback
    // (2 = IMDB, 12 = TheMovieDB.com). Never index by position — ordering is upstream's.
    const remoteIds = Array.isArray(row['remoteIds']) ? (row['remoteIds'] as Array<Record<string, unknown>>) : [];
    const remote = (sourceName: string, type: number): string | null => {
      const entry =
        remoteIds.find((candidate) => candidate['sourceName'] === sourceName) ??
        remoteIds.find((candidate) => candidate['type'] === type);
      return typeof entry?.['id'] === 'string' ? entry['id'] : null;
    };
    const imdbRaw = remote('IMDB', 2);
    const tmdbRaw = remote('TheMovieDB.com', 12);
    return {
      tvdbId: typeof row['id'] === 'number' ? row['id'] : id,
      title: typeof row['name'] === 'string' ? row['name'] : '',
      year: yearOf(row['firstAired']),
      originalLanguage: TvdbClient.language(typeof row['originalLanguage'] === 'string' ? row['originalLanguage'] : null),
      originalCountry: typeof row['originalCountry'] === 'string' ? row['originalCountry'] : null,
      firstAired: typeof row['firstAired'] === 'string' ? row['firstAired'] : null,
      status:
        typeof status === 'string'
          ? status
          : status && typeof (status as Record<string, unknown>)['name'] === 'string'
            ? ((status as Record<string, unknown>)['name'] as string)
            : null,
      aliases,
      episodes: Array.isArray(row['episodes']) ? (row['episodes'] as unknown[]).length : null,
      seasons: Array.isArray(row['seasons']) ? (row['seasons'] as unknown[]).length : null,
      imdbId: normaliseImdbId(imdbRaw),
      // A TVDB remote id is a string; anything but digits becomes null rather than NaN.
      tmdbId: tmdbRaw !== null && /^\d+$/.test(tmdbRaw) ? Number(tmdbRaw) : null,
      overview: typeof row['overview'] === 'string' ? row['overview'] : null,
    };
  }
}
