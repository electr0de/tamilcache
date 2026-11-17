export function Coverage({ aired, covered, compact = false }: { aired: number; covered: number; compact?: boolean }) {
  const pct = aired === 0 ? 0 : Math.round((covered / aired) * 100);
  const tone = pct === 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-400' : 'bg-rose-500';
  return (
    <div className="space-y-1" title={`${coverage(aired, covered)}`}>
      <div className={`${compact ? 'h-1' : 'h-1.5'} overflow-hidden rounded-full bg-neutral-800`}>
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[11px] text-neutral-400">
        {covered}/{aired} aired
      </div>
    </div>
  );
}

function coverage(aired: number, covered: number): string {
  return `${aired === 0 ? 0 : Math.round((covered / aired) * 100)}% of aired episodes cached`;
}
