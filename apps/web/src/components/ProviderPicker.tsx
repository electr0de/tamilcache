import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type OmdbHit, type TvdbHit } from '../api.js';
import { Badge, Empty, ErrorNote } from './ui.js';

// ISO-639-1 codes only: the review route's schema is `min(2).max(3)`, so a word like 'other'
// would be rejected with a 400 instead of stored. `TvdbClient.language()` maps ben/mar/guj/pun/urd
// to exactly these codes, so the picker must offer them or resolve them without asking.
const LANGUAGES = ['hi', 'ta', 'te', 'ml', 'kn', 'en', 'bn', 'mr', 'gu', 'pa', 'ur'] as const;

/**
 * The fallback providers, for a title TMDB does not have.
 *
 * Nothing here fires on render: an OMDb request costs one of 1,000 free daily calls, so it sits
 * behind an explicit acknowledgement. The panel hides itself when the install has no key, so an
 * unconfigured build shows no dead control.
 */
export function ProviderPicker({
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
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers, staleTime: Infinity });

  const [text, setText] = useState(initialQuery ?? '');
  const [year, setYear] = useState(initialYear === null ? '' : String(initialYear));
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState<{ query: string; year: number | null } | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [language, setLanguage] = useState<string>(LANGUAGES[0]);
  const [seasons, setSeasons] = useState('');

  const afterAttach = () => {
    setAttaching(null);
    setTvdbPick(null);
    void queryClient.invalidateQueries({ queryKey: ['review'] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
    void queryClient.invalidateQueries({ queryKey: ['title'] });
  };

  const search = useQuery({
    queryKey: ['omdb-search', topicId, submitted],
    queryFn: () => api.omdbSearch(submitted?.query ?? '', submitted?.year ?? null),
    enabled: submitted !== null && confirmed && (submitted?.query.length ?? 0) > 0,
  });

  const bind = useMutation({
    mutationFn: (hit: OmdbHit) =>
      api.bindManual(topicId, {
        imdbId: hit.imdbId,
        mediaType: hit.mediaType,
        title: hit.title,
        year: hit.year,
        originalLanguage: language,
        seasons: hit.mediaType === 'tv' && seasons.trim() ? Number(seasons) : null,
        poster: hit.poster,
      }),
    onSuccess: () => afterAttach(),
  });

  const [tvdbText, setTvdbText] = useState(initialQuery ?? '');
  const [tvdbQuery, setTvdbQuery] = useState<string | null>(null);
  const [tvdbPick, setTvdbPick] = useState<TvdbHit | null>(null);

  const tvdbSearch = useQuery({
    queryKey: ['tvdb-search', topicId, tvdbQuery],
    queryFn: () => api.tvdbSearch(tvdbQuery ?? ''),
    enabled: tvdbQuery !== null && (tvdbQuery?.length ?? 0) > 0,
  });

  // A detail fetch costs a TVDB request, so it is keyed on the row the reviewer clicked.
  const tvdbDetail = useQuery({
    queryKey: ['tvdb-series', tvdbPick?.tvdbId ?? null],
    queryFn: () => api.tvdbSeries(tvdbPick?.tvdbId ?? 0),
    enabled: tvdbPick !== null,
  });

  const [tvdbLanguage, setTvdbLanguage] = useState<string | null>(null);
  const [tvdbSeasons, setTvdbSeasons] = useState<string | null>(null);

  const attachToTmdb = useMutation({
    mutationFn: (tmdbId: number) => api.bindTopic(topicId, tmdbId, 'tv'),
    onSuccess: () => afterAttach(),
  });

  const attachManually = useMutation({
    mutationFn: (input: { imdbId: string; title: string; year: number | null; language: string; seasons: number | null }) =>
      api.bindManual(topicId, {
        imdbId: input.imdbId,
        mediaType: 'tv',
        title: input.title,
        year: input.year,
        originalLanguage: input.language,
        seasons: input.seasons,
      }),
    onSuccess: () => afterAttach(),
  });

  /** The client maps TVDB's ISO-639-2 to ISO-639-1; an unmapped code means "ask the reviewer". */
  const languageOption = (code: string | null | undefined): string =>
    code !== null && code !== undefined && (LANGUAGES as readonly string[]).includes(code) ? code : '';

  const tvdbPicked = tvdbDetail.data;
  const tvdbChosenLanguage = tvdbLanguage ?? languageOption(tvdbPicked?.originalLanguage);

  const omdbVisible = providers.data?.omdb === true;
  // TVDB is shows-only, and its name search is weak for regional serials.
  const tvdbVisible = providers.data?.tvdb === true && kind === 'tv';
  if (!omdbVisible && !tvdbVisible) return null;

  const results = search.data?.results ?? [];

  return (
    <div className="space-y-2">
      {omdbVisible ? (
        <div className="rounded border border-neutral-800 bg-neutral-950/40 p-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">link to an OMDb title</div>

      <label className="mt-1 flex items-start gap-1.5 text-[11px] text-neutral-400">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5"
        />
        <span>Manual OMDb search uses 1 of your 1,000 free daily requests</span>
      </label>

      <form
        className="mt-1 flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed) return;
          setSubmitted({ query: text.trim(), year: year.trim() ? Number(year) : null });
        }}
      >
        <input
          aria-label="OMDb search query"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="title"
          className="min-w-40 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
        />
        <input
          aria-label="OMDb search year"
          value={year}
          onChange={(event) => setYear(event.target.value)}
          placeholder="year"
          inputMode="numeric"
          className="w-16 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
        />
        <button
          type="submit"
          disabled={!confirmed || text.trim().length === 0 || search.isFetching}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
        >
          search OMDb
        </button>
      </form>

      <ErrorNote error={search.error ?? bind.error} />

      {submitted && search.isFetched && results.length === 0 && !search.error ? (
        <div className="mt-2">
          <Empty>No OMDb candidates — OMDb spells titles the way IMDb does.</Empty>
        </div>
      ) : null}

      {results.length > 0 ? (
        <ul className="mt-2 divide-y divide-neutral-900">
          {results.map((hit) => (
            <li key={hit.imdbId} className="py-1 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-neutral-200">
                  {hit.title}
                  {hit.year === null ? '' : ` (${hit.year})`}
                </span>
                <Badge>{hit.mediaType}</Badge>
                <Badge>{hit.imdbId}</Badge>
                <button
                  type="button"
                  onClick={() => setAttaching(attaching === hit.imdbId ? null : hit.imdbId)}
                  className="shrink-0 rounded border border-emerald-700 px-1.5 py-0.5 text-emerald-300 hover:border-emerald-500"
                >
                  use this
                </button>
              </div>

              {attaching === hit.imdbId ? (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <label className="text-neutral-500">
                    original language
                    <select
                      aria-label="original language"
                      value={language}
                      onChange={(event) => setLanguage(event.target.value)}
                      className="ml-1 rounded border border-neutral-800 bg-neutral-950 px-1 py-0.5 text-neutral-200"
                    >
                      {LANGUAGES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </label>
                  {hit.mediaType === 'tv' || kind === 'tv' ? (
                    <label className="text-neutral-500">
                      seasons
                      <input
                        aria-label="seasons"
                        value={seasons}
                        onChange={(event) => setSeasons(event.target.value)}
                        inputMode="numeric"
                        className="ml-1 w-14 rounded border border-neutral-800 bg-neutral-950 px-1 py-0.5 text-neutral-200"
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    disabled={bind.isPending}
                    onClick={() => bind.mutate(hit)}
                    className="rounded border border-emerald-700 px-1.5 py-0.5 text-emerald-300 hover:border-emerald-500 disabled:opacity-40"
                  >
                    attach
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
        </div>
      ) : null}

      {tvdbVisible ? (
        <div className="rounded border border-neutral-800 bg-neutral-950/40 p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">find it on TVDB</div>
            <a
              href={tvdbPick === null ? 'https://thetvdb.com' : `https://thetvdb.com/series/${tvdbPick.slug ?? tvdbPick.tvdbId}`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
            >
              Metadata provided by TheTVDB
            </a>
          </div>

          <form
            data-testid="tvdb-search-form"
            className="mt-1 flex flex-wrap items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (tvdbText.trim().length === 0) return;
              setTvdbPick(null);
              setTvdbQuery(tvdbText.trim());
            }}
          >
            <input
              aria-label="TVDB search query"
              value={tvdbText}
              onChange={(event) => setTvdbText(event.target.value)}
              placeholder="series name"
              className="min-w-40 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
            />
            <button
              type="submit"
              disabled={tvdbText.trim().length === 0 || tvdbSearch.isFetching}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
            >
              search TVDB
            </button>
          </form>

          <ErrorNote error={tvdbSearch.error ?? tvdbDetail.error ?? attachToTmdb.error ?? attachManually.error} />

          {tvdbQuery !== null && tvdbSearch.isFetched && (tvdbSearch.data?.results.length ?? 0) === 0 && !tvdbSearch.error ? (
            <div className="mt-2">
              <Empty>No TVDB candidates — TVDB is weakest on regional serials.</Empty>
            </div>
          ) : null}

          {(tvdbSearch.data?.results.length ?? 0) > 0 ? (
            <ul className="mt-2 divide-y divide-neutral-900">
              {(tvdbSearch.data?.results ?? []).map((hit) => (
                <li key={hit.tvdbId} className="py-1 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-neutral-200">
                      {hit.title}
                      {hit.year === null ? '' : ` (${hit.year})`}
                    </span>
                    {hit.network === null ? null : <Badge>{hit.network}</Badge>}
                    <button
                      type="button"
                      onClick={() => {
                        // Never carry one hit's edit into another: the payload would file it under
                        // the wrong series.
                        setTvdbLanguage(null);
                        setTvdbSeasons(null);
                        setTvdbPick(tvdbPick?.tvdbId === hit.tvdbId ? null : hit);
                      }}
                      className="shrink-0 rounded border border-emerald-700 px-1.5 py-0.5 text-emerald-300 hover:border-emerald-500"
                    >
                      use this
                    </button>
                  </div>

                  {tvdbPick?.tvdbId === hit.tvdbId ? (
                    <div className="mt-1 text-neutral-400">
                      {tvdbDetail.isLoading ? 'loading…' : null}
                      {tvdbDetail.data === undefined ? null : (
                        <dl className="flex flex-wrap gap-x-3 gap-y-0.5">
                          <dt className="text-neutral-500">language</dt>
                          <dd>{tvdbDetail.data.originalLanguage ?? 'unknown'}</dd>
                          <dt className="text-neutral-500">country</dt>
                          <dd>{tvdbDetail.data.originalCountry ?? 'unknown'}</dd>
                          <dt className="text-neutral-500">seasons</dt>
                          <dd>{tvdbDetail.data.seasons ?? 'unknown'}</dd>
                          <dt className="text-neutral-500">episodes</dt>
                          <dd>{tvdbDetail.data.episodes === null ? 'unknown' : `${tvdbDetail.data.episodes} episodes`}</dd>
                          <dt className="text-neutral-500">imdb</dt>
                          <dd>{tvdbDetail.data.imdbId ?? 'none'}</dd>
                        </dl>
                      )}
                      {tvdbDetail.data === undefined ? null : tvdbDetail.data.imdbId === null && tvdbDetail.data.tmdbId === null ? (
                        <div className="mt-1 text-amber-400">No linked IMDb or TMDB record — cannot attach.</div>
                      ) : (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {tvdbDetail.data.tmdbId === null ? (
                            <>
                              <label className="text-neutral-500">
                                original language
                                <select
                                  aria-label="original language"
                                  value={tvdbChosenLanguage}
                                  onChange={(event) => setTvdbLanguage(event.target.value)}
                                  className="ml-1 rounded border border-neutral-800 bg-neutral-950 px-1 py-0.5 text-neutral-200"
                                >
                                  <option value="">pick…</option>
                                  {LANGUAGES.map((code) => (
                                    <option key={code} value={code}>
                                      {code}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="text-neutral-500">
                                seasons
                                <input
                                  aria-label="seasons"
                                  value={tvdbSeasons ?? (tvdbDetail.data.seasons === null ? '' : String(tvdbDetail.data.seasons))}
                                  onChange={(event) => setTvdbSeasons(event.target.value)}
                                  inputMode="numeric"
                                  className="ml-1 w-14 rounded border border-neutral-800 bg-neutral-950 px-1 py-0.5 text-neutral-200"
                                />
                              </label>
                            </>
                          ) : (
                            <span className="text-neutral-500">TMDB has this title ({tvdbDetail.data.tmdbId}) — bind directly.</span>
                          )}
                          <button
                            type="button"
                            disabled={
                              attachToTmdb.isPending ||
                              attachManually.isPending ||
                              (tvdbDetail.data.tmdbId === null && tvdbChosenLanguage === '')
                            }
                            onClick={() => {
                              const detail = tvdbDetail.data;
                              if (detail === undefined) return;
                              if (detail.tmdbId !== null) {
                                attachToTmdb.mutate(detail.tmdbId);
                                return;
                              }
                              if (detail.imdbId === null || tvdbChosenLanguage === '') return;
                              attachManually.mutate({
                                imdbId: detail.imdbId,
                                title: detail.title,
                                year: detail.year,
                                language: tvdbChosenLanguage,
                                seasons: tvdbSeasons === null || tvdbSeasons.trim().length === 0 ? detail.seasons : Number(tvdbSeasons),
                              });
                            }}
                            className="rounded border border-emerald-700 px-1.5 py-0.5 text-emerald-300 hover:border-emerald-500 disabled:opacity-40"
                          >
                            attach
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
