export type Decision = 'hindi_dubbed' | 'hindi_original' | 'not_hindi' | 'unknown';

export interface Stats {
  topics: number;
  variants: number;
  withMagnet: number;
  withTorrent: number;
  preferred: number;
  movies: number;
  shows: number;
  byDecision: Partial<Record<Decision, number>>;
  reviewQueue: Record<string, number>;
  /** Topics with no servable variant, by why. The dashboard's backlog card sums the first three. */
  unresolved: UnresolvedCounts;
}

export interface VariantLink {
  id: number;
  url: string;
  kind: 'gdrive' | 'shortener' | 'stream' | 'torrent' | 'spam' | 'other' | 'download';
  label: string | null;
}

export interface Variant {
  id: number;
  topicId: number;
  normTitle: string | null;
  rawTitle: string;
  slug: string;
  resolution: string | null;
  sourceTag: string;
  sourceTagRaw: string;
  codec: string | null;
  audioCodecs: string | null;
  audioLangs: string[];
  sizeBytes: number;
  infohash: string;
  magnet: string | null;
  torrentUrl: string | null;
  season: number | null;
  epFrom: number | null;
  epTo: number | null;
  publishedAt: string | null;
  isPack: boolean;
  categoryId: number | null;
  qualityRank: number;
  decision: Decision;
  reviewReason: string | null;
  isPreferred: boolean;
  forumName: string;
  poster: string | null;
  tmdbId: number | null;
  year: number | null;
  links: VariantLink[];
}

export interface CrawlHealth {
  armed: boolean;
  paused: boolean;
  deltaRequested: boolean;
  lastDeltaAt: string | null;
  backfillCompleteAt: string | null;
  circuitOpenUntil: string | null;
  tmdbBackoffUntil: string | null;
  dead: { count: number; sample: Array<{ url: string; kind: string; attempts: number }> };
  pending: { p0: number; p1: number };
  backfill: Array<{
    forum: string;
    sourceForumId: number;
    nextPage: number;
    totalPages: number | null;
    done: boolean;
    percent: number | null;
    failures: number;
    lastError: string | null;
    retryAfter: string | null;
  }>;
}

export interface BrowseResponse {
  total: number;
  rows: Variant[];
}

export interface LogRow {
  id: number;
  ts: string;
  source: 'worker' | 'api';
  level: 'debug' | 'info' | 'warn' | 'error';
  class: 'audit' | 'diag';
  scope: string;
  event: string;
  message: string;
  url: string | null;
  taskId: number | null;
  runId: number | null;
  forumId: number | null;
  variantId: number | null;
  detail: string | null;
}

export interface LogsResponse {
  rows: LogRow[];
  total: number;
  nextOffset: number | null;
}

export interface LogsSummary {
  byLevel: Record<string, number>;
  byScope: Record<string, number>;
  diagRows: number;
  auditRows: number;
  prunedAt: string | null;
}

/** Builds `?a=1&b=2` while dropping empty values, matching the browse endpoint's convention. */
function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
}

export interface ReviewGroup {
  reason: string;
  count: number;
  items: Array<{
    id: number;
    topicId: number;
    slug: string;
    rawTitle: string;
    poster: string | null;
    forumId: number;
    forumName: string;
    /** The tamilmv post this row came from, so a reviewer can read the source. */
    link: string;
    kindSource: string | null;
    resolution: string | null;
    sourceTagRaw: string;
    audioLangs: string[];
    sizeBytes: number;
    mediaTitle: string | null;
    originalLanguage: string | null;
    providerStatus: string;
    providerProposal: string | null;
    kind: 'movie' | 'tv';
    /** What the crawler itself asked TMDB, so the reviewer never retypes it. Null if unusable. */
    searchQuery: string | null;
    searchYear: number | null;
  }>;
}

export interface OmdbHit {
  imdbId: string;
  title: string;
  year: number | null;
  mediaType: 'movie' | 'tv';
  poster: string | null;
}

