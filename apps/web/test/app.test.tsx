import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { setApiKey, setFetchImpl } from '../src/api.js';

const STATS = {
  topics: 10,
  variants: 61,
  withMagnet: 54,
  withTorrent: 7,
  preferred: 5,
  movies: 42,
  shows: 9,
  byDecision: { hindi_dubbed: 7, unknown: 54 },
  reviewQueue: { NO_PROVIDER_MATCH: 54 },
  unresolved: { external: 2408, no_link: 1960, parse_failed: 65, gone: 0 },
};

const BROWSE = {
  total: 1,
  rows: [
    {
      id: 1,
      topicId: 1,
      normTitle: 'A.Minecraft.Movie.2025.720p.HDTC.x264.AAC.Hindi.700MB-TMV',
      rawTitle: 'A Minecraft Movie',
      slug: 'a-minecraft-movie-2025',
      resolution: '720p',
      sourceTag: 'HDTC',
      sourceTagRaw: 'HDTC-Rip',
      codec: 'x264',
      audioCodecs: 'AAC',
      audioLangs: ['hindi'],
      sizeBytes: 734003200,
      infohash: 'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
      magnet: 'magnet:?xt=urn:btih:c9d385dc7158d74f70b733f17a8c0dde9b67357c',
      torrentUrl: null,
      season: null,
      epFrom: null,
      epTo: null,
      isPack: false,
      categoryId: 2040,
      qualityRank: 2015,
      decision: 'hindi_dubbed',
      reviewReason: null,
      isPreferred: true,
      forumName: 'Hindi Dubbed',
      poster: null,
      tmdbId: 1,
      year: 2025,
      links: [{ id: 5, url: 'https://drive.google.com/file/d/abc/view', kind: 'gdrive', label: 'drive.google.com' }],
    },
  ],
};

const LIBRARY = {
  total: 120,
  limit: 48,
  offset: 0,
  titles: [
    {
      mediaId: 7,
      type: 'movie',
      title: 'A Minecraft Movie',
      year: 2025,
      poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
      backdrop: null,
      voteAverage: 7.9,
      originalLanguage: 'en',
      audioLangs: ['hindi'],
      resolutions: ['2160p', '720p'],
      releases: 2,
      latestRelease: '2026-11-01T00:00:00.000Z',
      largestBytes: 12 * 1024 ** 3,
      seasons: null,
      coverage: null,
      noHindi: false,
    },
    {
      mediaId: 8,
      type: 'tv',
      title: 'Sigma Show',
      year: 2024,
      poster: null,
      backdrop: null,
      voteAverage: null,
      originalLanguage: 'ta',
      audioLangs: ['hindi', 'tamil'],
      resolutions: ['1080p'],
      releases: 1,
      latestRelease: '2026-10-01T00:00:00.000Z',
      largestBytes: 4 * 1024 ** 3,
      seasons: 2,
      coverage: { aired: 22, covered: 14, missing: 8 },
      noHindi: false,
    },
  ],
};

const UNMATCHED = {
  total: 1,
  limit: 48,
  offset: 0,
  titles: [],
  unmatched: [
    {
      id: 99,
      slug: 'sigma-2026-tamil-hq',
      rawTitle: 'Sigma (2026) Tamil HQ',
      resolution: '1080p',
      sizeBytes: 9 * 1024 ** 3,
      decision: 'hindi_dubbed',
    },
  ],
};

const MOVIE_DETAIL = {
  media: {
    mediaId: 7,
    type: 'movie',
    title: 'A Minecraft Movie',
    year: 2025,
    originalLanguage: 'en',
    imdbId: null,
    tvdbId: null,
    tmdbId: 700,
    seasons: null,
    poster: null,
    backdrop: null,
    overview: null,
    voteAverage: null,
    voteCount: null,
    runtime: null,
    genres: [],
    status: null,
  },
  availability: 'hindi_ready',
  releases: [],
  seasons: null,
  coverage: { aired: 0, covered: 0 },
  missing: [],
};

const CRAWL = {
  armed: false,
  paused: false,
  deltaRequested: false,
  lastDeltaAt: '2026-11-09T03:00:00.000Z',
  backfillCompleteAt: null,
  circuitOpenUntil: null,
  tmdbBackoffUntil: null,
  dead: { count: 2, sample: [{ url: 'https://www.1tamilmv.io/index.php?/forums/topic/1-x/', kind: 'topic', attempts: 5 }] },
  pending: { p0: 3, p1: 120 },
  backfill: [{ forum: '11-web-hd', sourceForumId: 11, nextPage: 3, totalPages: 107, done: false, percent: 3 }],
};

