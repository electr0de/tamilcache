import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  hint,
  onClick,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  hint?: string;
  onClick?: () => void;
  tone?: 'default' | 'warn' | 'good';
}) {
  const toneClass =
    tone === 'warn' ? 'text-amber-400' : tone === 'good' ? 'text-emerald-400' : 'text-neutral-100';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-left transition enabled:hover:border-neutral-700 disabled:cursor-default"
    >
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-neutral-500">{hint}</div> : null}
    </button>
  );
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'amber' | 'green' | 'red' }) {
  const toneClass = {
    default: 'bg-neutral-800 text-neutral-300',
    amber: 'bg-amber-500/15 text-amber-300',
    green: 'bg-emerald-500/15 text-emerald-300',
    red: 'bg-rose-500/15 text-rose-300',
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${toneClass}`}>{children}</span>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-dashed border-neutral-800 px-4 py-10 text-center text-sm text-neutral-500">{children}</div>;
}
