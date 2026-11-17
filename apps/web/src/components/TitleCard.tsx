import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { formatBytes, type LibraryTitle } from '../api.js';
import { Badge } from './ui.js';
import { Coverage } from './Coverage.js';

/**
 * One poster card. The whole card is the link, so the hit target is the poster rather than the
 * title — the pattern every *arr UI uses, and the only one that works at 6 cards per row.
 */
export function TitleCard({ title }: { title: LibraryTitle }) {
  const [broken, setBroken] = useState(false);
  const location = useLocation();
  const href = title.type === 'tv' ? `/show/${title.mediaId}` : `/movie/${title.mediaId}`;

  return (
    <Link
      to={href}
      state={{ from: `${location.pathname}${location.search}` }}
      className="group block rounded-lg ring-1 ring-neutral-800 transition hover:ring-amber-500/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-t-lg bg-neutral-900">
        {title.poster !== null && !broken ? (
          <img
            src={title.poster}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-xs text-neutral-500">
            {title.title}
          </div>
        )}
        <div className="absolute left-1.5 top-1.5 flex flex-wrap gap-1">
          <Badge tone={title.type === 'tv' ? 'amber' : 'default'}>{title.type === 'tv' ? 'series' : 'movie'}</Badge>
        </div>
      </div>
      <div className="space-y-1 p-2">
        <div className="line-clamp-2 text-sm text-neutral-100">{title.title}</div>
        <div className="text-[11px] text-neutral-500">
          {title.year ?? '—'}
          {title.voteAverage === null ? '' : ` · ★ ${title.voteAverage.toFixed(1)}`}
        </div>
        <div className="flex flex-wrap gap-1">
          {title.audioLangs.slice(0, 3).map((lang) => (
            <Badge key={lang}>{lang}</Badge>
          ))}
        </div>
        {title.type === 'tv' && title.coverage !== null ? (
          <>
            <Coverage aired={title.coverage.aired} covered={title.coverage.covered} compact />
            {title.coverage.missing > 0 ? (
              <div className="text-[11px] text-amber-300">{title.coverage.missing} missing</div>
            ) : null}
          </>
        ) : (
          <div className="text-[11px] text-neutral-500">
            {title.resolutions[0] ?? 'no res'} · {formatBytes(title.largestBytes)}
          </div>
        )}
      </div>
    </Link>
  );
}