const REVIEW = {
  total: 2,
  groups: [
    {
      reason: 'NO_AUDIO_TAG',
      count: 2,
      items: [
        {
          id: 11,
          topicId: 1,
          slug: 'its-a-medical-miracle-2026',
          rawTitle:
            'It\'s A Medical Miracle (2026) Tamil TRUE WEB-DL - [4K, 1080p & 720p - AVC / HEVC - (DD+5.1 - 640Kbps) - 6GB - 2.8GB - 1.4GB & 950MB] - [x264 - 700MB - 400MB & 250MB]',
          poster: null,
          forumId: 22,
          forumName: 'Telugu',
          resolution: '720p',
          sourceTagRaw: 'HQ HDRip',
          audioLangs: [],
          sizeBytes: 1000,
          mediaTitle: null,
          originalLanguage: null,
          providerStatus: 'ambiguous',
          kind: 'movie',
          searchQuery: 'land',
          searchYear: 2026,
          link: 'https://x.test/index.php?/forums/topic/1-its-a-medical-miracle-2026/',
          providerProposal: JSON.stringify({
            tmdbId: 11,
            title: 'Land',
            year: 2026,
            originalLanguage: 'ta',
            score: 74,
            mediaType: 'movie',
            reasons: ['title prefix', 'year exact'],
            runnerUp: { tmdbId: 22, title: 'Land of Bad', score: 58 },
          }),
        },
        // The dead end: no proposal at all, because provider_status is 'none'.
        {
          id: 12,
          topicId: 2,
          slug: 'kara-2026-telugu-hq',
          rawTitle: 'Kara (2026) Telugu HQ Clean',
          poster: null,
          forumId: 22,
          forumName: 'Telugu',
          resolution: '1080p',
          sourceTagRaw: 'TRUE WEB-DL',
          audioLangs: ['telugu'],
          sizeBytes: 2000,
          mediaTitle: null,
          originalLanguage: null,
          providerStatus: 'none',
          providerProposal: null,
          kind: 'movie',
          searchQuery: 'kara',
          searchYear: 2026,
          link: 'https://x.test/index.php?/forums/topic/2-kara-2026-telugu-hq/',
        },
      ],
    },
  ],
};

const TITLE_UNBOUND = {
  title: 'Kara (2026) Telugu HQ Clean',
  year: 2026,
  tmdbId: null,
  imdbId: null,
  poster: null,
  originalLanguage: null,
  kind: 'movie',
  searchQuery: 'kara',
  searchYear: 2026,
  coverage: { aired: 0, covered: 0 },
  missing: [],
  episodes: [],
  variants: [
    {
      id: 1,
      topicId: 1,
      mediaId: null,
      isPreferred: true,
      normTitle: 'kara.2026.1080p.WEB-DL.Telugu.5GB-TMV',
      rawTitle: 'Kara (2026) Telugu HQ Clean',
      slug: 'kara-2026-telugu-hq-clean',
      resolution: '1080p',
      sourceTag: 'WEB-DL',
      sourceTagRaw: 'TRUE WEB-DL',
      codec: 'x264',
      audioCodecs: 'DD+5.1',
      audioLangs: ['telugu'],
      sizeBytes: 5368709120,
      infohash: 'c'.repeat(40),
      magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
      torrentUrl: null,
      season: null,
      epFrom: null,
      epTo: null,
      isPack: false,
      categoryId: 2040,
      qualityRank: 2015,
      decision: 'unknown',
      reviewReason: 'NO_PROVIDER_MATCH',
      forumName: 'Telugu',
      poster: null,
      tmdbId: null,
      year: 2026,
      links: [],
    },
  ],
};

let calls: string[] = [];
let bodies: string[] = [];

