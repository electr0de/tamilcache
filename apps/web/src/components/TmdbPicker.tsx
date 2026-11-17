import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Empty, ErrorNote } from './ui.js';

const MAX_SHOWN = 10;

export interface TmdbCandidateRow {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
  originalLanguage: string | null;
  popularity: number;
  score?: number;
  reasons?: string[];
}

/**
 * The "which film is this?" control.
 *
 * The review queue can only decide *Hindi or not*; a `NO_PROVIDER_MATCH` row needs an identity
 * first, and the classifier then derives the language from it. This searches TMDB with the query
 * the crawler itself used (returned by the review endpoint, never retyped by hand) and binds the
 * candidate the reviewer picks. Binding stamps `provider_status = 'matched'` and replays, so the
 * row leaves the queue on success.
 */
export function TmdbPicker({
  topicId,
  kind,
  initialQuery,
  initialYear,
}: {
  topicId: number;
  kind: 'movie' | 'tv';
  initialQuery: string | null;
  initialYear: number | null;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(initialQuery ?? '');
  const [year, setYear] = useState(initialYear === null ? '' : String(initialYear));
  // Null until the reviewer searches: expanding a row must not fire a request per row.
  const [submitted, setSubmitted] = useState<{ query: string; year: number | null } | null>(null);

  const search = useQuery({
    queryKey: ['tmdb-search', topicId, submitted],
    queryFn: () => api.tmdbSearch(submitted?.query ?? '', submitted?.year ?? null, kind),
    enabled: submitted !== null && (submitted?.query.length ?? 0) > 0,
  });

  const bind = useMutation({
    mutationFn: (candidate: TmdbCandidateRow) => api.bindTopic(topicId, candidate.id, candidate.mediaType),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['review'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      // The Title page hosts this picker too: without this its badge keeps saying "no tmdb match"
      // after a successful bind, which reads as a failed write.
      void queryClient.invalidateQueries({ queryKey: ['title'] });
    },
  });

  // TMDB happily returns 20 rows for a one-word title and most of them are noise. The scorer puts
  // the right answer on top, so the tail is not worth scrolling — but never hide it silently.
  const all = search.data?.results ?? [];
  const results = all.slice(0, MAX_SHOWN);

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950/40 p-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">link to a TMDB title</div>
      <form
        className="mt-1 flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted({ query: text.trim(), year: year.trim() ? Number(year) : null });
        }}
      >
        <input
          aria-label="TMDB search query"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="title"
          className="min-w-40 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
        />
        <input
          aria-label="TMDB search year"
          value={year}
          onChange={(event) => setYear(event.target.value)}
          placeholder="year"
          inputMode="numeric"
          className="w-16 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
        />
        <button
          type="submit"
          disabled={text.trim().length === 0 || search.isFetching}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
        >
          search TMDB
        </button>
      </form>

      <ErrorNote error={search.error ?? bind.error} />

      {submitted && search.isFetched && results.length === 0 && !search.error ? (
        <div className="mt-2">
          <Empty>No candidates — try a shorter query.</Empty>
        </div>
      ) : null}

      {all.length > results.length ? (
        <div className="mt-1 text-[11px] text-neutral-500">
          showing {results.length} of {all.length} — refine the query to see the rest
        </div>
      ) : null}

      {results.length > 0 ? (
        <ul className="mt-2 divide-y divide-neutral-900">
          {results.map((candidate) => (
            <li key={`${candidate.mediaType}-${candidate.id}`} className="flex items-center gap-2 py-1 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-neutral-200">
                {candidate.title}
                {candidate.year === null ? '' : ` (${candidate.year})`}
              </span>
              <Badge>{candidate.mediaType}</Badge>
              <Badge>{candidate.originalLanguage ?? '?'}</Badge>
              {candidate.score === undefined ? null : <Badge tone="amber">score {candidate.score}</Badge>}
              <button
                type="button"
                disabled={bind.isPending}
                onClick={() => bind.mutate(candidate)}
                className="shrink-0 rounded border border-emerald-700 px-1.5 py-0.5 text-emerald-300 hover:border-emerald-500 disabled:opacity-40"
              >
                use this
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
