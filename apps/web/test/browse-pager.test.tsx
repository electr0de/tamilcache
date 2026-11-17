import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { setApiKey, setFetchImpl } from '../src/api.js';

// PAGE_SIZE is 48, so 96 titles is exactly two pages — the smallest fixture with a live Next.
beforeEach(() => {
  setApiKey('k');
  setFetchImpl(async (url) => {
    const body = url.includes('/library')
      ? { total: 96, limit: 48, offset: Number(new URL(url, 'http://x').searchParams.get('offset') ?? '0'), titles: [] }
      : { apiKey: 'k', torznabUrl: 'http://localhost:8484/api/v1' };
    return new Response(JSON.stringify(body), { status: 200 });
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

describe('browse pagination', () => {
  it('renders the pager above and below the grid', async () => {
    renderAt('/browse');

    expect(await screen.findAllByText('Page 1 of 2')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Previous page' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Next page' })).toHaveLength(2);
  });

  it('advances the page from the top pager', async () => {
    renderAt('/browse');
    await screen.findAllByText('Page 1 of 2');

    fireEvent.click(screen.getAllByRole('button', { name: 'Next page' })[0] as HTMLElement);

    expect(await screen.findAllByText('Page 2 of 2')).toHaveLength(2);
  });
});