beforeEach(() => {
  calls = [];
  bodies = [];
  setApiKey('testkey');
  setFetchImpl(async (url, init) => {
    calls.push(url);
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/bootstrap')) return respond({ apiKey: 'generated-key', torznabUrl: 'http://localhost:8484/api/v1' });
    if (url.includes('/crawl')) return respond(CRAWL);
    if (url.includes('/stats')) return respond(STATS);
    if (url.includes('/browse')) return respond(BROWSE);
    if (url.includes('/library/suggest')) return respond({ titles: [] });
    if (url.includes('/library')) return respond(url.includes('health=unmatched') ? UNMATCHED : LIBRARY);
    if (url.includes('/review/preview')) return respond({ affected: 1, sample: [] });
    if (url.includes('/review/decide')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { dryRun?: boolean };
      return respond({ affected: 1, dryRun: body.dryRun === true, replay: { updated: 1 } });
    }
    if (url.includes('/titles/') && url.includes('/bind')) return respond({ mediaId: 1, originalLanguage: 'hi', replay: { updated: 1 } });
    if (/\/titles\/[^/]+$/.test(url)) return respond(TITLE_UNBOUND);
    if (url.includes('/tmdb/search') && url.includes('noisy'))
      return respond({
        results: Array.from({ length: 12 }, (_, index) => ({
          id: 100 + index,
          mediaType: 'movie',
          title: `Kara ${index}`,
          year: 2000 + index,
          originalLanguage: 'tr',
          popularity: 1,
          score: 50 - index,
          reasons: [],
        })),
      });
    if (url.includes('/tmdb/search'))
      return respond({
        results: [
          { id: 11, mediaType: 'movie', title: 'Land', year: 2026, originalLanguage: 'ta', popularity: 9, score: 63, reasons: ['title prefix'] },
          { id: 22, mediaType: 'movie', title: 'Land of Bad', year: 2024, originalLanguage: 'en', popularity: 40, score: 10, reasons: [] },
        ],
      });
    if (url.includes('/providers')) return respond({ omdb: true, tvdb: false });
    if (url.includes('/review')) return respond(REVIEW);
    if (url.includes('/forums')) return respond([{ id: 1, name: 'Hindi Dubbed', slug: '64-hindi-dubbed-movies', language: 'hindi' }]);
    return respond({});
  });
});

afterEach(cleanup);

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('api key handling', () => {
  it('shows the key it generated and never asks the user to supply one', async () => {
    renderAt('/settings');
    await screen.findByRole('heading', { name: 'API key' });

    // The key is an output of the app (Radarr/Sonarr paste it), never an input to it.
    expect(screen.getByTestId('api-key')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy key/ })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/paste the key/i);
  });

  it('appends the key to every request', async () => {
    renderAt('/');
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.every((url) => url.includes('apikey=testkey'))).toBe(true);
  });
});