export interface TvdbHit {
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

export interface ManualBindBody {
  imdbId: string;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
  originalLanguage: string;
  seasons: number | null;
  poster?: string | null;
}

export interface TmdbSearchResponse {
  results: Array<{
    id: number;
    mediaType: 'movie' | 'tv';
    title: string;
    year: number | null;
    originalLanguage: string | null;
    popularity: number;
    /** Present only when `kind` was sent: the same scorer the provider pass uses. */
    score?: number;
    reasons?: string[];
  }>;
}

export interface Rule {
  id: number;
  priority: number;
  predicate: string;
  action: string;
  note: string | null;
  enabled: boolean;
  hits: number;
}

const KEY_STORAGE = 'tamilcache.apikey';

export function getApiKey(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('apikey');
  if (fromUrl) {
    window.localStorage.setItem(KEY_STORAGE, fromUrl);
    // Keep the key out of the address bar, history, and any link copied from the page.
    url.searchParams.delete('apikey');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  return window.localStorage.getItem(KEY_STORAGE) ?? '';
}

/**
 * The key is generated by the app and handed to the page — the user never invents or pastes one.
 *
 * `/api/v1/bootstrap` validates the request (cross-site, Origin/Host match, DNS-rebinding-safe
 * host) rather than restricting it to loopback, so any browser that can load the SPA can ask for
 * the key. `request()` calls this again after a 401, which is what makes a stale localStorage key
 * self-heal instead of turning the UI into a key prompt.
 */
export async function ensureApiKey(): Promise<string> {
  const existing = getApiKey();
  if (existing) return existing;
  try {
    const response = await fetchImpl('/api/v1/bootstrap');
    if (!response.ok) return '';
    const body = (await response.json()) as { apiKey?: string };
    if (body.apiKey) {
      setApiKey(body.apiKey);
      return body.apiKey;
    }
  } catch {
    // Offline (e.g. the vite dev server with no API behind it) — callers surface a real error
    // rather than asking the user to supply a key they are not supposed to know.
  }
  return '';
}

export function setApiKey(key: string): void {
  window.localStorage.setItem(KEY_STORAGE, key);
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchImpl = (url, init) => fetch(url, init);

/** Tests inject a fetch stub; the app always goes through this seam. */
export function setFetchImpl(impl: FetchImpl): void {
  fetchImpl = impl;
}

function withKey(path: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}apikey=${encodeURIComponent(getApiKey())}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare JSON when a body is actually sent: Fastify rejects an empty body that claims
  // `content-type: application/json` with a 400, which is how the bodyless lane-control POSTs broke.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  if (init?.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const send = () => fetchImpl(withKey(path), { ...init, headers });
  let response = await send();
  if (response.status === 401) {
    // The stored key no longer matches this deployment (a re-created database, a new volume, a
    // stale browser profile). Ask the app for the current one and retry once, so the UI can never
    // end up instructing the user to supply a key it is supposed to hand them.
    window.localStorage.removeItem(KEY_STORAGE);
    await ensureApiKey();
    response = await send();
    if (response.status === 401) {
      throw new Error('the server refused the key this page was issued — reload the page');
    }
  }
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export interface LibraryTitle {
  mediaId: number;
  type: 'movie' | 'tv';
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  voteAverage: number | null;
  originalLanguage: string | null;
  audioLangs: string[];
  resolutions: string[];
  releases: number;
  latestRelease: string | null;
  largestBytes: number;
  seasons: number | null;
  coverage: { aired: number; covered: number; missing: number } | null;
  noHindi: boolean;
}

export interface UnmatchedRelease {
  id: number;
  slug: string;
  rawTitle: string;
  resolution: string | null;
  sizeBytes: number;
  decision: Decision;
}

export interface LibraryResponse {
  total: number;
  limit: number;
  offset: number;
  titles: LibraryTitle[];
  unmatched?: UnmatchedRelease[];
}

export interface LibraryEpisode {
  season: number;
  episode: number;
  airDate: string | null;
  name: string | null;
  aired: boolean;
  covered: boolean;
}

export interface LibraryDetail {
  media: {
    mediaId: number;
    type: 'movie' | 'tv';
    title: string;
    year: number | null;
    originalLanguage: string | null;
    imdbId: string | null;
    tvdbId: number | null;
    tmdbId: number | null;
    seasons: number | null;
    poster: string | null;
    backdrop: string | null;
    overview: string | null;
    voteAverage: number | null;
    voteCount: number | null;
    runtime: number | null;
    genres: string[];
    status: string | null;
  };
  availability: 'hindi_ready' | 'no_hindi';
  releases: Variant[];
  seasons: Array<{ season: number; episodes: LibraryEpisode[]; aired: number; covered: number }> | null;
  coverage: { aired: number; covered: number };
  missing: Array<{ season: number; episode: number; airDate: string | null; name: string | null }>;
}


export interface UnresolvedLink {
  url: string;
  kind: string;
  label: string;
}

/** A topic whose page produced no variant: the only rows the unresolved queue shows. */
/** Query for the unresolved queue; every field is optional because the default is "everything". */
export interface UnresolvedParams {
  status?: 'all' | 'external' | 'no_link' | 'gone' | 'parse_failed' | 'below_floor' | undefined;
  q?: string | undefined;
  forum?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface UnresolvedCounts {
  external: number;
  no_link: number;
  gone: number;
  parse_failed: number;
  below_floor: number;
}

export interface UnresolvedPage {
  rows: UnresolvedRow[];
  total: number;
  page: number;
  pages: number;
  counts: UnresolvedCounts;
}

export interface UnresolvedRow {
  id: number;
  sourceTopicId: number;
  slug: string;
  rawTitle: string;
  status: 'external' | 'no_link' | 'gone' | 'parse_failed' | 'below_floor';
  views: number | null;
  kind: string;
  firstSeenAt: string;
  lastSeenAt: string;
  forumId: number;
  forumName: string;
  baseUrl: string;
  links: UnresolvedLink[];
}

export interface CoverageBoard {
  id: number;
  /** The site's display title (`WEB-HD / iTunes-HD / BluRay`). */
  title: string;
  /** The language/section this board belongs to. It has no forum id: it is a config concept. */
  hub: { title: string };
  name: string;
  scope: 'include' | 'exclude' | 'undecided';
  pagesOnSite: number | null;
  pagesCovered: number;
  slots: number | null;
  fetched: number;
  stored: number;
  byStatus: Record<string, number>;
}

export interface CoverageReport {
  boards: CoverageBoard[];
  problems: string[];
  exitCode: number;
}

export interface MagnetBody {
  magnet: string;
  resolution: '1080p' | '1440p' | '2160p';
  sizeBytes: number;
  sourceTag: string;
  audioLangs?: string[];
  codec?: string | null;
  season?: number | null;
  epFrom?: number | null;
  epTo?: number | null;
}

export const api = {
  stats: () => request<Stats>('/api/v1/stats'),
  library: (params: Record<string, string | number | undefined>) =>
    request<LibraryResponse>(`/api/v1/library?${toQuery(params)}`),
  suggest: (q: string) =>
    request<{ titles: Array<{ mediaId: number; title: string; year: number | null; type: 'movie' | 'tv'; poster: string | null }> }>(
      `/api/v1/library/suggest?q=${encodeURIComponent(q)}`,
    ),
  libraryTitle: (mediaId: number) => request<LibraryDetail>(`/api/v1/library/${mediaId}`),
  logs: (params: Record<string, string | number | boolean | undefined>) =>
    request<LogsResponse>(`/api/v1/logs?${toQuery(params)}`),
  logsSummary: () => request<LogsSummary>('/api/v1/logs/summary?since=24h'),
  crawl: () => request<CrawlHealth>('/api/v1/crawl'),
  /** Re-cache the index: the worker picks the flag up on its next tick. */
  requestDelta: () => request<{ queued: boolean }>('/api/v1/crawl/delta', { method: 'POST' }),
  setBackfill: (body: { armed?: boolean; paused?: boolean }) =>
    request<{ armed: string | null; paused: string | null }>('/api/v1/crawl/backfill', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  browse: (params: Record<string, string | number | boolean | undefined>) => {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&');
    return request<BrowseResponse>(`/api/v1/browse?${query}`);
  },
  forums: () => request<Array<{ id: number; name: string; slug: string | null; language: string | null }>>('/api/v1/forums'),
  title: (key: string) =>
    request<{
      title: string;
      year: number | null;
      poster: string | null;
      tmdbId: number | null;
      originalLanguage: string | null;
      kind: 'movie' | 'tv';
      /** Prefill for the TMDB picker, computed by the same helper the crawler searches with. */
      searchQuery: string | null;
      searchYear: number | null;
      variants: Variant[];
      coverage: { aired: number; covered: number };
      missing: Array<{ season: number; episode: number; airDate: string | null; name: string | null }>;
      episodes: Array<{ season: number; episode: number; airDate: string | null; name: string | null; covered: boolean; aired: boolean }>;
    }>(`/api/v1/titles/${encodeURIComponent(key)}`),
  bindTopic: (topicId: number, tmdbId: number, mediaType: 'movie' | 'tv') =>
    request<{ mediaId: number; originalLanguage: string | null; replay: { updated: number } }>(
      `/api/v1/titles/${topicId}/bind`,
      { method: 'POST', body: JSON.stringify({ tmdbId, mediaType }) },
    ),
  recheckTopic: (topicId: number) => request<{ ok: boolean }>(`/api/v1/titles/${topicId}/recheck`, { method: 'POST' }),
  tmdbSearch: (q: string, year?: number | null, kind?: 'movie' | 'tv') =>
    request<TmdbSearchResponse>(
      `/api/v1/tmdb/search?q=${encodeURIComponent(q)}${year ? `&year=${year}` : ''}${kind ? `&kind=${kind}` : ''}`,
    ),
  providers: () => request<{ omdb: boolean; tvdb: boolean }>('/api/v1/providers'),
  omdbSearch: (q: string, year?: number | null) =>
    request<{ results: OmdbHit[] }>(
      `/api/v1/omdb/search?q=${encodeURIComponent(q)}${year ? `&year=${year}` : ''}`,
    ),
  tvdbSearch: (q: string) => request<{ results: TvdbHit[] }>(`/api/v1/tvdb/search?q=${encodeURIComponent(q)}`),
  tvdbSeries: (id: number) => request<TvdbSeries>(`/api/v1/tvdb/series/${id}`),
  bindManual: (topicId: number, body: ManualBindBody) =>
    request<{ mediaId: number; viaTmdb: boolean; replay: { updated: number } }>(
      `/api/v1/titles/${topicId}/bind-manual`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  unresolved: (params: UnresolvedParams = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return request<UnresolvedPage>(`/api/v1/unresolved?${search.toString()}`);
  },
  submitMagnet: (topicId: number, body: MagnetBody) =>
    request<{ id: number }>(`/api/v1/topics/${topicId}/magnet`, { method: 'POST', body: JSON.stringify(body) }),
  recheck: (topicId: number) => request<{ queued: boolean }>(`/api/v1/topics/${topicId}/recheck`, { method: 'POST' }),
  coverage: () => request<{ report: CoverageReport | null; generatedAt: string | null }>('/api/v1/coverage'),
  review: () => request<{ total: number; groups: ReviewGroup[] }>('/api/v1/review'),
  preview: (predicate: unknown, action: string) =>
    request<{ affected: number; sample: unknown[] }>('/api/v1/review/preview', {
      method: 'POST',
      body: JSON.stringify({ predicate, action }),
    }),
  decide: (body: {
    variantIds?: number[];
    action: string;
    applyToSimilar?: boolean;
    predicate?: unknown;
    dryRun?: boolean;
  }) =>
    request<{ affected: number; dryRun: boolean; replay?: { updated: number } }>('/api/v1/review/decide', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rules: () => request<Rule[]>('/api/v1/rules'),
  createRule: (body: { predicate: unknown; action: string; priority?: number; note?: string }) =>
    request<{ rule: Rule; replay: { updated: number } }>('/api/v1/rules', { method: 'POST', body: JSON.stringify(body) }),
  patchRule: (id: number, body: Record<string, unknown>) =>
    request<{ rule: Rule; replay: { updated: number } }>(`/api/v1/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteRule: (id: number) => request<{ replay: { updated: number } }>(`/api/v1/rules/${id}`, { method: 'DELETE' }),
  uploadTorrent: async (variantId: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    const response = await fetchImpl(withKey(`/api/v1/torrents/${variantId}`), { method: 'POST', body: form });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as { variantId: number; infohash: string };
  },
};

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
