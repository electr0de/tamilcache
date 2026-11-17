import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Rule } from '../api.js';
import { Badge, Empty, ErrorNote } from '../components/ui.js';

const ACTIONS = ['hindi_dubbed', 'hindi_original', 'not_hindi', 'ignore'] as const;

export function Rules() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['rules'], queryFn: api.rules });
  const [predicate, setPredicate] = useState('{ "forumIds": [] }');
  const [action, setAction] = useState<string>('hindi_dubbed');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['rules'] });
    void queryClient.invalidateQueries({ queryKey: ['review'] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
  };

  const create = useMutation({
    mutationFn: () => api.createRule({ predicate: JSON.parse(predicate) as unknown, action }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : 'failed'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patchRule(id, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteRule(id),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-lg font-semibold">Rules</h1>
        <p className="max-w-3xl text-xs text-neutral-500">
          Ordered, first match wins. Overrides beat rules; rules beat the provider; the provider beats the
          audio-token heuristic. Every save replays the whole table and reports how many rows changed.
        </p>
        <div className="flex flex-col gap-2 md:flex-row">
          <textarea
            value={predicate}
            onChange={(event) => setPredicate(event.target.value)}
            rows={3}
            spellCheck={false}
            className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs outline-none focus:border-neutral-600"
          />
          <div className="flex flex-col gap-2">
            <select
              value={action}
              onChange={(event) => setAction(event.target.value)}
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
            >
              {ACTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => create.mutate()}
              className="rounded bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700"
            >
              add rule
            </button>
          </div>
        </div>
        <ErrorNote error={error ?? create.error ?? patch.error ?? remove.error} />
      </section>

      {rules.data && rules.data.length === 0 ? <Empty>No rules yet — teach the review queue first.</Empty> : null}

      <div className="space-y-2">
        {(rules.data ?? []).map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onToggle={() => patch.mutate({ id: rule.id, body: { enabled: !rule.enabled } })}
            onPromote={() => patch.mutate({ id: rule.id, body: { priority: Math.max(1, rule.priority - 10) } })}
            onDelete={() => remove.mutate(rule.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  onToggle,
  onPromote,
  onDelete,
}: {
  rule: Rule;
  onToggle: () => void;
  onPromote: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded border px-3 py-2 ${rule.enabled ? 'border-neutral-800 bg-neutral-900/40' : 'border-neutral-900 bg-neutral-950 opacity-60'}`}>
      <span className="font-mono text-[11px] text-neutral-500">prio {rule.priority}</span>
      <Badge tone={rule.action === 'not_hindi' || rule.action === 'ignore' ? 'red' : 'green'}>{rule.action}</Badge>
      <code className="min-w-0 flex-1 truncate text-xs text-neutral-300">{rule.predicate}</code>
      <span className="text-[11px] text-neutral-600">{rule.hits} hits</span>
      <button type="button" onClick={onPromote} className="text-[11px] text-neutral-400 hover:text-neutral-100">
        promote
      </button>
      <button type="button" onClick={onToggle} className="text-[11px] text-neutral-400 hover:text-neutral-100">
        {rule.enabled ? 'disable' : 'enable'}
      </button>
      <button type="button" onClick={onDelete} className="text-[11px] text-rose-400 hover:text-rose-300">
        delete
      </button>
    </div>
  );
}
