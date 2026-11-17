import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchBox } from '../src/components/SearchBox.js';
import { setApiKey, setFetchImpl } from '../src/api.js';

function Harness({ onCommit }: { onCommit: (value: string) => void }) {
  const location = useLocation();
  return (
    <>
      <SearchBox value="" onCommit={onCommit} />
      <div data-testid="path">{`${location.pathname}${location.search}`}</div>
    </>
  );
}

function renderBox(onCommit: (value: string) => void) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/browse']}>
        <Harness onCommit={onCommit} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setApiKey('k');
  setFetchImpl(async (url) => {
    const body = url.includes('/suggest')
      ? { titles: [{ mediaId: 3, title: 'Spider-Man', year: 2002, type: 'movie', poster: null }] }
      : { total: 0, limit: 48, offset: 0, titles: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
});

describe('SearchBox', () => {
  it('shows suggestions and commits the query on Enter', async () => {
    const onCommit = vi.fn();
    renderBox(onCommit);
    const input = screen.getByRole('combobox', { name: 'Search titles' });

    fireEvent.change(input, { target: { value: 'spid' } });
    await waitFor(() => expect(screen.getByText('Spider-Man')).toBeTruthy());

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('spid');
  });

  it('opens the title page when a suggestion is chosen with the keyboard', async () => {
    renderBox(vi.fn());
    const input = screen.getByRole('combobox', { name: 'Search titles' });

    fireEvent.change(input, { target: { value: 'spid' } });
    await waitFor(() => expect(screen.getByText('Spider-Man')).toBeTruthy());

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/movie/3'));
  });

  it('opens the title page when a suggestion is clicked', async () => {
    renderBox(vi.fn());
    fireEvent.change(screen.getByRole('combobox', { name: 'Search titles' }), { target: { value: 'spid' } });
    await waitFor(() => expect(screen.getByText('Spider-Man')).toBeTruthy());

    fireEvent.click(screen.getByText('Spider-Man'));

    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/movie/3'));
  });

  it('does not query below two characters', async () => {
    const calls: string[] = [];
    setFetchImpl(async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ titles: [] }), { status: 200 });
    });
    renderBox(vi.fn());

    fireEvent.change(screen.getByRole('combobox', { name: 'Search titles' }), { target: { value: 's' } });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(calls.filter((url) => url.includes('/suggest'))).toEqual([]);
  });
});
