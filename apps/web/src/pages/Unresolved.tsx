import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type UnresolvedCounts, type UnresolvedParams, type UnresolvedRow } from '../api.js';
import { ErrorNote } from '../components/ui.js';

const RESOLUTIONS = ['1080p', '1440p', '2160p'] as const;
const PAGE_SIZE = 50;

/**
 * A tag per state, because the queue is four different jobs in one list: a gated post needs a
 * human to solve the shortener, a `no_link` post needs nothing, and a `parse_failed` one is our
 * bug — showing them all at once is only useful if the row says which is which.
 */
const TAG: Record<UnresolvedRow['status'], { label: string; className: string }> = {
  external: { label: 'gated', className: 'bg-amber-500/15 text-amber-300' },
  no_link: { label: 'nothing linked', className: 'bg-neutral-700/40 text-neutral-300' },
  parse_failed: { label: 'parser missed', className: 'bg-rose-500/15 text-rose-300' },
  gone: { label: 'gone', className: 'bg-rose-700/20 text-rose-200' },
  below_floor: { label: 'below 1080p', className: 'bg-neutral-700/40 text-neutral-300' },
};

/** Only what the feed cannot derive on its own: the magnet, and the quality it must be ranked at. */
function ResolveForm({ row, onDone }: { row: UnresolvedRow; onDone: () => void }) {
  const [magnet, setMagnet] = useState('');
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>('1080p');
  const [sizeGb, setSizeGb] = useState('');
  const [sourceTag, setSourceTag] = useState('WEB-DL');
  const submit = useMutation({
    mutationFn: () =>
      api.submitMagnet(row.id, {
        magnet,
        resolution,
        sizeBytes: Math.round(Number(sizeGb) * 1024 ** 3),
        sourceTag,
        audioLangs: ['hindi'],
      }),
    onSuccess: onDone,
  });

  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col text-xs text-neutral-400">
        magnet
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-100"
          value={magnet}
          onChange={(event) => setMagnet(event.target.value)}
          placeholder="magnet:?xt=urn:btih:…"
          aria-label={`magnet for ${row.rawTitle}`}
        />
      </label>
      <label className="flex flex-col text-xs text-neutral-400">
        resolution
        <select
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
          value={resolution}
          onChange={(event) => setResolution(event.target.value as (typeof RESOLUTIONS)[number])}
          aria-label="resolution"
        >
          {RESOLUTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs text-neutral-400">
        size (GB)
        <input
          className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
          value={sizeGb}
          onChange={(event) => setSizeGb(event.target.value)}
          inputMode="decimal"
          aria-label="size in GB"
        />
      </label>
      <label className="flex flex-col text-xs text-neutral-400">
        source
        <input
          className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
          value={sourceTag}
          onChange={(event) => setSourceTag(event.target.value)}
          aria-label="source tag"
        />
      </label>
      <button
        type="submit"
        disabled={submit.isPending || magnet === '' || sizeGb === ''}
        className="rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-neutral-950 disabled:opacity-40"
      >
        {submit.isPending ? 'saving…' : 'resolve'}
      </button>
      <ErrorNote error={submit.error} />
    </form>
  );
}

/**
 * The queue of posts with no servable variant. Every other screen starts `FROM variants`, so this
 * one starts from topics: a gated or deleted post has no variant at all.
 *
 * `fixedStatus` turns the same table into the gone-only view used by the Dead links page — one
 * implementation, two entry points.
 */
