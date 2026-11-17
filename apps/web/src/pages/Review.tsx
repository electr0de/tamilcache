import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatBytes } from '../api.js';
import { ProviderPicker } from '../components/ProviderPicker.js';
import { TmdbPicker } from '../components/TmdbPicker.js';
import { Badge, Empty, ErrorNote } from '../components/ui.js';

interface Proposal {
  tmdbId: number;
  mediaType?: 'movie' | 'tv';
  title: string;
  year: number | null;
  originalLanguage: string | null;
  score: number;
  reasons?: string[];
  runnerUp?: { tmdbId: number; title: string; score: number } | null;
}

/** Reasons whose row needs a film identity, not a language decision. */
const IDENTITY_REASONS = new Set(['NO_PROVIDER_MATCH', 'NO_AUDIO_TAG', 'AMBIGUOUS_TITLE']);

function parseProposal(raw: string | null): Proposal | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Proposal;
    return typeof parsed.tmdbId === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

const ACTIONS = [
  { value: 'hindi_dubbed', label: 'Include as Hindi dubbed' },
  { value: 'hindi_original', label: 'Include as Hindi original' },
  { value: 'not_hindi', label: 'Not Hindi' },
] as const;

export function Review() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const reasonFilter = params.get('reason');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [action, setAction] = useState<string>(ACTIONS[0].value);
  // Off by default: a single click once taught a forum-wide rule that marked a whole board
  // not-Hindi, and retention then deleted every variant on it.
  const [applyToSimilar, setApplyToSimilar] = useState(false);
  const [preview, setPreview] = useState<{ affected: number } | null>(null);

  const review = useQuery({ queryKey: ['review'], queryFn: api.review });

  const groups = useMemo(() => {
    const all = review.data?.groups ?? [];
    return reasonFilter ? all.filter((group) => group.reason === reasonFilter) : all;
  }, [review.data, reasonFilter]);

  const bind = useMutation({
    mutationFn: ({ topicId, proposal }: { topicId: number; proposal: Proposal }) =>
      api.bindTopic(topicId, proposal.tmdbId, proposal.mediaType ?? 'movie'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['review'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const decide = useMutation({
    mutationFn: (dryRun: boolean) => {
      const ids = [...selected];
      return api.decide(
        applyToSimilar
          ? { applyToSimilar: true, predicate: { forumIds: forumsOf(groups, ids) }, action, dryRun }
          : { variantIds: ids, action, dryRun },
      );
    },
    onSuccess: (result) => {
      if (result.dryRun) {
        setPreview({ affected: result.affected });
        return;
      }
      setPreview(null);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['review'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setPreview(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Review queue</h1>
        <span className="text-sm text-neutral-500">{review.data?.total ?? 0} unknown variants</span>
        {reasonFilter ? (
          <button type="button" onClick={() => setParams(new URLSearchParams())} className="text-xs text-amber-400">
            clear filter: {reasonFilter}
          </button>
        ) : null}
      </div>

      <ErrorNote error={review.error ?? decide.error} />

      <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm">
        <span className="text-xs text-neutral-500">{selected.size} selected</span>
        <select
          value={action}
          onChange={(event) => setAction(event.target.value)}
          className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
        >
          {ACTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <label
          className="flex items-center gap-1 text-xs text-neutral-400"
          title="The predicate is the selected rows' forums: every row from them, not just the selection. The preview shows how many."
        >
          <input type="checkbox" checked={applyToSimilar} onChange={(event) => setApplyToSimilar(event.target.checked)} />
          teach every row from these forums
        </label>
        <button
          type="button"
          disabled={selected.size === 0 || decide.isPending}
          onClick={() => decide.mutate(true)}
          className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-40"
        >
          preview
        </button>
        <button
          type="button"
          disabled={selected.size === 0 || decide.isPending}
          onClick={() => decide.mutate(false)}
          className="rounded bg-amber-500 px-2 py-1 text-xs font-medium text-neutral-950 hover:bg-amber-400 disabled:opacity-40"
        >
          commit + replay
        </button>
        {preview ? (
          <span data-testid="preview-count" className="text-xs text-amber-300">this will reclassify {preview.affected} variant(s)</span>
        ) : null}
        {decide.data && !decide.data.dryRun ? (
          <span className="text-xs text-emerald-400">replayed {decide.data.replay?.updated ?? 0} row(s)</span>
        ) : null}
      </div>

      {review.data && groups.length === 0 ? <Empty>Nothing to review.</Empty> : null}

      {groups.map((group) => (
        <section key={group.reason} className="space-y-2">
          <h2 className="font-mono text-xs uppercase tracking-wide text-amber-300">
            {group.reason} <span className="text-neutral-500">— {group.count}</span>
          </h2>
          {IDENTITY_REASONS.has(group.reason) ? (
            <p className="text-[11px] text-neutral-500">
              pick the film first — the Hindi decision follows from it automatically.
            </p>
          ) : null}
          <div className="divide-y divide-neutral-900 rounded-lg border border-neutral-800 bg-neutral-900/40">
            {group.items.map((item) => {
              const proposal = parseProposal(item.providerProposal);
              return (
                <details key={item.id} className="group px-3 py-2 hover:bg-neutral-900">
                  <summary className="flex cursor-pointer list-none items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      onClick={(event) => event.stopPropagation()}
                      className="mt-1"
                      aria-label={`select ${item.rawTitle.slice(0, 40)}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-neutral-200">{item.rawTitle}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                        <span className="font-mono">{item.forumName}</span>
                        <a href={item.link} target="_blank" rel="noreferrer" className="underline decoration-neutral-700 hover:decoration-neutral-400">open on tamilmv</a>
                        <Badge>{item.sourceTagRaw}</Badge>
                        {item.resolution ? <Badge>{item.resolution}</Badge> : <Badge tone="amber">no res</Badge>}
                        {item.audioLangs.length > 0 ? (
                          <Badge>{item.audioLangs.join(' / ')}</Badge>
                        ) : (
                          <Badge tone="amber">no lang</Badge>
                        )}
                        <span>{formatBytes(item.sizeBytes)}</span>
                        {item.mediaTitle ? (
                          <span className="text-emerald-400">
                            TMDB: {item.mediaTitle} ({item.originalLanguage ?? '?'})
                          </span>
                        ) : proposal ? (
                          <span className="text-amber-300">
                            proposal: {proposal.title}
                            {proposal.year ? ` (${proposal.year})` : ''} · score {proposal.score}
                          </span>
                        ) : (
                          <span className="text-neutral-600">no TMDB match — expand to search</span>
                        )}
                        <span className="text-neutral-600 group-open:hidden">▸ expand</span>
                      </div>
                    </div>
                    {proposal ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          bind.mutate({ topicId: item.topicId, proposal });
                        }}
                        className="rounded border border-emerald-700 px-1.5 py-0.5 text-[11px] text-emerald-300 hover:border-emerald-500"
                      >
                        accept
                      </button>
                    ) : null}
                  </summary>

                  {/* Full evidence: the compact line truncates the title exactly where the quality
                      blocks start, which is the part a decision depends on. */}
                  <div className="mt-2 space-y-2 pl-7">
                    <p
                      data-testid="review-full-title"
                      className="whitespace-normal break-words text-sm text-neutral-200"
                    >
                      {item.rawTitle}
                    </p>
                    <div className="flex gap-3">
                      {item.poster ? (
                        <img src={item.poster} alt="" className="h-28 w-20 shrink-0 rounded object-cover" />
                      ) : null}
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-neutral-400">
                        <dt className="text-neutral-600">forum</dt>
                        <dd className="font-mono">{item.forumName}</dd>
                        <dt className="text-neutral-600">size</dt>
                        <dd>{formatBytes(item.sizeBytes)}</dd>
                        <dt className="text-neutral-600">resolution</dt>
                        <dd>{item.resolution ?? 'not stated'}</dd>
                        <dt className="text-neutral-600">source</dt>
                        <dd>{item.sourceTagRaw}</dd>
                        <dt className="text-neutral-600">audio</dt>
                        <dd>{item.audioLangs.length > 0 ? item.audioLangs.join(', ') : 'not stated'}</dd>
                        <dt className="text-neutral-600">topic</dt>
                        <dd>
                          <a className="underline" href={`/title/${encodeURIComponent(item.slug)}`}>
                            open title page
                          </a>
                        </dd>
                      </dl>
                    </div>
                    {proposal ? (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-400">
                        <span className="text-neutral-600">matched because</span>
                        {(proposal.reasons ?? []).map((reason) => (
                          <Badge key={reason}>{reason}</Badge>
                        ))}
                        {proposal.year ? <Badge>{proposal.year}</Badge> : null}
                        {proposal.originalLanguage ? <Badge>{proposal.originalLanguage}</Badge> : null}
                      </div>
                    ) : null}
                    {/* The runner-up is already in the stored payload; showing it costs no request. */}
                    {proposal?.runnerUp ? (
                      <div className="text-[11px] text-neutral-500">
                        runner-up: {proposal.runnerUp.title} ({proposal.runnerUp.score})
                      </div>
                    ) : null}
                    <TmdbPicker
                      topicId={item.topicId}
                      kind={item.kind}
                      initialQuery={item.searchQuery}
                      initialYear={item.searchYear}
                    />
                    <ProviderPicker
                      topicId={item.topicId}
                      kind={item.kind ?? 'movie'}
                      initialQuery={item.searchQuery}
                      initialYear={item.searchYear}
                    />
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Turns the selected rows' forums into a predicate the API can dry-run and store as a rule. */
function forumsOf(groups: Array<{ items: Array<{ id: number; forumId: number }> }>, ids: number[]): number[] {
  const chosen = new Set(ids);
  const forums = new Set<number>();
  for (const group of groups) {
    for (const item of group.items) {
      if (chosen.has(item.id)) forums.add(item.forumId);
    }
  }
  return [...forums];
}
