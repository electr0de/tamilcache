import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { setApiKey, setFetchImpl } from '../src/api.js';

const RELEASE = {
  id: 1,
  topicId: 1,
  normTitle: 'Sigma.2026.2160p.WEB-DL.Hindi-TMV',
  rawTitle: 'Sigma',
  slug: 'sigma-2026',
  resolution: '2160p',
  sourceTag: 'WEB-DL',
  sourceTagRaw: 'WEB-DL',
  codec: 'x265',
  audioCodecs: 'DD+',
  audioLangs: ['hindi'],
  sizeBytes: 12 * 1024 ** 3,
  infohash: 'a'.repeat(40),
  magnet: 'magnet:?xt=urn:btih:aaa',
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
  tmdbId: 700,
  year: 2026,
  links: [],
};

const MOVIE = {
  media: {
    mediaId: 7,
    type: 'movie',
    title: 'Sigma',
    year: 2026,
    originalLanguage: 'ta',
    imdbId: 'tt123',
    tvdbId: null,
    tmdbId: 700,
    seasons: null,
    poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
    backdrop: null,
    overview: 'A film about a letter.',
    voteAverage: 7.9,
    voteCount: 2400,
    runtime: 138,
    genres: ['Action'],
    status: 'Released',
  },
  availability: 'hindi_ready',
  releases: [RELEASE],
  seasons: null,
  coverage: { aired: 0, covered: 0 },
  missing: [],
};

beforeEach(() => {
  setApiKey('k');
  setFetchImpl(async (url) => {
    const body = url.includes('/library/') ? MOVIE : { total: 0, limit: 48, offset: 0, titles: [] };
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

describe('movie page', () => {
  it('renders the hero, fact rail and releases', async () => {
    renderAt('/movie/7');

    await waitFor(() => expect(screen.getByRole('heading', { name: /Sigma/ })).toBeTruthy());
    expect(screen.getByText('Hindi ready')).toBeTruthy();
    expect(screen.getByText('Action')).toBeTruthy();
    expect(screen.getByText('Released')).toBeTruthy();
    expect(screen.getByText('2h 18m')).toBeTruthy();
    expect(screen.getByText('2160p (1)')).toBeTruthy();
  });

  it('renders the backdrop behind the hero when the provider supplied one', async () => {
    setFetchImpl(async () =>
      new Response(JSON.stringify({ ...MOVIE, media: { ...MOVIE.media, backdrop: 'https://image.tmdb.org/t/p/w780/b.jpg' } }), {
        status: 200,
      }),
    );
    renderAt('/movie/7');
    await waitFor(() => expect(screen.getByTestId('backdrop')).toBeTruthy());
    expect(screen.getByTestId('backdrop').getAttribute('src')).toBe('https://image.tmdb.org/t/p/w780/b.jpg');
  });

  it('omits the rating badge entirely when the provider has no score', async () => {
    setFetchImpl(async () =>
      new Response(JSON.stringify({ ...MOVIE, media: { ...MOVIE.media, voteAverage: null, voteCount: null } }), { status: 200 }),
    );
    renderAt('/movie/7');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Sigma/ })).toBeTruthy());
    expect(screen.queryByText(/★/)).toBeNull();
  });

  it('links to TMDB with the movie namespace', async () => {
    renderAt('/movie/7');
    await waitFor(() => expect(screen.getByRole('link', { name: /TMDB/ })).toBeTruthy());
    expect(screen.getByRole('link', { name: /TMDB/ }).getAttribute('href')).toBe('https://www.themoviedb.org/movie/700');
    expect(screen.getByRole('link', { name: /IMDb/ }).getAttribute('href')).toBe('https://www.imdb.com/title/tt123/');
  });

  it('hides provider links for a manual bind with no real tmdb id', async () => {
    setFetchImpl(async () => new Response(JSON.stringify({ ...MOVIE, media: { ...MOVIE.media, tmdbId: null, imdbId: null } }), { status: 200 }));
    renderAt('/movie/7');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Sigma/ })).toBeTruthy());
    expect(screen.queryByRole('link', { name: /TMDB/ })).toBeNull();
  });

  it('shows an error card for an unknown title', async () => {
    setFetchImpl(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    renderAt('/movie/999');
    expect(await screen.findByText(/not found|no such title/i)).toBeTruthy();
  });
});

describe('movie page back link', () => {
  it('returns to the filtered browse url it came from', async () => {
    renderAt('/browse?type=movie&sort=title');
    await waitFor(() => expect(screen.getByText(/No titles|Nothing cached/)).toBeTruthy());
  });

  it('keeps a plain browse fallback on a direct visit', async () => {
    renderAt('/movie/7');
    await waitFor(() => expect(screen.getByRole('link', { name: /Browse/ })).toBeTruthy());
    expect(screen.getByRole('link', { name: /Browse/ }).getAttribute('href')).toBe('/browse');
    fireEvent.click(screen.getByRole('link', { name: /Browse/ }));
  });
});