export function Unresolved({ fixedStatus }: { fixedStatus?: UnresolvedRow['status'] } = {}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<UnresolvedParams['status']>(fixedStatus ?? 'all');
  const [search, setSearch] = useState('');
  const [forum, setForum] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);

  const params: UnresolvedParams = useMemo(
    () => ({ status, q: search.trim() || undefined, forum, page, limit: PAGE_SIZE }),
    [status, search, forum, page],
  );
  const list = useQuery({
    queryKey: ['unresolved', params],
    queryFn: () => api.unresolved(params),
  });

  // Boards the current result set actually has rows from: a filter listing empty boards is noise.
  const boards = useMemo(() => {
    const seen = new Map<number, string>();
    for (const row of list.data?.rows ?? []) seen.set(row.forumId, row.forumName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [list.data]);

  const recheck = useMutation({
    mutationFn: (topicId: number) => api.recheck(topicId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unresolved'] }),
  });

  const refresh = () => {
    setOpen(null);
    void queryClient.invalidateQueries({ queryKey: ['unresolved'] });
  };

  const counts: UnresolvedCounts | undefined = list.data?.counts;
  const total = list.data?.total ?? 0;
  const pages = list.data?.pages ?? 1;
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);

  return (
    <section className="space-y-3">
      <header className="space-y-2">
        <div>
          <h1 className="text-lg font-semibold">{fixedStatus === 'gone' ? 'Dead links' : 'Unresolved'}</h1>
          <p className="text-sm text-neutral-400">
            {fixedStatus === 'gone'
              ? 'The topic is gone from the site (404/410). Recheck queues one fetch.'
              : 'No magnet was published. Solve the gate and paste the magnet, or open the post and watch it there.'}
          </p>
        </div>
        {counts && fixedStatus === undefined ? (
          <p className="text-xs text-neutral-500" aria-label="counts by state">
            gated {counts.external.toLocaleString()} · nothing linked {counts.no_link.toLocaleString()} · parser
            missed {counts.parse_failed.toLocaleString()} · gone {counts.gone.toLocaleString()}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
            placeholder="search titles…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            aria-label="search unresolved"
          />
          {fixedStatus === undefined ? (
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as UnresolvedParams['status']);
                setPage(1);
              }}
              aria-label="status filter"
            >
              <option value="all">all states</option>
              <option value="external">gated</option>
              <option value="no_link">nothing linked</option>
              <option value="parse_failed">parser missed</option>
              <option value="gone">gone</option>
              <option value="below_floor">below 1080p</option>
            </select>
          ) : null}
          <select
            className="max-w-56 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
            value={forum ?? ''}
            onChange={(event) => {
              setForum(event.target.value === '' ? undefined : Number(event.target.value));
              setPage(1);
            }}
            aria-label="board filter"
          >
            <option value="">all boards</option>
            {boards.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-neutral-500">
            showing {first}–{last} of {total.toLocaleString()}
          </span>
          <button
            type="button"
            className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            ← prev
          </button>
          <span className="text-xs text-neutral-400">
            {page} / {pages}
          </span>
          <button
            type="button"
            className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 disabled:opacity-40"
            disabled={page >= pages}
            onClick={() => setPage((current) => Math.min(pages, current + 1))}
          >
            next →
          </button>
        </div>
      </header>

      <ErrorNote error={list.error} />
      {list.data && list.data.rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {fixedStatus === 'gone' ? 'No dead links.' : 'Nothing to resolve.'}
        </p>
      ) : null}

      <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
        {(list.data?.rows ?? []).map((row) => (
          <li key={row.id} className="p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${TAG[row.status].className}`}>
                    {TAG[row.status].label}
                  </span>
                  <p className="truncate text-sm text-neutral-100" title={row.rawTitle}>
                    {row.rawTitle}
                  </p>
                </div>
                <p className="text-xs text-neutral-500">
                  {row.forumName} · {row.views ?? 0} views · seen {row.lastSeenAt.slice(0, 10)}
                </p>
                {row.links.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-2 text-xs">
                    {row.links.map((link) => (
                      <a
                        key={link.url}
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded bg-neutral-800 px-2 py-0.5 text-sky-300 hover:text-sky-200"
                      >
                        {link.label} ↗
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                {row.status === 'external' ? (
                  <button
                    type="button"
                    onClick={() => setOpen(open === row.id ? null : row.id)}
                    className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200"
                  >
                    {open === row.id ? 'cancel' : 'resolve'}
                  </button>
                ) : null}
                {row.status === 'gone' || row.status === 'parse_failed' ? (
                  <button
                    type="button"
                    className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200"
                    disabled={recheck.isPending}
                    onClick={() => recheck.mutate(row.id)}
                  >
                    recheck
                  </button>
                ) : null}
                <a
                  href={`${row.baseUrl}/index.php?/forums/topic/${row.sourceTopicId}-${row.slug}/`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200"
                >
                  open post
                </a>
              </div>
            </div>
            {open === row.id ? <ResolveForm row={row} onDone={refresh} /> : null}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-end gap-2 text-xs text-neutral-500">
        <button
          type="button"
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 disabled:opacity-40"
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          ← prev
        </button>
        <span>
          {page} / {pages}
        </span>
        <button
          type="button"
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 disabled:opacity-40"
          disabled={page >= pages}
          onClick={() => setPage((current) => Math.min(pages, current + 1))}
        >
          next →
        </button>
      </div>
    </section>
  );
}
