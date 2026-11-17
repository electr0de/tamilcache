import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, type LibraryDetail, type LibraryEpisode, type Variant } from '../api.js';
import { Coverage } from '../components/Coverage.js';
import { TitleHero } from '../components/TitleHero.js';
import { Badge, Empty, ErrorNote } from '../components/ui.js';
import { VariantRow } from './Browse.js';

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Folds `S01 E03–E05` instead of printing every episode. A missing list is read, not parsed, and
 * forty comma-separated tokens are not readable.
 */
export function missingRanges(missing: LibraryDetail['missing']): string {
  const bySeason = new Map<number, number[]>();
  for (const entry of missing) {
    bySeason.set(entry.season, [...(bySeason.get(entry.season) ?? []), entry.episode]);
  }

  const parts: string[] = [];
  for (const [season, episodes] of [...bySeason.entries()].sort(([a], [b]) => a - b)) {
    const sorted = [...episodes].sort((a, b) => a - b);
    let start = sorted[0] as number;
    let previous = start;
    for (const episode of sorted.slice(1)) {
      if (episode === previous + 1) {
        previous = episode;
        continue;
      }
      parts.push(range(season, start, previous));
      start = episode;
      previous = episode;
    }
    parts.push(range(season, start, previous));
  }
  return parts.join(', ');
}

function range(season: number, start: number, end: number): string {
  return start === end ? `S${pad(season)} E${pad(start)}` : `S${pad(season)} E${pad(start)}–E${pad(end)}`;
}

function seasonLabel(season: number): string {
  return season === 0 ? 'Specials' : `Season ${season}`;
}

function Episodes({ episodes }: { episodes: LibraryEpisode[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {episodes.map((episode) => {
        const state = episode.covered ? 'covered' : episode.aired ? 'missing' : 'unaired';
        const tone =
          state === 'covered'
            ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-700/50'
            : state === 'missing'
              ? 'bg-amber-500/15 text-amber-300 ring-amber-700/50'
              : 'bg-neutral-900 text-neutral-600 ring-neutral-800';
        return (
          <span
            key={`${episode.season}-${episode.episode}`}
            data-state={state}
            title={`${episode.name ?? `S${pad(episode.season)}E${pad(episode.episode)}`}${
              episode.airDate === null ? '' : ` · ${episode.airDate}`
            }`}
            className={`rounded px-1.5 py-0.5 text-[11px] ring-1 ${tone}`}
          >
            E{pad(episode.episode)}
          </span>
        );
      })}
    </div>
  );
}

/** The season/episode range a release claims, e.g. `S03 E01–E04`. */
function releaseRange(release: Variant): string | null {
  if (release.season === null) return null;
  if (release.epFrom === null || release.epTo === null) return `S${pad(release.season)}`;
  return range(release.season, release.epFrom, release.epTo);
}

function ReleasesBySeason({ releases }: { releases: Variant[] }) {
  if (releases.length === 0) return <Empty>No cached releases.</Empty>;

  const groups = new Map<number | null, Variant[]>();
  for (const release of releases) {
    groups.set(release.season, [...(groups.get(release.season) ?? []), release]);
  }

  return (
    <div className="space-y-4">
      {[...groups.entries()]
        .sort(([a], [b]) => (a ?? 99) - (b ?? 99))
        .map(([season, list]) => (
          <div key={season ?? 'unassigned'} className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              {season === null ? 'Unassigned releases' : `${seasonLabel(season)} releases`}
            </h3>
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
              {list.map((release) => (
                <div key={release.id}>
                  {releaseRange(release) === null ? null : (
                    <div className="px-3 pt-3">
                      <Badge tone="green">{releaseRange(release)}</Badge>
                    </div>
                  )}
                  <VariantRow variant={release} />
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

export function Show() {
  const { mediaId = '' } = useParams();
  const location = useLocation();
  const id = Number(mediaId);
  const detail = useQuery({ queryKey: ['library-title', id], queryFn: () => api.libraryTitle(id) });
  const [openSeason, setOpenSeason] = useState<number | null>(null);
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

  const { seasons, coverage, missing, releases } = detail.data;
  const missingText = missingRanges(missing);

  return (
    <div className="space-y-6">
      <Link to={backTo} className="text-xs text-neutral-500 hover:text-neutral-300">
        ← Browse
      </Link>

      <TitleHero detail={detail.data} />

      <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="text-sm text-neutral-200">
          {coverage.covered} of {coverage.aired} aired episodes cached
          {missing.length === 0 ? null : <span className="text-amber-300"> · {missing.length} missing</span>}
        </div>
        <Coverage aired={coverage.aired} covered={coverage.covered} />
        {missingText === '' ? null : <div className="text-xs text-amber-300/90">Missing {missingText}</div>}
      </div>

      {seasons === null ? (
        <div className="rounded border border-dashed border-neutral-800 px-4 py-6 text-sm text-neutral-500">
          Episode list unavailable — the provider returned no episode data. Releases below carry the season
          and episode ranges they claim.
        </div>
      ) : (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-neutral-300">Seasons</h2>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">cached</span>
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">aired, missing</span>
            <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-neutral-600">not aired</span>
          </div>
          <div className="divide-y divide-neutral-900 rounded-lg border border-neutral-800 bg-neutral-900/40">
            {seasons.map((season) => {
              const open = openSeason === season.season;
              return (
                <div key={season.season}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenSeason(open ? null : season.season)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-neutral-900/60"
                  >
                    <span className="text-sm text-neutral-200">{seasonLabel(season.season)}</span>
                    <span className="text-[11px] text-neutral-500">
                      {season.aired === 0 ? 'not aired yet' : `${season.covered} of ${season.aired} aired`}
                    </span>
                  </button>
                  {open ? (
                    <div className="px-3 pb-3">
                      <Episodes episodes={season.episodes} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-300">Releases</h2>
        <ReleasesBySeason releases={releases} />
      </div>
    </div>
  );
}
