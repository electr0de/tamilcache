import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { TitleCard } from '../src/components/TitleCard.js';
import type { LibraryTitle } from '../src/api.js';

const movie: LibraryTitle = {
  mediaId: 7,
  type: 'movie',
  title: 'Sigma',
  year: 2026,
  poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
  backdrop: null,
  voteAverage: 7.9,
  originalLanguage: 'ta',
  audioLangs: ['hindi', 'tamil'],
  resolutions: ['2160p', '1080p'],
  releases: 3,
  latestRelease: '2026-11-01T00:00:00.000Z',
  largestBytes: 12 * 1024 ** 3,
  seasons: null,
  coverage: null,
  noHindi: false,
};

const show: LibraryTitle = {
  ...movie,
  mediaId: 8,
  type: 'tv',
  title: 'Sigma Show',
  seasons: 3,
  coverage: { aired: 22, covered: 14, missing: 8 },
};

describe('TitleCard', () => {
  it('links a movie card to its movie page and shows the rating and best resolution', () => {
    render(
      <MemoryRouter>
        <TitleCard title={movie} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link').getAttribute('href')).toBe('/movie/7');
    expect(screen.getByText('Sigma')).toBeTruthy();
    expect(screen.getByText(/7\.9/)).toBeTruthy();
    expect(screen.getByText(/2160p/)).toBeTruthy();
    expect(screen.getByText('movie')).toBeTruthy();
  });

  it('links a show card to its show page and shows coverage', () => {
    render(
      <MemoryRouter>
        <TitleCard title={show} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link').getAttribute('href')).toBe('/show/8');
    expect(screen.getByText(/14\/22 aired/)).toBeTruthy();
    expect(screen.getByText('series')).toBeTruthy();
  });

  it('says how many episodes are missing when there is a gap', () => {
    render(
      <MemoryRouter>
        <TitleCard title={show} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/8 missing/)).toBeTruthy();
  });

  it('swaps a poster that fails to load for the neutral tile', () => {
    const { container } = render(
      <MemoryRouter>
        <TitleCard title={movie} />
      </MemoryRouter>,
    );

    // `alt=""` makes the poster presentational, so it has no accessible `img` role.
    const poster = container.querySelector('img');
    expect(poster).not.toBeNull();
    fireEvent.error(poster as Element);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText('Sigma').length).toBeGreaterThan(0);
  });

  it('falls back to a title tile when there is no poster', () => {
    render(
      <MemoryRouter>
        <TitleCard title={{ ...movie, poster: null }} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('img')).toBeNull();
    // The placeholder tile burns the title in, and the card repeats it underneath.
    expect(screen.getAllByText('Sigma').length).toBeGreaterThan(0);
  });

});