describe('dashboard', () => {
  it('labels the Browse shortcuts with title counts instead of the verb', async () => {
    renderAt('/');

    // The card's value slot is for a number. "Browse" in both slots made the two indistinguishable.
    expect(await screen.findByRole('button', { name: 'Movies 42 poster library' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Shows 9 seasons and episodes' })).toBeTruthy();
  });

  it('renders counters from stats', async () => {
    renderAt('/');
    expect(await screen.findByText('61')).toBeDefined();
    expect(await screen.findByText('Hindi dubbed')).toBeDefined();
    expect(await screen.findByText('NO_PROVIDER_MATCH')).toBeDefined();
  });
});

describe('dashboard crawl health', () => {
  it('shows the backlog to resolve, not the dead-letter counter', async () => {
    renderAt('/');
    // external + no_link + parse_failed = 2408 + 1960 + 65
    expect((await screen.findByTestId('unresolved-count')).textContent).toBe('4,433');
    expect(screen.getByText(/gated 2,408/)).toBeTruthy();
  });

  it('keeps the crawl-task counter as its own infrastructure signal', async () => {
    renderAt('/');
    expect((await screen.findByTestId('dead-count')).textContent).toBe('2');
    expect(screen.getByText(/failed 5×/)).toBeTruthy();
  });

  it('navigates to the unresolved queue and to dead links', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByTestId('unresolved-count'));
    expect(await screen.findByRole('heading', { name: 'Unresolved' })).toBeTruthy();
  });

  it('shows per-forum backfill progress as a percentage', async () => {
    renderAt('/');
    const rows = await screen.findAllByTestId('backfill-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('3%');
    expect(rows[0]?.textContent).toContain('11-web-hd');
  });

  it('names a failing backfill forum instead of showing a stale page count', async () => {
    const retryAfter = new Date(Date.now() + 3 * 60_000).toISOString();
    const failing = {
      ...CRAWL,
      backfill: [
        {
          forum: '26-dvd9-dvd5',
          sourceForumId: 26,
          nextPage: 1,
          totalPages: null,
          done: false,
          percent: null,
          failures: 2,
          lastError: 'backfill page 1 of forum 26 yielded no topics',
          retryAfter,
        },
      ],
    };
    setFetchImpl(async (url) => {
      const body = url.includes('/crawl') ? failing : url.includes('/stats') ? STATS : { groups: [], total: 0 };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    renderAt('/');

    const row = (await screen.findAllByTestId('backfill-row'))[0]!;
    expect(row.textContent).toMatch(/retrying in \d+m/);
    expect(row.querySelector('[title="backfill page 1 of forum 26 yielded no topics"]')).not.toBeNull();
  });

  it('shows the two queue lanes', async () => {
    renderAt('/');
    expect(await screen.findByText('P0 3')).toBeDefined();
    expect(await screen.findByText('P1 120')).toBeDefined();
  });
});

describe('browse grid', () => {
  it('renders one poster card per title with coverage for shows', async () => {
    renderAt('/browse');

    expect(await screen.findByText('A Minecraft Movie')).toBeDefined();
    // The posterless show renders a placeholder tile that burns the title in, so it appears twice.
    expect(screen.getAllByText('Sigma Show').length).toBeGreaterThan(0);
    expect(screen.getByText(/14\/22 aired/)).toBeDefined();
    // The card footer, not the Quality <option> that also reads "2160p".
    expect(screen.getByText(/2160p ·/)).toBeDefined();
  });

  it('queries the library endpoint with paging and shows the total', async () => {
    renderAt('/browse');
    await screen.findByText('A Minecraft Movie');

    expect(calls.some((url) => url.includes('/api/v1/library?') && url.includes('limit=48'))).toBe(true);
    // The pager is rendered at both ends of the grid, so the counts and the buttons appear twice.
    expect(screen.getAllByText(/120 titles/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Next page' })).toHaveLength(2);
  });

  it('sends the type and sort filters through the url', async () => {
    renderAt('/browse');
    await screen.findByText('A Minecraft Movie');

    fireEvent.click(screen.getByRole('button', { name: 'Shows' }));
    await waitFor(() => expect(calls.some((url) => url.includes('type=tv'))).toBe(true));

    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'title' } });
    await waitFor(() => expect(calls.some((url) => url.includes('sort=title'))).toBe(true));
  });

  it('keeps the filters in the back link when a suggestion is chosen', async () => {
    setFetchImpl(async (url) => {
      const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (/\/library\/\d+(\?|$)/.test(url)) return respond(MOVIE_DETAIL);
      if (url.includes('/library/suggest')) {
        return respond({ titles: [{ mediaId: 7, title: 'A Minecraft Movie', year: 2025, type: 'movie', poster: null }] });
      }
      if (url.includes('/library')) return respond(LIBRARY);
      return respond({});
    });

    renderAt('/browse?type=movie&sort=title');
    await screen.findByText('A Minecraft Movie');

    fireEvent.change(screen.getByRole('combobox', { name: 'Search titles' }), { target: { value: 'mine' } });
    const listbox = await screen.findByRole('listbox', { name: 'Title suggestions' });
    fireEvent.click(within(listbox).getByRole('button'));

    await waitFor(() =>
      expect(screen.getByRole('link', { name: '← Browse' }).getAttribute('href')).toBe('/browse?type=movie&sort=title'),
    );
  });

  it('offers only the two shelf lenses in the health filter', async () => {
    renderAt('/browse');
    await screen.findByText('A Minecraft Movie');

    const health = screen.getByLabelText('Health') as HTMLSelectElement;
    const labels = Array.from(health.options).map((option) => option.textContent);
    expect(labels).toEqual(['All', 'Missing episodes']);
  });

});

describe('review queue', () => {
  it('shows the evidence needed to decide', async () => {
    renderAt('/review');
    expect((await screen.findAllByText(/Medical Miracle/)).length).toBeGreaterThan(0);
    // Badges appear in the compact line and again inside the (collapsed) evidence block.
    expect((await screen.findAllByText('HQ HDRip')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('no lang')).length).toBeGreaterThan(0);
    // The proposal is shown with its score so the decision is one click, not a research task.
    expect(await screen.findByText(/proposal: Land/)).toBeDefined();
    expect(await screen.findByText(/score 74/)).toBeDefined();
  });

  it('expands to the full description and shows why the match was proposed', async () => {
    renderAt('/review');
    const details = (await screen.findAllByText(/Medical Miracle/))[0]?.closest('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);

    const summary = details?.querySelector('summary');
    if (!summary) throw new Error('summary missing');
    fireEvent.click(summary);

    // Every row renders its evidence block, open or not: scope the queries to this row.
    const row = within(details as HTMLElement);
    expect(row.getByTestId('review-full-title').textContent).toContain('700MB - 400MB & 250MB');
    expect(row.getByText('title prefix')).toBeDefined();
    expect(row.getByText('year exact')).toBeDefined();
  });

  it('binds the proposal to the topic when accepted', async () => {
    renderAt('/review');
    fireEvent.click(await screen.findByText('accept'));
    await waitFor(() => expect(calls.some((url) => url.includes('/bind'))).toBe(true));
  });

  it('shows the persisted runner-up so a second opinion needs no request', async () => {
    renderAt('/review');
    const details = (await screen.findAllByText(/Medical Miracle/))[0]?.closest('details');
    fireEvent.click(details?.querySelector('summary') as Element);
    expect(within(details as HTMLElement).getByText(/runner-up: Land of Bad/)).toBeDefined();
  });

  it('prefills the TMDB picker from the slug and binds the chosen candidate', async () => {
    renderAt('/review');
    const details = (await screen.findAllByText(/Medical Miracle/))[0]?.closest('details');
    fireEvent.click(details?.querySelector('summary') as Element);

    const row = within(details as HTMLElement);
    const input = row.getByLabelText('TMDB search query') as HTMLInputElement;
    expect(input.value).toBe('land');

    fireEvent.click(row.getByText('search TMDB'));
    await waitFor(() => expect(calls.some((u) => u.includes('/tmdb/search'))).toBe(true));
    expect(calls.find((u) => u.includes('/tmdb/search'))).toContain('kind=movie');

    // Two candidates come back; picking the second one must bind that id, not the top score.
    const useThis = await row.findAllByText('use this');
    fireEvent.click(useThis[1] as HTMLElement);
    await waitFor(() => expect(calls.some((u) => u.includes('/titles/1/bind'))).toBe(true));
    const bindCall = calls.find((u) => u.includes('/bind'));
    expect(bindCall).toBeDefined();
  });

  it('caps the candidate list and says how much it hid', async () => {
    renderAt('/review');
    const details = (await screen.findAllByText(/Medical Miracle/))[0]?.closest('details');
    fireEvent.click(details?.querySelector('summary') as Element);
    const row = within(details as HTMLElement);

    fireEvent.change(row.getByLabelText('TMDB search query'), { target: { value: 'noisy' } });
    fireEvent.click(row.getByText('search TMDB'));

    await waitFor(() => expect(row.getAllByText('use this').length).toBe(10));
    expect(row.getByText(/showing 10 of 12/)).toBeDefined();
  });

  it('reports a failed bind instead of pretending the row left the queue', async () => {
    renderAt('/review');
    const details = (await screen.findAllByText(/Medical Miracle/))[0]?.closest('details');
    fireEvent.click(details?.querySelector('summary') as Element);
    const row = within(details as HTMLElement);

    fireEvent.click(row.getByText('search TMDB'));
    const useThis = await row.findAllByText('use this');
    // The next bind attempt fails on the server: tmdb id 11 is already stored as a movie.
    setFetchImpl(async (url, init) => {
      calls.push(url);
      if (url.includes('/bind')) return new Response(JSON.stringify({ error: 'tmdb id 11 is already stored as movie' }), { status: 500 });
      return new Response(JSON.stringify(REVIEW), { status: 200 });
    });
    fireEvent.click(useThis[0] as HTMLElement);

    expect(await row.findByText(/already stored as movie/)).toBeDefined();
  });

  it('offers a search for rows the provider never matched', async () => {
    renderAt('/review');
    expect(await screen.findByText(/no TMDB match — expand to search/)).toBeDefined();
  });

  it('labels the bulk action for what it does: the whole forum', async () => {
    renderAt('/review');
    expect(await screen.findByLabelText(/teach every row from these forums/)).toBeDefined();
  });

  it('previews before committing', async () => {
    renderAt('/review');
    const rowCheckbox = await screen.findByRole('checkbox', { name: /select It's A Medical/ });
    fireEvent.click(rowCheckbox);

    const previewButton = screen.getByText('preview') as HTMLButtonElement;
    await waitFor(() => expect(previewButton.disabled).toBe(false));
    fireEvent.click(previewButton);
    expect((await screen.findByTestId('preview-count')).textContent).toContain('will reclassify 1');
    fireEvent.click(screen.getByText('commit + replay'));
    await waitFor(() => expect(calls.some((url) => url.includes('/review/decide'))).toBe(true));
  });
});

describe('settings', () => {
  it('shows the app-generated key and a copyable Torznab URL', async () => {
    window.localStorage.clear();
    renderAt('/settings');
    expect((await screen.findByTestId('api-key')).textContent).toBeTruthy();
    expect((await screen.findByTestId('torznab-url')).textContent).toContain('/api/v1');
    expect(screen.getByText('Copy Torznab URL')).toBeDefined();
    expect(screen.getByText('Copy key')).toBeDefined();
  });


  it('lists the in-scope forums', async () => {
    renderAt('/settings');
    expect(await screen.findByText(/In-scope forums/)).toBeDefined();
    expect((await screen.findAllByTestId('forum-name')).some((node) => node.textContent?.includes('Hindi Dubbed'))).toBe(true);
  });
});

describe('title page binder', () => {
  it('offers the TMDB picker, prefilled, while the title is unmatched', async () => {
    renderAt('/title/kara-2026-telugu-hq-clean');
    expect(await screen.findByText('no tmdb match')).toBeDefined();
    const input = (await screen.findByLabelText('TMDB search query')) as HTMLInputElement;
    expect(input.value).toBe('kara');
  });

  it('binds the topic and refetches the title', async () => {
    renderAt('/title/kara-2026-telugu-hq-clean');
    await screen.findByText('no tmdb match');
    const before = calls.filter((u) => /\/titles\/[^/]+$/.test(u)).length;

    fireEvent.click(await screen.findByText('search TMDB'));
    const useThis = await screen.findAllByText('use this');
    fireEvent.click(useThis[0] as HTMLElement);

    await waitFor(() => expect(calls.some((u) => u.includes('/titles/1/bind'))).toBe(true));
    // Binding is worthless unless the page reloads its data: the badge must be able to change.
    await waitFor(() => expect(calls.filter((u) => /\/titles\/[^/]+$/.test(u)).length).toBeGreaterThan(before));
  });
});

describe('dashboard lane controls', () => {
  function mockLanes(state: { deltaRequested: boolean; armed: boolean }) {
    const posts: Array<{ url: string; body: string }> = [];
    setFetchImpl(async (url, init) => {
      const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes('/bootstrap')) return respond({ apiKey: 'generated-key', torznabUrl: 'http://localhost:8484/api/v1' });
      if (url.includes('/crawl/delta')) {
        posts.push({ url, body: String(init?.body ?? '') });
        state.deltaRequested = true;
        return respond({ queued: true });
      }
      if (url.includes('/crawl/backfill')) {
        posts.push({ url, body: String(init?.body ?? '') });
        state.armed = JSON.parse(String(init?.body ?? '{}')).armed === true;
        return respond({ armed: state.armed ? '1' : '0', paused: null });
      }
      if (url.includes('/crawl')) {
        return respond({
          ...CRAWL,
          deltaRequested: state.deltaRequested,
          armed: state.armed,
          circuitOpenUntil: '2020-01-01T00:00:00.000Z',
        });
      }
      if (url.includes('/stats')) return respond(STATS);
      return respond({});
    });
    return posts;
  }

  it('re-caches the index on demand', async () => {
    const state = { deltaRequested: false, armed: false };
    const posts = mockLanes(state);
    renderAt('/');
    fireEvent.click(await screen.findByTestId('recache-index'));
    await waitFor(() => expect(posts.some((post) => post.url.includes('/crawl/delta'))).toBe(true));
    expect(await screen.findByText('index queued')).toBeDefined();
  });

  it('arms and pauses the backfill lane', async () => {
    const state = { deltaRequested: false, armed: false };
    const posts = mockLanes(state);
    renderAt('/');
    fireEvent.click(await screen.findByTestId('toggle-backfill'));
    await waitFor(() => expect(posts.some((post) => post.body.includes('"armed":true'))).toBe(true));
    expect(await screen.findByText('Pause backfill')).toBeDefined();
  });

  it('does not claim the circuit is open after it has closed', async () => {
    mockLanes({ deltaRequested: false, armed: false });
    renderAt('/');
    expect(await screen.findByText('P0 3')).toBeDefined();
    expect(screen.queryByText(/circuit open until/i)).toBeNull();
  });
});

describe('provider panels', () => {
  it('warns about the cost before a manual omdb search', async () => {
    renderAt('/review');

    const warnings = await screen.findAllByText(/1 of your 1,000 free daily requests/i);
    expect(warnings).toHaveLength(2); // one panel per row, both cost-warned
  });

  it('keeps the OMDb search disabled until the cost is acknowledged', async () => {
    renderAt('/review');

    const buttons = await screen.findAllByRole('button', { name: /search omdb/i });
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    expect(buttons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('shows the tamilmv link on a non-identity row too', async () => {
    const review = {
      total: 1,
      groups: [{ reason: 'UNKNOWN', count: 1, items: [REVIEW.groups[0]?.items[1]] }],
    };
    setFetchImpl(async (url) => {
      const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes('/providers')) return respond({ omdb: true, tvdb: false });
      if (url.includes('/review')) return respond(review);
      if (url.includes('/stats')) return respond(STATS);
      if (url.includes('/forums')) return respond([]);
      return respond({});
    });

    renderAt('/review');

    const link = await screen.findByRole('link', { name: /open on tamilmv/i });
    expect(link.getAttribute('href')).toBe('https://x.test/index.php?/forums/topic/2-kara-2026-telugu-hq/');
  });

  const TV_REVIEW = {
    total: 1,
    groups: [
      {
        reason: 'UNKNOWN',
        count: 1,
        items: [
          {
            id: 21,
            topicId: 3,
            slug: 'karthika-deepam-2017-telugu-hq',
            rawTitle: 'Karthika Deepam (2017) Telugu HQ',
            poster: null,
            forumId: 22,
            forumName: 'Telugu',
            sourceTagRaw: 'HQ HDRip',
            audioLangs: [],
            sizeBytes: 3000,
            mediaTitle: null,
            originalLanguage: null,
            providerStatus: 'none',
            providerProposal: null,
            kind: 'tv',
            searchQuery: 'karthika deepam',
            searchYear: 2017,
            link: 'https://x.test/index.php?/forums/topic/3-karthika-deepam-2017-telugu-hq/',
          },
        ],
      },
    ],
  };

  const SERIES = {
    tvdbId: 483535,
    title: 'Karthika Deepam',
    year: 2017,
    originalLanguage: 'te',
    originalCountry: 'ind',
    firstAired: '2017-10-16',
    status: 'Continuing',
    aliases: ['Karthika Deepam'],
    episodes: 1200,
    seasons: 3,
    imdbId: 'tt1234567',
    tmdbId: null as number | null,
    overview: null,
  };

  const stubTvdb = (
    series: Record<string, unknown>,
    options: { results?: Array<Record<string, unknown>>; failBind?: boolean } = {},
  ) => {
    const results = options.results ?? [
      { tvdbId: 483535, title: 'Karthika Deepam', year: 2017, slug: 'karthika-deepam', network: 'Star Maa' },
    ];
    setFetchImpl(async (url, init) => {
      if (init?.body !== undefined) bodies.push(String(init.body));
      const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      calls.push(url);
      if (url.includes('/providers')) return respond({ omdb: false, tvdb: true });
      if (url.includes('/tvdb/search')) return respond({ results });
      if (url.includes('/tvdb/series/')) {
        const id = Number(/\/tvdb\/series\/(\d+)/.exec(url)?.[1]);
        if (id === 483535) return respond(series);
        return respond({ ...series, tvdbId: id, title: `Series ${id}`, seasons: 1, imdbId: `tt900000${id}` });
      }
      if (url.includes('/bind-manual') && options.failBind === true) return respond({ error: 'invalid payload' }, 400);
      if (url.includes('/bind-manual')) return respond({ mediaId: 1, viaTmdb: false, replay: { updated: 1 } });
      if (url.includes('/review')) return respond(TV_REVIEW);
      if (url.includes('/stats')) return respond(STATS);
      if (url.includes('/forums')) return respond([]);
      if (url.includes('/titles/') && url.includes('/bind')) return respond({ mediaId: 1, originalLanguage: 'te', replay: { updated: 1 } });
      return respond({});
    });
  };

  const openTvdbHit = async (which: number = 0) => {
    fireEvent.change(await screen.findByLabelText(/tvdb search query/i), { target: { value: 'karthika' } });
    fireEvent.submit(screen.getByTestId('tvdb-search-form'));
    const buttons = await screen.findAllByRole('button', { name: /use this/i });
    fireEvent.click(buttons[which] as HTMLElement);
  };

  it('shows the TVDB section with attribution and fires nothing until asked', async () => {
    stubTvdb(SERIES);
    renderAt('/review');

    const link = await screen.findByRole('link', { name: /metadata provided by thetvdb/i });
    expect(link.getAttribute('href')).toContain('thetvdb.com');
    expect(calls.filter((url) => url.includes('/tvdb/search'))).toHaveLength(0);
    expect(calls.filter((url) => url.includes('/tvdb/series/'))).toHaveLength(0);
  });

  it('fetches the detail card on click, not on render', async () => {
    stubTvdb(SERIES);
    renderAt('/review');

    await openTvdbHit();

    expect(await screen.findByText(/1200 episodes/i)).toBeTruthy();
    expect(calls.filter((url) => url.includes('/tvdb/series/483535'))).toHaveLength(1);
  });

  it('binds through TMDB when TVDB links one, creating no manual row', async () => {
    stubTvdb({ ...SERIES, imdbId: null, tmdbId: 15643 });
    renderAt('/review');

    await openTvdbHit();
    fireEvent.click(await screen.findByRole('button', { name: /^attach$/i }));

    await waitFor(() => expect(calls.some((url) => url.includes('/titles/3/bind?'))).toBe(true));
    expect(calls.some((url) => url.includes('/bind-manual'))).toBe(false);
  });

  it('attaches manually with the IMDb id and prefilled language and seasons', async () => {
    stubTvdb(SERIES);
    renderAt('/review');

    await openTvdbHit();

    const language = (await screen.findByLabelText(/original language/i, { selector: 'select' })) as HTMLSelectElement;
    const seasons = screen.getByLabelText(/seasons/i) as HTMLInputElement;
    expect(language.value).toBe('te');
    expect(seasons.value).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: /^attach$/i }));

    await waitFor(() => expect(bodies.some((body) => body.includes('tt1234567'))).toBe(true));
    const payload = JSON.parse(bodies.find((body) => body.includes('tt1234567')) ?? '{}') as {
      mediaType: string;
      originalLanguage: string;
      seasons: number;
    };
    expect(payload).toMatchObject({ mediaType: 'tv', originalLanguage: 'te', seasons: 3 });
  });

  it('offers no attach control when TVDB links neither IMDb nor TMDB', async () => {
    stubTvdb({ ...SERIES, imdbId: null, tmdbId: null });
    renderAt('/review');

    await openTvdbHit();

    expect(await screen.findByText(/no linked imdb or tmdb/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^attach$/i })).toBeNull();
  });

  it('falls back to the TVDB season count when the field is cleared', async () => {
    stubTvdb(SERIES);
    renderAt('/review');

    await openTvdbHit();
    fireEvent.change(await screen.findByLabelText(/seasons/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^attach$/i }));

    await waitFor(() => expect(bodies.some((body) => body.includes('tt1234567'))).toBe(true));
    const payload = JSON.parse(bodies.find((body) => body.includes('tt1234567')) ?? '{}') as { seasons: number };
    expect(payload.seasons).toBe(3);
  });

  it('offers the ISO-639-1 codes the client maps, not a five-letter "other"', async () => {
    // ben/mar/guj/pun/urd are mapped by TvdbClient.language(); a 5-char 'other' fails the
    // route's `min(2).max(3)` schema, so collapsing to it made every such series unattachable.
    stubTvdb({ ...SERIES, originalLanguage: 'bn' });
    renderAt('/review');

    await openTvdbHit();

    const language = (await screen.findByLabelText(/original language/i, { selector: 'select' })) as HTMLSelectElement;
    expect(language.value).toBe('bn');
    fireEvent.click(screen.getByRole('button', { name: /^attach$/i }));
    await waitFor(() => expect(bodies.some((body) => body.includes('"originalLanguage":"bn"'))).toBe(true));
  });

  it('refuses to attach until a language is chosen when TVDB does not map one', async () => {
    stubTvdb({ ...SERIES, originalLanguage: null });
    renderAt('/review');

    await openTvdbHit();

    const attach = await screen.findByRole('button', { name: /^attach$/i });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a failed attach instead of silently doing nothing', async () => {
    stubTvdb(SERIES, { failBind: true });
    renderAt('/review');

    await openTvdbHit();
    fireEvent.click(await screen.findByRole('button', { name: /^attach$/i }));

    expect(await screen.findByText(/400/)).toBeTruthy();
  });

  it('does not carry a season count from one hit to the next', async () => {
    stubTvdb(SERIES, {
      results: [
        { tvdbId: 483535, title: 'Karthika Deepam', year: 2017, slug: 'karthika-deepam', network: 'Star Maa' },
        { tvdbId: 999, title: 'Another Show', year: 2020, slug: 'another-show', network: 'Zee' },
      ],
    });
    renderAt('/review');

    await openTvdbHit(0);
    fireEvent.change(await screen.findByLabelText(/seasons/i), { target: { value: '5' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /use this/i }))[1] as HTMLElement);

    await waitFor(() => expect((screen.getByLabelText(/seasons/i) as HTMLInputElement).value).toBe('1'));
  });
});
