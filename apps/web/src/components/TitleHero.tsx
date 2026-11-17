import type { LibraryDetail } from '../api.js';
import { Badge } from './ui.js';

function runtimeLabel(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : `${hours}h ${rest}m`;
}

function votes(count: number | null): string | null {
  if (count === null || count < 1) return null;
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/**
 * The shared hero for both detail pages: poster, title, facts, provider links and attribution.
 *
 * `tmdbId` arrives as `null` for manual binds (the database stores a negative sentinel), so a
 * link is rendered only when the id is real — a dead themoviedb.org link is worse than no link.
 */
export function TitleHero({ detail }: { detail: LibraryDetail }) {
  const { media, availability } = detail;
  const facts = [
    media.year === null ? null : String(media.year),
    runtimeLabel(media.runtime),
    media.originalLanguage === null ? null : media.originalLanguage,
    media.seasons === null ? null : `${media.seasons} season${media.seasons === 1 ? '' : 's'}`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <div className="relative overflow-hidden rounded-xl">
      {media.backdrop === null ? null : (
        <img
          data-testid="backdrop"
          src={media.backdrop}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-25"
        />
      )}
      <div className="relative flex flex-col gap-5 bg-gradient-to-b from-neutral-950/40 to-neutral-950/90 p-4 sm:flex-row">
        <div className="shrink-0">
          {media.poster === null ? (
            <div className="flex h-72 w-48 items-center justify-center rounded-lg bg-neutral-900 p-3 text-center text-xs text-neutral-500">
              {media.title}
            </div>
          ) : (
            <img src={media.poster} alt="" className="h-72 w-48 rounded-lg object-cover ring-1 ring-neutral-800" />
          )}
        </div>

        <div className="min-w-0 space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {media.title}
            {media.year === null ? null : <span className="ml-2 text-neutral-500">({media.year})</span>}
          </h1>

          <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-400">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={availability === 'hindi_ready' ? 'green' : 'red'}>
              {availability === 'hindi_ready' ? 'Hindi ready' : 'No Hindi release'}
            </Badge>
            {media.voteAverage === null ? null : (
              <Badge tone="amber">
                ★ {media.voteAverage.toFixed(1)}
                {votes(media.voteCount) === null ? '' : ` (${votes(media.voteCount)})`}
              </Badge>
            )}
            {media.status === null ? null : <Badge>{media.status}</Badge>}
          </div>

          <div className="flex flex-wrap gap-1">
            {media.genres.slice(0, 4).map((genre) => (
              <Badge key={genre}>{genre}</Badge>
            ))}
          </div>

          {media.overview === null ? null : (
            <p className="max-w-prose text-sm leading-relaxed text-neutral-400">{media.overview}</p>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
            {media.tmdbId === null ? null : (
              <a
                href={`https://www.themoviedb.org/${media.type === 'tv' ? 'tv' : 'movie'}/${media.tmdbId}`}
                target="_blank"
                rel="noreferrer"
                className="text-neutral-500 hover:text-neutral-300"
              >
                open on TMDB ↗
              </a>
            )}
            {media.imdbId === null ? null : (
              <a
                href={`https://www.imdb.com/title/${media.imdbId}/`}
                target="_blank"
                rel="noreferrer"
                className="text-neutral-500 hover:text-neutral-300"
              >
                open on IMDb ↗
              </a>
            )}
            <span className="text-neutral-600">Metadata by TMDB</span>
          </div>
        </div>
      </div>
    </div>
  );
}
