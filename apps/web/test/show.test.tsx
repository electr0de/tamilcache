import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { setApiKey, setFetchImpl } from '../src/api.js';

const RELEASE = {
  id: 1,
  topicId: 1,
  normTitle: 'Sigma.Show.S01.1080p.WEB-DL.Hindi-TMV',
  rawTitle: 'Sigma Show',
  slug: 'sigma-show',
  resolution: '1080p',
  sourceTag: 'WEB-DL',
  sourceTagRaw: 'WEB-DL',
  codec: 'x264',
  audioCodecs: 'AAC',
  audioLangs: ['hindi'],
  sizeBytes: 4 * 1024 ** 3,
  infohash: 'b'.repeat(40),
  magnet: 'magnet:?xt=urn:btih:bbb',
  torrentUrl: null,
  season: 1,
  epFrom: 1,
  epTo: 2,
  isPack: true,
  categoryId: 5030,
  qualityRank: 1020,
  decision: 'hindi_dubbed',
  reviewReason: null,
  isPreferred: true,
  forumName: 'Hindi Dubbed',
  poster: null,
  tmdbId: 800,
  year: 2024,
  publishedAt: '2026-11-01T00:00:00.000Z',
  links: [],
};

const SHOW = {
  media: {
    mediaId: 8,
    type: 'tv',
    title: 'Sigma Show',
    year: 2024,
    originalLanguage: 'ta',
    imdbId: null,
    tvdbId: 55,
    tmdbId: 800,
    seasons: 2,
    poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
    backdrop: null,
    overview: null,
    voteAverage: 8.1,
    voteCount: 900,
    runtime: 45,
    genres: ['Drama'],
    status: 'Returning Series',
  },
  availability: 'hindi_ready',
  releases: [RELEASE],
  seasons: [
    {
      season: 1,
      aired: 3,
      covered: 2,
      episodes: [
        { season: 1, episode: 1, airDate: '2024-01-01', name: 'One', aired: true, covered: true },
        { season: 1, episode: 2, airDate: '2024-01-08', name: 'Two', aired: true, covered: true },
        { season: 1, episode: 3, airDate: '2024-01-15', name: 'Three', aired: true, covered: false },
        { season: 1, episode: 4, airDate: '2099-01-01', name: 'Four', aired: false, covered: false },
      ],
    },
    {
      season: 0,
      aired: 1,
      covered: 0,
      episodes: [{ season: 0, episode: 1, airDate: '2023-12-01', name: 'Featurette', aired: true, covered: false }],
    },
  ],
  coverage: { aired: 3, covered: 2 },
  missing: [{ season: 1, episode: 3, airDate: '2024-01-15', name: 'Three' }],
};

beforeEach(() => {
  setApiKey('k');
  setFetchImpl(async (url) => {
    const body = url.includes('/library/') ? SHOW : { total: 0, limit: 48, offset: 0, titles: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
});

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('show page', () => {
  it('shows the overall coverage and the missing line', async () => {
    renderAt('/show/8');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Sigma Show/ })).toBeTruthy());

    expect(screen.getByText(/2 of 3 aired episodes cached/)).toBeTruthy();
    expect(screen.getByText(/Missing S01 E03/)).toBeTruthy();
    expect(screen.getByText(/Returning Series/)).toBeTruthy();
  });

  it('expands a season into episode chips with three states and puts specials last', async () => {
    renderAt('/show/8');
    await waitFor(() => expect(screen.getByRole('button', { name: /Season 1/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Season 1/ }));

    await waitFor(() => expect(screen.getByText('E01')).toBeTruthy());
    expect(screen.getByText('E01').getAttribute('data-state')).toBe('covered');
    expect(screen.getByText('E03').getAttribute('data-state')).toBe('missing');
    expect(screen.getByText('E04').getAttribute('data-state')).toBe('unaired');

    const seasonButtons = screen.getAllByRole('button', { name: /Season|Specials/ });
    expect(seasonButtons.at(-1)?.textContent).toMatch(/Specials/);
  });

  it('groups releases under their season with a coverage badge', async () => {
    renderAt('/show/8');
    await waitFor(() => expect(screen.getByText('Season 1 releases')).toBeTruthy());
    expect(screen.getByText(/S01 E01–E02/)).toBeTruthy();
  });

  it('says the episode list is unavailable when the provider gave none', async () => {
    setFetchImpl(async () =>
      new Response(JSON.stringify({ ...SHOW, seasons: null, coverage: { aired: 0, covered: 0 }, missing: [] }), { status: 200 }),
    );
    renderAt('/show/8');
    await waitFor(() => expect(screen.getByText(/episode list unavailable/i)).toBeTruthy());
  });
});
