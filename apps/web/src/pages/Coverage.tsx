import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CoverageBoard, type CoverageReport } from '../api.js';
import { ErrorNote } from '../components/ui.js';

const STATUS_ORDER = ['parsed', 'external', 'no_link', 'parse_failed', 'gone'] as const;
const STATUS_SHORT: Record<string, string> = {
  parsed: 'parsed',
  external: 'gated',
  no_link: 'none',
  parse_failed: 'parser',
  gone: 'gone',
};

interface Section {
  /** The section is identified by its title: a language section has no forum id of its own. */
  hubTitle: string;
  included: CoverageBoard[];
  excluded: CoverageBoard[];
  pagesCovered: number;
  pagesOnSite: number;
  fetched: number;
  stored: number;
}

/**
 * Group by the section title — that is what makes a language a section.
 *
 * Keyed by title, not by `hub.id`: the audit gives language sections no forum id (they are
 * config languages, not forums), so grouping by id collapsed all 86 boards into the first section
 * that happened to be created. Insertion order is kept, which follows the site's own order.
 */
export function sectionsOf(report: CoverageReport): Section[] {
  const sections = new Map<string, Section>();
  for (const board of report.boards) {
    const hubTitle = board.hub?.title ?? 'Other';
    const section =
      sections.get(hubTitle) ??
      {
        hubTitle,
        included: [],
        excluded: [],
        pagesCovered: 0,
        pagesOnSite: 0,
        fetched: 0,
        stored: 0,
      };
    sections.set(hubTitle, section);
    if (board.scope === 'include') {
      section.included.push(board);
      section.pagesCovered += board.pagesCovered;
      section.pagesOnSite += board.pagesOnSite ?? 0;
      section.fetched += board.fetched;
      section.stored += board.stored;
    } else {
      section.excluded.push(board);
    }
  }
  for (const section of sections.values()) {
    section.included.sort((a, b) => a.id - b.id);
    section.excluded.sort((a, b) => a.id - b.id);
  }
  return [...sections.values()];
}

function StatusCounts({ board }: { board: CoverageBoard }) {
  const parts = STATUS_ORDER.filter((status) => (board.byStatus[status] ?? 0) > 0).map(
    (status) => `${STATUS_SHORT[status]} ${board.byStatus[status]}`,
  );
  return <span className="text-neutral-500">{parts.join(' · ') || '—'}</span>;
}

/**
 * Coverage as the site is organised: a language section, then its boards with the names the site
 * uses. Excluded boards stay visible but collapsed — the audit's whole point is that an exclusion
 * is a recorded decision, so hiding them would undo it; showing 96 flat rows buries the 46 that
 * matter. Everything fits on one page, no pagination.
 */
export function Coverage() {
  const audit = useQuery({ queryKey: ['coverage'], queryFn: () => api.coverage() });
  const report = audit.data?.report ?? null;
  const sections = useMemo(() => (report ? sectionsOf(report) : []), [report]);

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Coverage</h1>
        <p className="text-sm text-neutral-400">
          {report === null
            ? 'No audit has run yet. Run `pnpm coverage:audit` with the worker image.'
            : `${report.exitCode === 0 ? 'all boards covered' : `${report.problems.length} problem(s)`} · last run ${
                audit.data?.generatedAt ?? 'unknown'
              }`}
        </p>
      </header>
      <ErrorNote error={audit.error} />

      {report && report.problems.length > 0 ? (
        <ul className="space-y-1 rounded border border-amber-700/60 bg-amber-950/30 p-3 text-xs text-amber-200">
          {report.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      {sections.map((section) => (
        <section key={section.hubTitle} className="rounded border border-neutral-800">
          <header className="flex items-baseline justify-between gap-3 border-b border-neutral-800 bg-neutral-900/60 px-3 py-2">
            <h2 className="text-sm font-semibold text-neutral-200">{section.hubTitle}</h2>
            <span className="text-xs text-neutral-500">
              {section.pagesCovered}/{section.pagesOnSite} pages · {section.fetched.toLocaleString()} fetched ·{' '}
              {section.stored.toLocaleString()} stored
            </span>
          </header>

          <ul className="divide-y divide-neutral-800">
            {section.included.map((board) => {
              const complete = board.pagesOnSite !== null && board.pagesCovered >= board.pagesOnSite;
              return (
                <li key={board.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                  <span className="w-8 shrink-0 text-neutral-600">{board.id}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-200" title={board.name}>
                    {board.title}
                  </span>
                  <span className={`w-20 shrink-0 text-right ${complete ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {board.pagesOnSite === null ? '—' : `${board.pagesCovered}/${board.pagesOnSite}`}
                    {complete ? ' ✓' : ''}
                  </span>
                  <span className="w-20 shrink-0 text-right text-neutral-400">
                    {board.fetched.toLocaleString()} fetched
                  </span>
                  <span className="w-16 shrink-0 text-right text-neutral-400">{board.stored.toLocaleString()}</span>
                  <span className="hidden w-56 shrink-0 sm:block">
                    <StatusCounts board={board} />
                  </span>
                </li>
              );
            })}
          </ul>

          {section.excluded.length > 0 ? (
            <details className="border-t border-neutral-800 px-3 py-1.5">
              <summary className="cursor-pointer text-xs text-neutral-500">
                excluded ({section.excluded.length})
              </summary>
              <ul className="mt-1 space-y-0.5">
                {section.excluded.map((board) => (
                  <li key={board.id} className="text-xs text-neutral-500">
                    {board.title} <span className="text-neutral-600">— {board.name}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ))}
    </section>
  );
}
