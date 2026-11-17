import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, formatBytes } from '../api.js';
import { TmdbPicker } from '../components/TmdbPicker.js';
import { Badge, Empty, ErrorNote } from '../components/ui.js';
import { VariantRow } from './Browse.js';

function UploadTorrent({ variantId, onDone }: { variantId: number; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function upload(file: File) {
    setState('busy');
    try {
      const result = await api.uploadTorrent(variantId, file);
      setState('ok');
      setMessage(`infohash ${result.infohash.slice(0, 12)}…`);
      onDone();
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'upload failed');
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <input
        ref={input}
        type="file"
        accept=".torrent,application/x-bittorrent"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="rounded border border-amber-800 px-2 py-1 text-xs text-amber-300 hover:border-amber-600"
      >
        {state === 'busy' ? 'uploading…' : 'upload .torrent'}
      </button>
      {message ? <span className={`text-[11px] ${state === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}>{message}</span> : null}
    </span>
  );
}

export function Title() {
  const { key = '' } = useParams();
  const detail = useQuery({ queryKey: ['title', key], queryFn: () => api.title(key) });

  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!detail.data) return <div className="text-neutral-400">Loading…</div>;

  const { title, year, poster, tmdbId, originalLanguage, variants, coverage, missing, episodes, kind, searchQuery, searchYear } =
    detail.data;
  const seasons = [...new Set(variants.map((variant) => variant.season).filter((season): season is number => season !== null))];

  return (
    <div className="space-y-6">
      <div className="flex gap-6">
        {poster ? (
          <img src={poster} alt="" className="h-48 w-32 rounded object-cover" />
        ) : (
          <div className="flex h-48 w-32 items-center justify-center rounded bg-neutral-900 text-xs text-neutral-600">no poster</div>
        )}
        <div>
          <h1 className="text-xl font-semibold">
            {title} {year ? <span className="text-neutral-500">({year})</span> : null}
          </h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tmdbId ? <Badge>tmdb {tmdbId}</Badge> : <Badge tone="amber">no tmdb match</Badge>}
            {originalLanguage ? <Badge>orig {originalLanguage}</Badge> : null}
            <Badge>{variants.length} variant(s)</Badge>
          </div>
          <a
            href={`https://www.themoviedb.org/${variants[0]?.categoryId === 5030 ? 'tv' : 'movie'}/${tmdbId ?? ''}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-xs text-neutral-500 hover:text-neutral-300"
          >
            open on TMDB →
          </a>
        </div>
      </div>

      {/* One upload per slug in practice; `variants[0]` is the highest quality rank, so it is the
          right topic to bind. Other topics sharing this slug keep their own queue row. */}
      {tmdbId === null ? (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-neutral-300">Match to TMDB</h2>
          <p className="text-[11px] text-neutral-500">
            This release is in the review queue as <span className="font-mono">{variants[0]?.reviewReason ?? 'UNKNOWN'}</span>. Picking a
            title here binds it and replays the classifier.
          </p>
          <TmdbPicker topicId={variants[0]?.topicId ?? 0} kind={kind} initialQuery={searchQuery} initialYear={searchYear} />
        </div>
      ) : null}

      {episodes.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-neutral-300">
            Episode coverage
            <span className="ml-2 font-normal text-neutral-500">
              {coverage.covered}/{coverage.aired} aired episode(s) cached
            </span>
          </h2>
          <div className="h-2 overflow-hidden rounded bg-neutral-800">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${coverage.aired === 0 ? 0 : Math.round((coverage.covered / coverage.aired) * 100)}%` }}
            />
          </div>
          {missing.length > 0 ? (
            <div className="text-xs text-amber-300">
              missing {missing.length}:{' '}
              {missing
                .slice(0, 12)
                .map((episode) => `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`)
                .join(', ')}
              {missing.length > 12 ? ' …' : ''}
            </div>
          ) : (
            <div className="text-xs text-emerald-400">no aired episodes missing</div>
          )}
        </div>
      ) : seasons.length > 0 ? (
        <div className="text-xs text-neutral-500">
          Episode data unavailable — TMDB has no match for this show, so coverage cannot be compared.
        </div>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-300">Variants</h2>
        {variants.length === 0 ? <Empty>No variants.</Empty> : null}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
          {variants.map((variant) => (
            <div key={variant.id}>
              <VariantRow variant={variant} />
              {variant.magnet ? null : (
                <div className="px-3 pb-3">
                  <UploadTorrent variantId={variant.id} onDone={() => void detail.refetch()} />
                  {variant.torrentUrl ? (
                    <a href={variant.torrentUrl} target="_blank" rel="noreferrer" className="ml-2 text-[11px] text-neutral-500">
                      attachment
                    </a>
                  ) : null}
                  <span className="ml-2 text-[11px] text-neutral-600">{formatBytes(variant.sizeBytes)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
