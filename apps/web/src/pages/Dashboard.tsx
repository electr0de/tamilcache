import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorNote, StatCard } from '../components/ui.js';

/** `retrying in 3m` — without it a failing forum looks exactly like a slow one. */
function retryLabel(retryAfter: string | null): string {
  const at = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (!Number.isFinite(at)) return 'retrying';
  return `retrying in ${Math.max(1, Math.round((at - Date.now()) / 60_000))}m`;
}

export function Dashboard() {
  const navigate = useNavigate();
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 5000 });

  const crawl = useQuery({ queryKey: ['crawl'], queryFn: api.crawl, refetchInterval: 5000 });
  // The worker owns every outbound request, so both controls only set an intent flag for it.
  const requestDelta = useMutation({ mutationFn: api.requestDelta, onSuccess: () => void crawl.refetch() });
  const setBackfill = useMutation({
    mutationFn: (armed: boolean) => api.setBackfill({ armed }),
    onSuccess: () => void crawl.refetch(),
  });
  const circuitUntilMs = crawl.data?.circuitOpenUntil ? new Date(crawl.data.circuitOpenUntil).getTime() : null;
  // A stale row from a breaker that already reopened must not keep claiming the crawler is paused.
  const circuitActive = circuitUntilMs !== null && circuitUntilMs > Date.now();

  if (stats.isLoading) return <div className="text-neutral-400">Loading…</div>;
  if (stats.error) return <ErrorNote error={stats.error} />;
  const data = stats.data;
  if (!data) return null;

  const reviewTotal = Object.values(data.reviewQueue).reduce((sum, value) => sum + value, 0);
  // What wants a human: no servable variant, for any of the three actionable reasons.
  const toResolve = (data.unresolved?.external ?? 0) + (data.unresolved?.no_link ?? 0) + (data.unresolved?.parse_failed ?? 0);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-4 text-lg font-semibold">Cache</h1>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Topics" value={data.topics} />
          <StatCard label="Variants" value={data.variants} />
          <StatCard
            label="Hindi dubbed"
            value={data.byDecision.hindi_dubbed ?? 0}
            tone="good"
            onClick={() => navigate('/browse')}
          />
          <StatCard
            label="Hindi original"
            value={data.byDecision.hindi_original ?? 0}
            tone="good"
            onClick={() => navigate('/browse')}
          />
          <StatCard
            label="Titles × resolution"
            value={data.preferred}
            hint="what Radarr/Sonarr sees"
            onClick={() => navigate('/browse')}
          />
          <StatCard label="Movies" value={data.movies} hint="poster library" onClick={() => navigate('/browse?type=movie')} />
          <StatCard label="Shows" value={data.shows} hint="seasons and episodes" onClick={() => navigate('/browse?type=tv')} />
          <StatCard label="With magnet" value={data.withMagnet} />
          <StatCard label="With local .torrent" value={data.withTorrent} />
          <StatCard label="Needs review" value={reviewTotal} tone="warn" onClick={() => navigate('/review')} />
          <StatCard
            label="Not Hindi"
            value={data.byDecision.not_hindi ?? 0}
            
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-300">Crawl health</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">To resolve</div>
            <button
              type="button"
              data-testid="unresolved-count"
              onClick={() => navigate('/unresolved')}
              className="mt-1 text-left text-2xl font-semibold text-amber-400 hover:text-amber-300"
            >
              {toResolve.toLocaleString()}
            </button>
            <div className="mt-1 text-xs text-neutral-500">
              gated {(data.unresolved.external ?? 0).toLocaleString()} · nothing linked{' '}
              {(data.unresolved.no_link ?? 0).toLocaleString()} · parser missed{' '}
              {(data.unresolved.parse_failed ?? 0).toLocaleString()}
            </div>
            <button
              type="button"
              onClick={() => navigate('/dead')}
              className="mt-2 text-xs text-neutral-400 hover:text-neutral-200"
            >
              dead links (404): {(data.unresolved.gone ?? 0).toLocaleString()}
            </button>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">Task failures</div>
            <div
              data-testid="dead-count"
              className={`mt-1 text-2xl font-semibold ${
                (crawl.data?.dead.count ?? 0) > 10 ? 'text-rose-400' : (crawl.data?.dead.count ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'
              }`}
            >
              {crawl.data?.dead.count ?? 0}
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              crawl tasks that failed 5× — infrastructure, not content. The backlog is in To resolve.
            </div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">Queue</div>
            <div className="mt-1 flex gap-4 text-sm">
              <span className="text-amber-300">P0 {crawl.data?.pending.p0 ?? 0}</span>
              <span className="text-neutral-400">P1 {crawl.data?.pending.p1 ?? 0}</span>
            </div>
            <div className="mt-2 text-xs text-neutral-500">
              delta {crawl.data?.deltaRequested ? 'queued' : 'idle'}
              {crawl.data?.lastDeltaAt ? ` · last ${new Date(crawl.data.lastDeltaAt).toLocaleString()}` : ' · never run'}
            </div>
            {circuitActive ? (
              <div className="mt-2 text-xs text-rose-400">
                circuit open until {new Date(circuitUntilMs as number).toLocaleTimeString()}
              </div>
            ) : null}
            {crawl.data?.tmdbBackoffUntil ? (
              <div className="mt-1 text-xs text-amber-400">TMDB backoff active</div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="recache-index"
                onClick={() => requestDelta.mutate()}
                disabled={requestDelta.isPending || (crawl.data?.deltaRequested ?? false)}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
              >
                {crawl.data?.deltaRequested ? 'index queued' : 'Re-cache index now'}
              </button>
              <button
                type="button"
                data-testid="toggle-backfill"
                onClick={() => setBackfill.mutate(!(crawl.data?.armed ?? false))}
                disabled={setBackfill.isPending}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
              >
                {crawl.data?.armed ? 'Pause backfill' : 'Start backfill'}
              </button>
            </div>
            {requestDelta.error || setBackfill.error ? (
              <div className="mt-1 text-xs text-rose-400">
                {(requestDelta.error ?? setBackfill.error)?.message}
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-xs uppercase tracking-wide text-neutral-500">Backfill</div>
            <div className="mt-2 space-y-1">
              {(crawl.data?.backfill ?? []).length === 0 ? (
                <div className="text-xs text-neutral-500">not started</div>
              ) : (
                (crawl.data?.backfill ?? []).slice(0, 6).map((row) => (
                  <div key={row.sourceForumId} data-testid="backfill-row" className="text-[11px] text-neutral-400">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate" title={row.forum}>{row.forum}</span>
                      <span
                        className={row.done ? 'text-emerald-400' : row.failures > 0 ? 'text-amber-400' : 'text-neutral-500'}
                        title={row.lastError ?? undefined}
                      >
                        {row.failures > 0 && !row.done
                          ? retryLabel(row.retryAfter)
                          : row.percent === null
                            ? `${row.nextPage}`
                            : `${row.percent}%`}
                        {row.done ? ' ✓' : ''}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded bg-neutral-800">
                      <div className="h-full bg-emerald-600" style={{ width: `${row.percent ?? 0}%` }} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-8 text-sm font-semibold text-neutral-300">Review queue by reason</h2>
        {reviewTotal === 0 ? (
          <div className="text-sm text-neutral-500">Nothing waiting. </div>
        ) : (
          <div className="space-y-2">
            {Object.entries(data.reviewQueue).map(([reason, count]) => (
              <button
                key={reason}
                type="button"
                onClick={() => navigate(`/review?reason=${reason}`)}
                className="flex w-full items-center justify-between rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm hover:border-neutral-700"
              >
                <span className="font-mono text-xs text-amber-300">{reason}</span>
                <span className="text-neutral-400">{count} variant(s)</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
