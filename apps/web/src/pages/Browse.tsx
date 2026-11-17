import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatBytes, type Variant } from '../api.js';
import { SearchBox } from '../components/SearchBox.js';
import { TitleCard } from '../components/TitleCard.js';
import { Badge, Empty, ErrorNote } from '../components/ui.js';

const PAGE_SIZE = 48;

const TYPES = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'Shows' },
];

const QUALITIES = ['', '2160p', '1440p', '1080p'];

/**
 * The shelf has two lenses: what you have, and what is incomplete. The `no_hindi` and `unmatched`
 * lanes still exist in the API but belong to the Review queue, not to a browse screen.
 */
const HEALTHS = [
  { value: 'all', label: 'All' },
  { value: 'missing', label: 'Missing episodes' },
];

const SORTS = [
  { value: 'latest', label: 'Latest release' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'coverage', label: 'Most missing' },
];

function decisionTone(decision: string): 'green' | 'amber' | 'red' | 'default' {
  if (decision === 'hindi_dubbed' || decision === 'hindi_original') return 'green';
  if (decision === 'unknown') return 'amber';
  if (decision === 'not_hindi') return 'red';
  return 'default';
}

/**
 * One release row. Shared with the release page (`Title.tsx`), where a card cannot be built
 * because the provider never identified the title.
 */
export function VariantRow({ variant }: { variant: Variant }) {
  const [copied, setCopied] = useState(false);

  async function copyMagnet() {
    if (!variant.magnet) return;
    await navigator.clipboard.writeText(variant.magnet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="grid gap-2 border-b border-neutral-900 px-3 py-4 last:border-0 md:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="truncate text-sm text-neutral-200" title={variant.normTitle ?? variant.rawTitle}>
          {variant.normTitle ?? variant.rawTitle}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
          <Badge tone={decisionTone(variant.decision)}>{variant.decision}</Badge>
          {variant.resolution ? <Badge>{variant.resolution}</Badge> : <Badge tone="amber">no res</Badge>}
          {variant.isPreferred ? <Badge tone="green">best</Badge> : <Badge>alt</Badge>}
          <Badge>{variant.sourceTag}</Badge>
          {variant.codec ? <Badge>{variant.codec}</Badge> : null}
          {variant.audioLangs.length > 0 ? <Badge>{variant.audioLangs.join(' / ')}</Badge> : null}
          <span>{formatBytes(variant.sizeBytes)}</span>
          <span className="text-neutral-600">{variant.forumName}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {variant.magnet ? (
          <button
            type="button"
            onClick={copyMagnet}
            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-700"
          >
            {copied ? 'copied' : 'magnet'}
          </button>
        ) : (
          <span className="text-xs text-neutral-600">no magnet</span>
        )}
        {variant.links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-700"
            title={link.kind}
          >
            {link.kind === 'gdrive' ? 'drive' : link.kind}
          </a>
        ))}
        <Link
          to={`/title/${encodeURIComponent(variant.slug)}`}
          className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-700"
        >
          detail
        </Link>
      </div>
    </div>
  );
}

/**
 * Rendered twice — above and below the grid — because the grid is eight rows deep on a wide screen
 * and the only page control used to sit at the far end of it.
 */
function Pager({
  page,
  totalPages,
  total,
  releases,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  releases: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const buttonClass =
    'rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 transition enabled:hover:border-neutral-600 enabled:hover:bg-neutral-800 disabled:opacity-40';

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-sm text-neutral-400">
        {total} titles · {releases} releases on this page
      </div>
      <div className="flex items-center gap-3">
        <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={onPrev} className={buttonClass}>
          ← Prev
        </button>
        <span className="text-sm text-neutral-300">
          Page {page} of {totalPages}
        </span>
        <button type="button" aria-label="Next page" disabled={page >= totalPages} onClick={onNext} className={buttonClass}>
          Next →
        </button>
      </div>
    </div>
  );
}

export function Browse() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? 'all';
  const q = params.get('q') ?? '';
  const quality = params.get('quality') ?? '';
  const health = params.get('health') ?? 'all';
  const sort = params.get('sort') ?? 'latest';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const result = useQuery({
    queryKey: ['library', type, q, quality, health, sort, page],
    queryFn: () => api.library({ type, q, quality, health, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  });

  // A filter change can leave `page` beyond the last one; the server clamps the offset, but the
  // URL must not keep claiming page 7 of 1.
  useEffect(() => {
    if (!result.data) return;
    const lastPage = Math.max(1, Math.ceil(result.data.total / PAGE_SIZE));
    if (page > lastPage) update('page', lastPage > 1 ? String(lastPage) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.data, page]);

  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '' || (key === 'page' && value === '1')) next.delete(key);
    else next.set(key, value);
    // Any filter change invalidates the current page number.
    if (key !== 'page') next.delete('page');
    setParams(next);
  }

  const totalPages = Math.max(1, Math.ceil((result.data?.total ?? 0) / PAGE_SIZE));
  const titles = result.data?.titles ?? [];
  const releases = titles.reduce((sum, title) => sum + title.releases, 0);

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 bg-neutral-950/95 px-4 py-2 backdrop-blur">
        <SearchBox value={q} onCommit={(value) => update('q', value)} />

        <div className="flex overflow-hidden rounded border border-neutral-800">
          {TYPES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => update('type', option.value === 'all' ? '' : option.value)}
              className={`px-2.5 py-1.5 text-xs ${
                type === option.value ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-400 hover:text-neutral-100'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="text-[11px] text-neutral-500" htmlFor="quality">
          Quality
        </label>
        <select
          id="quality"
          value={quality}
          onChange={(event) => update('quality', event.target.value)}
          className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs"
        >
          {QUALITIES.map((value) => (
            <option key={value || 'any'} value={value}>
              {value || 'Any'}
            </option>
          ))}
        </select>

        <label className="text-[11px] text-neutral-500" htmlFor="health">
          Health
        </label>
        <select
          id="health"
          value={health}
          onChange={(event) => update('health', event.target.value)}
          className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs"
        >
          {HEALTHS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="text-[11px] text-neutral-500" htmlFor="sort">
          Sort
        </label>
        <select
          id="sort"
          value={sort}
          onChange={(event) => update('sort', event.target.value)}
          className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs"
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <ErrorNote error={result.error} />

      {result.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className="aspect-[2/3] animate-pulse rounded-lg bg-neutral-900" />
          ))}
        </div>
      ) : null}

      {(
        <>
          {result.data && titles.length === 0 ? (
            <Empty>
              Nothing cached for these filters.{' '}
              <button type="button" className="underline" onClick={() => setParams(new URLSearchParams())}>
                clear filters
              </button>
            </Empty>
          ) : null}

          {result.data ? (
            <Pager
              page={page}
              totalPages={totalPages}
              total={result.data.total}
              releases={releases}
              onPrev={() => update('page', String(page - 1))}
              onNext={() => update('page', String(page + 1))}
            />
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {titles.map((title) => (
              <TitleCard key={title.mediaId} title={title} />
            ))}
          </div>

          {result.data ? (
            <Pager
              page={page}
              totalPages={totalPages}
              total={result.data.total}
              releases={releases}
              onPrev={() => update('page', String(page - 1))}
              onNext={() => update('page', String(page + 1))}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
