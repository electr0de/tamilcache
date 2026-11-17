import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type LogRow } from '../api.js';
import { Badge, Empty, ErrorNote } from '../components/ui.js';

const LEVELS = ['', 'error', 'warn', 'info', 'debug'] as const;
const CLASSES = ['', 'audit', 'diag'] as const;
const SOURCES = ['', 'worker', 'api'] as const;
const SCOPES = [
  '',
  'boot',
  'crawl',
  'queue',
  'http',
  'parse',
  'persist',
  'provider',
  'state',
  'torznab',
  'auth',
  'api',
  'review',
  'curation',
] as const;

const LEVEL_HELP = [
  ['error', 'something died or the loop was interrupted'],
  ['warn', 'retried, rejected, or parsed to nothing'],
  ['info', 'a lifecycle milestone worth remembering'],
  ['debug', 'per-request chatter; only when turned on'],
] as const;

function levelTone(level: LogRow['level']): 'red' | 'amber' | 'green' | 'default' {
  if (level === 'error') return 'red';
  if (level === 'warn') return 'amber';
  if (level === 'info') return 'green';
  return 'default';
}

/** Reads filters out of the URL so every view is linkable and shareable. */
function filtersFrom(params: URLSearchParams): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const key of ['level', 'class', 'scope', 'source', 'q', 'url', 'runId', 'taskId', 'forumId', 'since']) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

export function Logs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [expanded, setExpanded] = useState<number | null>(null);
  const filters = filtersFrom(searchParams);

  const logs = useInfiniteQuery({
    queryKey: ['logs', filters],
    queryFn: ({ pageParam }) => api.logs({ ...filters, limit: 200, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    // Follow mode is the only thing that polls; a static view costs one request.
    refetchInterval: searchParams.get('follow') === '1' ? 5000 : false,
  });

  const rows = logs.data?.pages.flatMap((page) => page.rows) ?? [];
  const total = logs.data?.pages[0]?.total ?? 0;

  const summary = useQuery({
    queryKey: ['logs', 'summary'],
    queryFn: () => api.logsSummary(),
    enabled: Boolean(logs.data),
  });

  function update(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  const byLevel = summary.data?.byLevel ?? {};
  const hasRows = rows.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Logs</h1>
          <p className="text-xs text-neutral-500">
            Pipeline = the machine · Integration = the outside world · Human = the people
          </p>
        </div>
        <details className="text-xs text-neutral-400">
          <summary className="cursor-pointer select-none">What do the levels mean?</summary>
          <ul className="mt-2 space-y-1 rounded border border-neutral-800 bg-neutral-900 p-2">
            {LEVEL_HELP.map(([level, meaning]) => (
              <li key={level}>
                <span className="font-mono text-neutral-200">{level}</span> — {meaning}
              </li>
            ))}
          </ul>
        </details>
      </div>

      <div className="grid gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-sm md:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Errors 24h</div>
          <div className="text-xl font-semibold text-rose-400">{byLevel['error'] ?? 0}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Warns 24h</div>
          <div className="text-xl font-semibold text-amber-400">{byLevel['warn'] ?? 0}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Audit rows</div>
          <div className="text-xl font-semibold text-neutral-100">{summary.data?.auditRows ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Diag rows</div>
          <div className="text-xl font-semibold text-neutral-100">{summary.data?.diagRows ?? '—'}</div>
        </div>
      </div>

      <div className="grid gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3 md:grid-cols-4">
        <label className="text-xs text-neutral-400">
          Level
          <select
            aria-label="Level"
            value={filters['level'] ?? ''}
            onChange={(event) => update('level', event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
          >
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {level === '' ? 'all levels' : level}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-neutral-400">
          Class
          <select
            aria-label="Class"
            value={filters['class'] ?? ''}
            onChange={(event) => update('class', event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
          >
            {CLASSES.map((klass) => (
              <option key={klass} value={klass}>
                {klass === '' ? 'audit + diag' : klass}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-neutral-400">
          Scope
          <select
            aria-label="Scope"
            value={filters['scope'] ?? ''}
            onChange={(event) => update('scope', event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
          >
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope === '' ? 'all scopes' : scope}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-neutral-400">
          Source
          <select
            aria-label="Source"
            value={filters['source'] ?? ''}
            onChange={(event) => update('source', event.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
          >
            {SOURCES.map((source) => (
              <option key={source} value={source}>
                {source === '' ? 'worker + api' : source}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-neutral-400 md:col-span-2">
          Search message / event / url
          <input
            aria-label="Search"
            value={filters['q'] ?? ''}
            onChange={(event) => update('q', event.target.value)}
            placeholder="task.dead, 404, adaikalam"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
          />
        </label>
        <label className="text-xs text-neutral-400 md:col-span-2">
          URL contains
          <input
            aria-label="URL"
            value={filters['url'] ?? ''}
            onChange={(event) => update('url', event.target.value)}
            placeholder="https://www.1tamilmv.io/…"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100"
          />
        </label>
      </div>

      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>
          {logs.data ? `${rows.length} shown · ${total} matching` : 'loading…'}
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={searchParams.get('follow') === '1'}
            onChange={(event) => update('follow', event.target.checked ? '1' : '')}
          />
          Follow
        </label>
      </div>

      <ErrorNote error={logs.error} />

      {hasRows ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-900 text-[11px] uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2">Level</th>
                <th className="px-2 py-2">Scope</th>
                <th className="px-2 py-2">Event</th>
                <th className="px-2 py-2">Message</th>
                <th className="px-2 py-2">Correlation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  className="cursor-pointer border-t border-neutral-900 align-top hover:bg-neutral-900/60"
                >
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-neutral-500">
                    {new Date(row.ts).toLocaleString()}
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={levelTone(row.level)}>{row.level}</Badge>
                    {row.class === 'audit' ? <Badge tone="amber">audit</Badge> : null}
                  </td>
                  <td className="px-2 py-2 font-mono text-neutral-400">{row.scope}</td>
                  <td className="px-2 py-2 font-mono text-neutral-300">{row.event}</td>
                  <td className="px-2 py-2 text-neutral-200">
                    {row.message}
                    {expanded === row.id && row.detail ? (
                      <pre className="mt-2 max-w-xl overflow-x-auto rounded bg-neutral-950 p-2 text-[11px] text-neutral-400">
                        {row.detail}
                      </pre>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-col gap-0.5">
                      {row.url ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          className="truncate font-mono text-[11px] text-amber-400 underline decoration-neutral-700 hover:text-amber-300"
                          title={row.url}
                        >
                          {row.url}
                        </a>
                      ) : null}
                      <div className="flex flex-wrap gap-1 font-mono text-[10px] text-neutral-500">
                        {row.taskId !== null ? <span>task {row.taskId}</span> : null}
                        {row.runId !== null ? <span>run {row.runId}</span> : null}
                        {row.forumId !== null ? <span>forum {row.forumId}</span> : null}
                        {row.variantId !== null ? <span>variant {row.variantId}</span> : null}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.hasNextPage ? (
            <div className="flex justify-center border-t border-neutral-800 p-2">
              <button
                type="button"
                onClick={() => void logs.fetchNextPage()}
                disabled={logs.isFetchingNextPage}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                {logs.isFetchingNextPage ? 'Loading…' : 'Load older'}
              </button>
            </div>
          ) : null}
        </div>
      ) : logs.isLoading ? (
        <Empty>Loading logs…</Empty>
      ) : (
        <Empty>No log rows match these filters.</Empty>
      )}
    </div>
  );
}
