import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setApiKey, setFetchImpl } from '../src/api.js';
import { Logs } from '../src/pages/Logs.js';

const ROWS = [
  {
    id: 2,
    ts: '2026-11-10T09:00:02.000Z',
    source: 'worker',
    level: 'error',
    class: 'diag',
    scope: 'queue',
    event: 'task.dead',
    message: 'gave up after 5 attempts: http 404',
    url: 'https://www.1tamilmv.io/index.php?/forums/topic/200872-adaikalam-2026/',
    taskId: 7,
    runId: 3,
    forumId: null,
    variantId: null,
    detail: '{"reason":"http 404","attempts":5}',
  },
  {
    id: 1,
    ts: '2026-11-10T09:00:01.000Z',
    source: 'api',
    level: 'info',
    class: 'audit',
    scope: 'review',
    event: 'decide',
    message: 'review decision: hindi_dubbed on 1 variant(s)',
    url: null,
    taskId: null,
    runId: null,
    forumId: null,
    variantId: null,
    detail: '{"actor":"web"}',
  },
];

let requested: string[] = [];

function renderLogs(initialPath = '/logs') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Logs />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requested = [];
  setApiKey('k');
  setFetchImpl(async (url) => {
    requested.push(url);
    return new Response(JSON.stringify({ rows: ROWS, total: ROWS.length, nextOffset: null }), { status: 200 });
  });
});

afterEach(() => {
  cleanup();
});

describe('Logs page', () => {
  it('renders a row with its level, scope and message', async () => {
    renderLogs();
    expect(await screen.findByText(/gave up after 5 attempts/)).toBeTruthy();
    expect(screen.getByText('task.dead')).toBeTruthy();
    // `queue` also appears as a <select> option, so scope the query to the table cell.
    expect(screen.getByText('queue', { selector: 'td' })).toBeTruthy();
  });

  it('renders the url as a clickable absolute link, host included', async () => {
    renderLogs();
    const link = await screen.findByRole('link', { name: /1tamilmv/ });
    expect(link.getAttribute('href')).toBe(ROWS[0]!.url);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('sends the level filter to the api when changed', async () => {
    renderLogs();
    await screen.findByText(/gave up after 5 attempts/);
    fireEvent.change(screen.getByLabelText(/level/i), { target: { value: 'warn' } });
    await waitFor(() => expect(requested.some((url) => url.includes('level=warn'))).toBe(true));
  });

  it('pre-fills filters from a deep link and keeps the audit class visible', async () => {
    renderLogs('/logs?level=error&url=https%3A%2F%2Fwww.1tamilmv.io%2Fx');
    await waitFor(() => expect(requested[0]).toContain('url=https%3A%2F%2Fwww.1tamilmv.io%2Fx'));
    expect(await screen.findByText(/review decision/)).toBeTruthy();
  });

  it('expands a row to reveal its detail json', async () => {
    renderLogs();
    fireEvent.click(await screen.findByText(/gave up after 5 attempts/));
    expect(await screen.findByText(/"reason":"http 404"/)).toBeTruthy();
  });
});

describe('pagination', () => {
  it('loads older rows by offset when the api reports a next page', async () => {
    setFetchImpl(async (url) => {
      requested.push(url);
      if (url.includes('offset=1')) {
        return new Response(
          JSON.stringify({ rows: [{ ...ROWS[0], id: 3, message: 'older row' }], total: 2, nextOffset: null }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ rows: [ROWS[0]], total: 2, nextOffset: 1 }), { status: 200 });
    });

    renderLogs();
    expect(await screen.findByText(/gave up after 5 attempts/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /load older/i }));
    expect(await screen.findByText('older row')).toBeTruthy();
    expect(requested.some((url) => url.includes('offset=1'))).toBe(true);
  });
});
