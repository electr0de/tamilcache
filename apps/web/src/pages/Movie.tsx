import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, formatBytes, type Variant } from '../api.js';
import { TitleHero } from '../components/TitleHero.js';
import { Empty, ErrorNote } from '../components/ui.js';
import { VariantRow } from './Browse.js';

/** Groups releases under `2160p (3)` style headings, best quality first. */
export function ReleaseGroups({ releases }: { releases: Variant[] }) {
  const groups = new Map<string, Variant[]>();
  for (const release of releases) {
    const key = release.resolution ?? 'no resolution';
    groups.set(key, [...(groups.get(key) ?? []), release]);
  }

  if (groups.size === 0) return <Empty>No cached releases.</Empty>;

  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([resolution, list]) => (
        <div key={resolution} className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {resolution} ({list.length})
          </h3>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
            {list.map((release) => (
              <VariantRow key={release.id} variant={release} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Movie() {
  const { mediaId = '' } = useParams();
  const location = useLocation();
  const id = Number(mediaId);
  const detail = useQuery({ queryKey: ['library-title', id], queryFn: () => api.libraryTitle(id) });
  const backTo = (location.state as { from?: string } | null)?.from ?? '/browse';

  if (detail.error !== null) {
    return (
      <div className="space-y-3">
        <ErrorNote error={detail.error} />
        <Link to={backTo} className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Browse
        </Link>
      </div>
    );
  }

  if (!detail.data) {
    return (
      <div className="flex gap-5">
        <div className="h-72 w-48 shrink-0 animate-pulse rounded-lg bg-neutral-900" />
        <div className="space-y-2">
          <div className="h-7 w-64 animate-pulse rounded bg-neutral-900" />
          <div className="h-4 w-40 animate-pulse rounded bg-neutral-900" />
        </div>
      </div>
    );
  }

  const { media, releases, availability } = detail.data;
  const largest = releases.reduce((max, release) => Math.max(max, release.sizeBytes), 0);
  const latest = releases
    .map((release) => release.publishedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);

  return (
    <div className="space-y-6">
      <Link to={backTo} className="text-xs text-neutral-500 hover:text-neutral-300">
        ← Browse
      </Link>

      <TitleHero detail={detail.data} />

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-xs sm:grid-cols-3">
        <Fact label="Type" value={media.type === 'tv' ? 'Series' : 'Movie'} />
        <Fact label="Original language" value={media.originalLanguage ?? '—'} />
        <Fact label="Audio cached" value={[...new Set(releases.flatMap((release) => release.audioLangs))].join(', ') || '—'} />
        <Fact label="Releases" value={String(releases.length)} />
        <Fact label="Largest" value={largest === 0 ? '—' : formatBytes(largest)} />
        <Fact label="Latest release" value={latest === undefined ? '—' : latest.slice(0, 10)} />
      </dl>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-300">Releases</h2>
        <ReleaseGroups releases={releases} />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{value}</dd>
    </div>
  );
}
