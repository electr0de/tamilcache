import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Title search with a suggestion dropdown.
 *
 * Matching is word-prefix on the server (`spid` → Spider-Man, `avatar way` → Avatar: The Way of
 * Water), so the box never promises a fuzzy match it cannot deliver. Enter commits the query to
 * the grid; choosing a suggestion jumps straight to that title.
 */
export function SearchBox({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value);
  const [debounced, setDebounced] = useState(value);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

  const trimmed = debounced.trim();
  const suggestions = useQuery({
    queryKey: ['suggest', trimmed],
    queryFn: () => api.suggest(trimmed),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  });

  const results = suggestions.data?.titles ?? [];
  const show = open && trimmed.length >= 2 && results.length > 0;

  function commit(next: string) {
    setOpen(false);
    setActive(-1);
    onCommit(next);
  }

  function choose(mediaId: number, type: 'movie' | 'tv') {
    setOpen(false);
    setActive(-1);
    // Carry the current grid URL so the detail page's back link restores the filters.
    navigate(type === 'tv' ? `/show/${mediaId}` : `/movie/${mediaId}`, {
      state: { from: `${location.pathname}${location.search}` },
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && show) {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, results.length - 1));
      return;
    }
    if (event.key === 'ArrowUp' && show) {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, -1));
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (event.key === 'Enter') {
      const chosen = show ? results[active] : undefined;
      if (chosen) choose(chosen.mediaId, chosen.type);
      else commit(text.trim());
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          commit(text.trim());
        }}
        className="flex gap-2"
      >
        <input
          value={text}
          role="combobox"
          aria-label="Search titles"
          aria-expanded={show}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search titles…"
          className="w-64 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-600"
        />
        <button type="submit" className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700">
          Search
        </button>
      </form>

      {show ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Title suggestions"
          className="absolute z-20 mt-1 w-80 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-xl"
        >
          {results.map((result, index) => (
            <li key={result.mediaId} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(result.mediaId, result.type)}
                className={`flex w-full items-center gap-3 px-2 py-2 text-left ${
                  index === active ? 'bg-neutral-800' : 'hover:bg-neutral-900'
                }`}
              >
                {result.poster === null ? (
                  <span className="h-12 w-8 shrink-0 rounded bg-neutral-900" />
                ) : (
                  <img src={result.poster} alt="" className="h-12 w-8 shrink-0 rounded object-cover" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm text-neutral-100">{result.title}</span>
                  <span className="block text-[11px] text-neutral-500">
                    {result.year ?? '—'} · {result.type === 'tv' ? 'series' : 'movie'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
