import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, logEvents, media, rules, sources, topics, variants } from '@tamilcache/db/schema';
import { OmdbClient, TmdbClient, TvdbClient } from '@tamilcache/worker';
import { buildApp } from '../src/server.js';
import { SYNTHETIC_TORRENT, SYNTHETIC_INFOHASH } from '../../../packages/shared/test/fixtures/synthetic-torrent.js';

const KEY = 'k';
let db: Db;

function app() {
  return buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484' });
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 22, name: 'Telugu', inScope: true }).run();
  const topic = db
    .insert(topics)
    .values({ sourceId: 1, forumId: 1, sourceTopicId: 7, slug: 'x-2026-telugu-hq-clean', rawTitle: 'X (2026) Telugu HQ Clean', kind: 'movie' })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      resolution: '720p',
      sourceTagRaw: 'HQ HDRip',
      sourceTag: 'WEBRip',
      audioLangs: [],
      sizeBytes: 1000,
      infohash: 'a'.repeat(40),
      normTitle: 'x.2026.720p.WEBRip.Telugu.1GB-TMV',
      decision: 'unknown',
      reviewReason: 'NO_AUDIO_TAG',
      isPreferred: true,
    })
    .run();
});

const url = (path: string) => `${path}${path.includes('?') ? '&' : '?'}apikey=${KEY}`;

describe('stats', () => {
  it('reports counters and the review backlog', async () => {
    const response = await app().inject({ url: url('/api/v1/stats') });
    const body = response.json() as { variants: number; byDecision: Record<string, number>; reviewQueue: Record<string, number> };
    expect(body.variants).toBe(1);
    expect(body.byDecision['unknown']).toBe(1);
    expect(body.reviewQueue['NO_AUDIO_TAG']).toBe(1);
  });

  // The two dashboard cards are links to /browse, so the count has to match the page: a media row
  // whose every variant is non-Hindi or non-preferred is not in the library the card opens.
  it('counts only the titles Browse would show, not every media row', async () => {
    const inserted = db
      .insert(media)
      .values([
        { tmdbId: 9001, type: 'movie', title: 'Hindi Movie' },
        { tmdbId: 9002, type: 'movie', title: 'Unbrowsable Movie' },
        { tmdbId: 9003, type: 'tv', title: 'Hindi Show' },
      ])
      .returning()
      .all();
    const topicId = db.select().from(topics).limit(1).get()?.id ?? 0;

    db.insert(variants)
      .values([
        { topicId, mediaId: inserted[0]?.id, resolution: '1080p', sourceTagRaw: 'WEB-DL', sourceTag: 'WEB-DL', sizeBytes: 1, infohash: '1'.repeat(40), decision: 'hindi_dubbed', isPreferred: true },
        { topicId, mediaId: inserted[1]?.id, resolution: '1080p', sourceTagRaw: 'WEB-DL', sourceTag: 'WEB-DL', sizeBytes: 1, infohash: '2'.repeat(40), decision: 'not_hindi', isPreferred: true },
        { topicId, mediaId: inserted[2]?.id, resolution: '1080p', sourceTagRaw: 'WEB-DL', sourceTag: 'WEB-DL', sizeBytes: 1, infohash: '3'.repeat(40), decision: 'hindi_original', isPreferred: true },
      ])
      .run();

    const body = (await app().inject({ url: url('/api/v1/stats') })).json() as { movies: number; shows: number };

    expect(body.movies).toBe(1);
    expect(body.shows).toBe(1);
  });
});

describe('browse', () => {
  it('filters by decision and returns classified links', async () => {
    const response = await app().inject({ url: url('/api/v1/browse?decision=unknown') });
    const body = response.json() as { total: number; rows: Array<{ links: unknown[] }> };
    expect(body.total).toBe(1);
    expect(Array.isArray(body.rows[0]?.links)).toBe(true);
  });

  it('filters by hasMagnet (across all decisions, since the default view is Hindi-only)', async () => {
    const all = '&decision=all';
    expect(((await app().inject({ url: url(`/api/v1/browse?hasMagnet=false${all}`) })).json() as { total: number }).total).toBe(1);
    expect(((await app().inject({ url: url(`/api/v1/browse?hasMagnet=true${all}`) })).json() as { total: number }).total).toBe(0);
  });

  it('hides a non-Hindi row from the default view but keeps it reachable', async () => {
    expect(((await app().inject({ url: url('/api/v1/browse') })).json() as { total: number }).total).toBe(0);
    expect(((await app().inject({ url: url('/api/v1/browse?decision=all') })).json() as { total: number }).total).toBe(1);
    expect(((await app().inject({ url: url('/api/v1/browse?decision=unknown') })).json() as { total: number }).total).toBe(1);
  });
});

describe('review queue', () => {
  it('groups by reason with evidence', async () => {
    const body = (await app().inject({ url: url('/api/v1/review') })).json() as {
      total: number;
      groups: Array<{ reason: string; count: number; items: Array<{ slug: string; forumName: string }> }>;
    };
    expect(body.total).toBe(1);
    expect(body.groups[0]?.reason).toBe('NO_AUDIO_TAG');
    expect(body.groups[0]?.items[0]?.slug).toBe('x-2026-telugu-hq-clean');
    expect(body.groups[0]?.items[0]?.forumName).toBe('Telugu');
  });

  it('gives every review row its tamilmv permalink', async () => {
    const body = (await app().inject({ url: url('/api/v1/review') })).json() as {
      groups: Array<{ items: Array<{ link: string }> }>;
    };
    expect(body.groups[0]?.items[0]?.link).toMatch(/\/index\.php\?\/forums\/topic\/\d+-.+\/$/);
  });
});

describe('review decide', () => {
  it('writes an override and replays', async () => {
    const preview = (await app().inject({ url: url('/api/v1/review/preview'), method: 'POST', payload: { predicate: { forumIds: [1] }, action: 'hindi_dubbed' } })).json() as { affected: number };
    expect(preview.affected).toBe(1);

    const decide = (await app().inject({ url: url('/api/v1/review/decide'), method: 'POST', payload: { variantIds: [1], action: 'hindi_dubbed' } })).json() as {
      affected: number;
      replay: { updated: number };
    };
    expect(decide.affected).toBe(1);
    expect(decide.replay.updated).toBe(1);
    expect(db.select().from(variants).all()[0]?.decision).toBe('hindi_dubbed');
  });

  it('dry-run does not write', async () => {
    const body = (await app().inject({ url: url('/api/v1/review/decide'), method: 'POST', payload: { variantIds: [1], action: 'hindi_dubbed', dryRun: true } })).json() as { dryRun: boolean };
    expect(body.dryRun).toBe(true);
    expect(db.select().from(variants).all()[0]?.decision).toBe('unknown');
  });

  it('applyToSimilar writes a rule and reclassifies everything matching', async () => {
    const body = (await app().inject({
      url: url('/api/v1/review/decide'),
      method: 'POST',
      payload: { applyToSimilar: true, predicate: { forumIds: [1] }, action: 'hindi_dubbed' },
    })).json() as { affected: number; replay: { updated: number } };
    expect(body.affected).toBe(1);
    expect(db.select().from(rules).all()).toHaveLength(1);
    expect(db.select().from(variants).all()[0]?.decision).toBe('hindi_dubbed');
  });

  it('rejects an invalid predicate', async () => {
    const response = await app().inject({ url: url('/api/v1/review/preview'), method: 'POST', payload: { predicate: { titleMatches: '(' } } });
    expect(response.statusCode).toBe(400);
  });
});

describe('rules', () => {
  it('creates, disables and deletes a rule, replaying each time', async () => {
    const created = (await app().inject({ url: url('/api/v1/rules'), method: 'POST', payload: { predicate: { forumIds: [1] }, action: 'hindi_dubbed' } })).json() as { rule: { id: number } };
    expect(created.rule.id).toBeGreaterThan(0);
    expect(db.select().from(variants).all()[0]?.decision).toBe('hindi_dubbed');

    await app().inject({ url: url(`/api/v1/rules/${created.rule.id}`), method: 'PATCH', payload: { enabled: false } });
    expect(db.select().from(variants).all()[0]?.decision).toBe('unknown');

    await app().inject({ url: url(`/api/v1/rules/${created.rule.id}`), method: 'DELETE' });
    expect(db.select().from(rules).all()).toHaveLength(0);
  });
});

describe('torrent upload', () => {
  it('derives the infohash from the uploaded file and fills the magnet', async () => {
    const torrent = SYNTHETIC_TORRENT;
    const boundary = '----testboundary';
    const parts = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="sample.torrent"',
      'Content-Type: application/x-bittorrent',
      '',
    ].join('\r\n');
    const payload = Buffer.concat([
      Buffer.from(`${parts}\r\n`),
      torrent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app().inject({
      url: url('/api/v1/torrents/1'),
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { infohash: string };
    expect(body.infohash).toBe(SYNTHETIC_INFOHASH);
    expect(db.select().from(variants).all()[0]?.infohash).toBe(body.infohash);
  });
});

describe('review proposals', () => {
  it('exposes the provider proposal next to the review row', async () => {
    db.update(topics)
      .set({
        providerStatus: 'ambiguous',
        providerProposal: JSON.stringify({ tmdbId: 11, title: 'Land', year: 2026, score: 74 }),
      })
      .run();

    const body = (await app().inject({ url: url('/api/v1/review') })).json() as {
      groups: Array<{ items: Array<{ providerStatus: string; providerProposal: string | null }> }>;
    };
    expect(body.groups[0]?.items[0]?.providerStatus).toBe('ambiguous');
    expect(body.groups[0]?.items[0]?.providerProposal).toContain('"tmdbId":11');
  });

  it('recheck clears the stamp so the worker searches again', async () => {
    db.update(topics).set({ providerStatus: 'none', providerCheckedAt: '2026-11-09T00:00:00.000Z' }).run();
    await app().inject({ url: url('/api/v1/titles/1/recheck'), method: 'POST' });

    const topic = db.select().from(topics).all()[0];
    expect(topic?.providerStatus).toBe('pending');
    expect(topic?.providerCheckedAt).toBeNull();
  });
});

describe('title detail coverage', () => {
  it('reports aired vs covered episodes and the missing list', async () => {
    const { media, mediaEpisodes } = await import('@tamilcache/db/schema');
    const mediaRow = db
      .insert(media)
      .values({ tmdbId: 337062, type: 'tv', title: 'Panthadikkaam', year: 2026, originalLanguage: 'ml' })
      .returning()
      .get();
    for (const [episode, airDate] of [[1, '2026-10-01'], [2, '2026-10-08'], [3, '2026-10-15'], [4, '2099-01-01']] as const) {
      db.insert(mediaEpisodes).values({ mediaId: mediaRow.id, season: 1, episode, airDate, name: `E${episode}` }).run();
    }

    // The cached release covers episodes 1-2 of season 1.
    db.update(topics).set({ kind: 'show' }).run();
    db.update(variants).set({ mediaId: mediaRow.id, season: 1, epFrom: 1, epTo: 2, isPack: true }).run();

    const body = (await app().inject({ url: url('/api/v1/titles/x-2026-telugu-hq-clean') })).json() as {
      coverage: { aired: number; covered: number };
      missing: Array<{ episode: number }>;
      episodes: Array<{ episode: number; covered: boolean; aired: boolean }>;
    };

    // Episode 4 airs in the future, so it is neither "aired" nor "missing".
    expect(body.coverage).toEqual({ aired: 3, covered: 2 });
    expect(body.missing.map((episode) => episode.episode)).toEqual([3]);
    expect(body.episodes.find((episode) => episode.episode === 4)?.aired).toBe(false);
  });

  it('lists a genuinely missing aired episode', async () => {
    const { media, mediaEpisodes } = await import('@tamilcache/db/schema');
    const mediaRow = db
      .insert(media)
      .values({ tmdbId: 5, type: 'tv', title: 'Show', year: 2026, originalLanguage: 'ta' })
      .returning()
      .get();
    for (const episode of [1, 2, 3]) {
      db.insert(mediaEpisodes).values({ mediaId: mediaRow.id, season: 1, episode, airDate: '2026-01-01', name: null }).run();
    }
    db.update(topics).set({ kind: 'show' }).run();
    db.update(variants).set({ mediaId: mediaRow.id, season: 1, epFrom: 1, epTo: 2, isPack: true }).run();

    const body = (await app().inject({ url: url('/api/v1/titles/x-2026-telugu-hq-clean') })).json() as {
      missing: Array<{ episode: number }>;
    };
    expect(body.missing.map((episode) => episode.episode)).toEqual([3]);
  });
});

describe('title detail prefers a linked variant', () => {
  it('takes provider fields from whichever variant has media', async () => {
    const { media } = await import('@tamilcache/db/schema');
    const mediaRow = db
      .insert(media)
      .values({ tmdbId: 4242, type: 'movie', title: 'Linked Title', year: 2024, originalLanguage: 'hi', imdbId: 'tt9' })
      .returning()
      .get();
    // A better-ranked variant with no media, plus a worse-ranked one that is linked.
    db.update(variants).set({ qualityRank: 5000 }).run();
    db.insert(variants)
      .values({
        topicId: 1,
        resolution: '720p',
        sourceTagRaw: 'BR-Rip',
        sourceTag: 'BRRip',
        audioLangs: ['hindi'],
        sizeBytes: 1,
        infohash: 'z'.repeat(40),
        qualityRank: 1,
        mediaId: mediaRow.id,
        decision: 'hindi_original',
      })
      .run();

    const body = (await app().inject({ url: url('/api/v1/titles/x-2026-telugu-hq-clean') })).json() as {
      tmdbId: number | null;
      title: string;
    };
    expect(body.tmdbId).toBe(4242);
    expect(body.title).toBe('Linked Title');
  });
});

describe('review action validation (corpus-corruption guards)', () => {
  it('rejects an unknown action instead of writing it to the column', async () => {
    const response = await app().inject({ url: url('/api/v1/review/decide'), method: 'POST', payload: { variantIds: [1], action: 'garbage' } });
    expect(response.statusCode).toBe(400);
    expect(db.select().from(variants).all()[0]?.decision).toBe('unknown');
  });

  it('rejects an empty predicate, which would match every row', async () => {
    const response = await app().inject({
      url: url('/api/v1/review/decide'),
      method: 'POST',
      payload: { applyToSimilar: true, predicate: {}, action: 'hindi_dubbed' },
    });
    expect(response.statusCode).toBe(400);
    expect(db.select().from(rules).all()).toHaveLength(0);
  });

  it('requires a predicate when applyToSimilar is set', async () => {
    const response = await app().inject({ url: url('/api/v1/review/decide'), method: 'POST', payload: { applyToSimilar: true, action: 'hindi_dubbed' } });
    expect(response.statusCode).toBe(400);
  });
});

describe('numeric path params', () => {
  it('returns 400 rather than a driver throw for a non-numeric id', async () => {
    for (const path of ['/api/v1/rules/abc', '/api/v1/titles/abc/recheck', '/api/v1/torrents/abc']) {
      const response = await app().inject({ url: url(path), method: path.includes('rules') ? 'DELETE' : 'POST', payload: {} });
      expect([400, 404]).toContain(response.statusCode);
      expect(response.body).not.toMatch(/SqliteError|better-sqlite3/);
    }
  });
});

describe('applyToSimilar idempotency', () => {
  it('does not create a duplicate rule when the same teaching is applied twice', async () => {
    const payload = { applyToSimilar: true, predicate: { forumIds: [1] }, action: 'hindi_dubbed' };
    await app().inject({ url: url('/api/v1/review/decide'), method: 'POST', payload });
    await app().inject({ url: url('/api/v1/review/decide'), method: 'POST', payload });
    expect(db.select().from(rules).all()).toHaveLength(1);
  });
});

describe('review search hints', () => {
  type ReviewItem = { kind: string; searchQuery: string | null; searchYear: number | null };
  const items = async (): Promise<ReviewItem[]> => {
    const body = (await app().inject({ url: url('/api/v1/review') })).json() as {
      groups: Array<{ items: ReviewItem[] }>;
    };
    return body.groups.flatMap((group) => group.items);
  };

  it('carries the kind and a TMDB query prefill derived from the slug', async () => {
    const [item] = await items();
    expect(item?.kind).toBe('movie');
    expect(item?.searchQuery).toBe('x');
    expect(item?.searchYear).toBe(2026);
  });

  it('reports show topics as tv', async () => {
    db.update(topics).set({ kind: 'show' }).run();
    const [item] = await items();
    expect(item?.kind).toBe('tv');
  });

  it('falls back to the header title when the slug is unusable', async () => {
    db.update(topics).set({ slug: '', rawTitle: 'Kara (2026) Telugu HQ Clean' }).run();
    const [item] = await items();
    // queryFromTitle strips the tagging vocabulary and the year but keeps the title's own casing.
    expect(item?.searchQuery).toBe('Kara');
    expect(item?.searchYear).toBe(2026);
  });
});

describe('manual TMDB search', () => {
  // A real TmdbClient with an injected fetch: the route's own instance is replaced per test.
  function withTmdb(results: unknown[]) {
    const urls: string[] = [];
    const client = new TmdbClient({
      apiKey: 'test',
      minIntervalMs: 0,
      fetchImpl: async (fetchUrl) => {
        urls.push(fetchUrl);
        return new Response(JSON.stringify({ results }), { status: 200 });
      },
    });
    return { client, urls };
  }

  const RAW = [
    { id: 1, media_type: 'movie', title: 'Kara', release_date: '2026-01-01', original_language: 'ta', popularity: 9 },
    { id: 2, media_type: 'tv', name: 'Kara', first_air_date: '2006-01-01', original_language: 'ta', popularity: 3 },
  ];

  it('returns scored candidates when a kind is given', async () => {
    const { client } = withTmdb(RAW);
    const app2 = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tmdb: client });
    const body = (await app2.inject({ url: url('/api/v1/tmdb/search?q=kara&year=2026&kind=movie') })).json() as {
      results: Array<{ id: number; score: number; reasons: string[] }>;
    };
    expect(body.results[0]?.id).toBe(1);
    expect(body.results[0]?.score).toBeGreaterThan(0);
    expect(body.results[0]?.reasons).toContain('title exact');
  });

  it('keeps a wrong-type candidate when ranking for a human', async () => {
    const { client } = withTmdb(RAW);
    const app2 = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tmdb: client });
    const body = (await app2.inject({ url: url('/api/v1/tmdb/search?q=kara&year=2026&kind=movie') })).json() as {
      results: Array<{ id: number }>;
    };
    expect(body.results.map((r) => r.id)).toContain(2);
  });

  it('stays raw when no kind is given', async () => {
    const { client } = withTmdb(RAW);
    const app2 = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tmdb: client });
    const body = (await app2.inject({ url: url('/api/v1/tmdb/search?q=kara') })).json() as {
      results: Array<{ id: number; score?: number }>;
    };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]?.score).toBeUndefined();
  });

  it('does not call TMDB for a blank query', async () => {
    const { client, urls } = withTmdb(RAW);
    const app2 = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tmdb: client });
    const response = await app2.inject({ url: url('/api/v1/tmdb/search?q=%20%20') });
    expect(response.statusCode).toBe(400);
    expect(urls).toHaveLength(0);
  });
});

describe('LIKE wildcard escaping', () => {
  it('treats % as a literal, not a wildcard', async () => {
    const response = await app().inject({ url: url('/api/v1/browse?q=%25') });
    expect((response.json() as { total: number }).total).toBe(0);
  });
});

describe('title detail search hints', () => {
  it('carries the kind and the TMDB query prefill for an unbound title', async () => {
    // The fixture topic in beforeEach has slug 'x-2026-telugu-hq-clean', kind 'movie', and no media row.
    const body = (await app().inject({ url: url('/api/v1/titles/x-2026-telugu-hq-clean') })).json() as {
      tmdbId: number | null;
      kind: string;
      searchQuery: string | null;
      searchYear: number | null;
      variants: Array<{ topicId: number }>;
    };
    expect(body.tmdbId).toBeNull();
    expect(body.kind).toBe('movie');
    expect(body.searchQuery).toBe('x');
    expect(body.searchYear).toBe(2026);
    // The page binds by topic id, so the payload must carry one.
    expect(body.variants[0]?.topicId).toBeGreaterThan(0);
  });
});

describe('api telemetry', () => {
  it('records every request at debug when the api scope is enabled', async () => {
    process.env['LOG_DEBUG_SCOPES'] = 'api';
    try {
      await app().inject({ url: url('/api/v1/health') });
      const rows = db.select().from(logEvents).all().filter((row) => row.event === 'request');
      expect(rows.some((row) => row.scope === 'api')).toBe(true);
    } finally {
      delete process.env['LOG_DEBUG_SCOPES'];
    }
  });

  it('records a 500 as an api error', async () => {
    const instance = app();
    instance.get('/api/v1/boom', async () => {
      throw new Error('boom');
    });
    const response = await instance.inject({ url: url('/api/v1/boom') });
    expect(response.statusCode).toBe(500);
    const errors = db.select().from(logEvents).all().filter((row) => row.event === 'error');
    expect(errors.some((row) => row.scope === 'api' && row.level === 'error')).toBe(true);
  });

  it('attributes a review decision to the web actor and keeps it as audit', async () => {
    const variant = db.select().from(variants).all()[0]!;
    await app().inject({
      method: 'POST',
      url: url('/api/v1/review/decide'),
      payload: { variantIds: [variant.id], action: 'hindi_dubbed' },
    });
    const decide = db.select().from(logEvents).all().find((row) => row.event === 'decide')!;
    expect(decide.class).toBe('audit');
    expect(decide.scope).toBe('review');
    expect(decide.detail).toContain('"actor":"web"');
  });

  it('attributes a crawl lane change to the api actor', async () => {
    await app().inject({ method: 'POST', url: url('/api/v1/crawl/backfill'), payload: { armed: true } });
    const change = db.select().from(logEvents).all().find((row) => row.event === 'change')!;
    expect(change.class).toBe('audit');
    expect(change.source).toBe('api');
    expect(change.detail).toContain('"actor":"api"');
  });
});

describe('omdb', () => {
  it('answers 503 when no key is configured', async () => {
    const response = await app().inject({ url: url('/api/v1/omdb/search?q=jailer') });
    expect(response.statusCode).toBe(503);
  });

  it('spends one request per search and returns mapped hits', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ Search: [{ Title: 'Jailer', Year: '2023', imdbID: 'tt26756011', Type: 'movie' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const omdb = new OmdbClient({ apiKey: 'omdb-k', fetchImpl });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', omdb });

    const body = (await client.inject({ url: url('/api/v1/omdb/search?q=jailer&year=2023') })).json() as {
      results: Array<{ imdbId: string; mediaType: string }>;
    };

    expect(body.results[0]).toMatchObject({ imdbId: 'tt26756011', mediaType: 'movie' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not search on read — the review queue must never spend a request', async () => {
    const fetchImpl = vi.fn();
    const omdb = new OmdbClient({ apiKey: 'omdb-k', fetchImpl });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', omdb });

    await client.inject({ url: url('/api/v1/review') });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports which optional providers are configured', async () => {
    const omdb = new OmdbClient({ apiKey: 'omdb-k', fetchImpl: async () => new Response('{}') });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', omdb });

    const body = (await client.inject({ url: url('/api/v1/providers') })).json() as { omdb: boolean; tvdb: boolean };
    expect(body).toEqual({ omdb: true, tvdb: false });
  });
});

describe('tvdb', () => {
  it('answers 503 when no key is configured', async () => {
    expect((await app().inject({ url: url('/api/v1/tvdb/search?q=x') })).statusCode).toBe(503);
  });

  it('returns series hits', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login')
        ? new Response(JSON.stringify({ data: { token: 't' } }), { status: 200 })
        : new Response(JSON.stringify({ data: [{ tvdb_id: 1, name: 'Show', year: '2020' }] }), { status: 200 }),
    );
    const tvdb = new TvdbClient({ apiKey: 'tvdb-k', fetchImpl });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tvdb });

    const body = (await client.inject({ url: url('/api/v1/tvdb/search?q=show') })).json() as {
      results: Array<{ tvdbId: number }>;
    };
    expect(body.results[0]?.tvdbId).toBe(1);
  });

  it('reports the provider as available', async () => {
    const tvdb = new TvdbClient({ apiKey: 'tvdb-k', fetchImpl: async () => new Response('{}') });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tvdb });

    const body = (await client.inject({ url: url('/api/v1/providers') })).json() as { omdb: boolean; tvdb: boolean };
    expect(body).toEqual({ omdb: false, tvdb: true });
  });

  it('exposes a series detail route, 503 without a key', async () => {
    expect((await app().inject({ url: url('/api/v1/tvdb/series/483535') })).statusCode).toBe(503);
  });

  it('rejects a non-numeric series id', async () => {
    const tvdb = new TvdbClient({ apiKey: 'tvdb-k', fetchImpl: async () => new Response('{}') });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tvdb });
    expect((await client.inject({ url: url('/api/v1/tvdb/series/abc') })).statusCode).toBe(400);
  });

  it('returns the mapped series including the remote ids', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/login')
        ? new Response(JSON.stringify({ data: { token: 't' } }), { status: 200 })
        : new Response(
            JSON.stringify({
              data: {
                id: 483535,
                name: 'Karthika Deepam',
                originalLanguage: 'tel',
                seasons: [{ id: 1 }, { id: 2 }],
                episodes: [{ id: 1 }],
                remoteIds: [
                  { id: 'tt1234567', type: 2, sourceName: 'IMDB' },
                  { id: '15643', type: 12, sourceName: 'TheMovieDB.com' },
                ],
              },
            }),
            { status: 200 },
          ),
    );
    const tvdb = new TvdbClient({ apiKey: 'tvdb-k', fetchImpl });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tvdb });

    const body = (await client.inject({ url: url('/api/v1/tvdb/series/483535') })).json() as {
      originalLanguage: string;
      imdbId: string;
      tmdbId: number;
      seasons: number;
    };
    expect(body).toMatchObject({ originalLanguage: 'te', imdbId: 'tt1234567', tmdbId: 15643, seasons: 2 });
  });

  it('answers 502 when the upstream call throws, without echoing the upstream path', async () => {
    const tvdb = new TvdbClient({
      apiKey: 'tvdb-k',
      fetchImpl: async () => new Response('boom', { status: 500 }),
      sleep: async () => {},
    });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tvdb });
    const response = await client.inject({ url: url('/api/v1/tvdb/series/483535') });
    expect(response.statusCode).toBe(502);
    // The upstream path is internal: the client gets a generic message, the log keeps the detail.
    expect(response.body).not.toContain('/series/483535');
  });
});

describe('bind-manual', () => {
  it('stores a manual row and returns the replay summary', async () => {
    const tmdb = new TmdbClient({
      apiKey: 'k',
      fetchImpl: async () => new Response(JSON.stringify({ movie_results: [], tv_results: [] }), { status: 200 }),
    });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tmdb });

    const response = await client.inject({
      url: url('/api/v1/titles/1/bind-manual'),
      method: 'POST',
      payload: {
        imdbId: 'tt9216888',
        mediaType: 'tv',
        title: 'Karthika Deepam',
        year: 2017,
        originalLanguage: 'te',
        seasons: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { viaTmdb: boolean }).viaTmdb).toBe(false);
  });

  it('answers 409 when tmdb has several titles for the imdb id', async () => {
    const tmdb = new TmdbClient({
      apiKey: 'k',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            movie_results: [{ id: 1, title: 'A', popularity: 1 }],
            tv_results: [{ id: 2, name: 'B', popularity: 1 }],
          }),
          { status: 200 },
        ),
    });
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484', tmdb });

    const response = await client.inject({
      url: url('/api/v1/titles/1/bind-manual'),
      method: 'POST',
      payload: { imdbId: 'tt1234567', mediaType: 'movie', title: 'A', year: 2000, originalLanguage: 'en', seasons: null },
    });

    expect(response.statusCode).toBe(409);
  });

  it('rejects a malformed body', async () => {
    const client = buildApp({ db, apiKey: KEY, selfOrigin: 'http://localhost:8484' });
    const response = await client.inject({
      url: url('/api/v1/titles/1/bind-manual'),
      method: 'POST',
      payload: { imdbId: 'nope' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('manual titles', () => {
  it('never exposes the negative tmdb sentinel on the title page', async () => {
    const manual = db
      .insert(media)
      .values({
        tmdbId: -9216888,
        type: 'tv',
        title: 'Karthika Deepam',
        year: 2017,
        originalLanguage: 'te',
        imdbId: 'tt9216888',
        seasons: 3,
      })
      .returning()
      .get();
    db.update(variants).set({ mediaId: manual.id }).run();

    const body = (await app().inject({ url: url('/api/v1/titles/x-2026-telugu-hq-clean') })).json() as {
      tmdbId: number | null;
      imdbId: string | null;
    };

    expect(body.tmdbId).toBeNull();
    expect(body.imdbId).toBe('tt9216888');
  });
});

describe('manual rows', () => {
  it('never emits the negative tmdb sentinel in review or browse', async () => {
    // A manual row: `bindManual` keys these on the IMDb digits, negated, because `tmdb_id` is
    // NOT NULL UNIQUE and TMDB does not have the title.
    const manual = db
      .insert(media)
      .values({
        tmdbId: -9179430,
        type: 'movie',
        title: 'Vikram',
        year: 2022,
        imdbId: 'tt9179430',
        originalLanguage: 'ta',
      })
      .returning()
      .get();
    db.update(variants).set({ mediaId: manual.id }).run();

    const review = (await app().inject({ url: url('/api/v1/review') })).json() as {
      groups: Array<{ items: Array<{ tmdbId: number | null }> }>;
    };
    expect(review.groups.flatMap((group) => group.items)[0]?.tmdbId).toBeNull();

    const browse = (await app().inject({ url: url('/api/v1/browse?decision=unknown') })).json() as {
      rows: Array<{ tmdbId: number | null }>;
    };
    expect(browse.rows[0]?.tmdbId).toBeNull();
  });
});

describe('stats: preferred', () => {
  it('counts a title+resolution once even when two boards both have a preferred copy', async () => {
    const before = ((await app().inject({ url: url('/api/v1/stats') })).json() as { preferred: number }).preferred;
    const mediaRow = db.insert(media).values({ tmdbId: 9100, type: 'movie', title: 'Duped Film' }).returning().get();
    const topicId = db.select().from(topics).limit(1).get()?.id ?? 0;
    db.insert(variants)
      .values([
        { topicId, mediaId: mediaRow.id, resolution: '1080p', sourceTagRaw: 'WEB-DL', sourceTag: 'WEB-DL', sizeBytes: 1, infohash: '4'.repeat(40), decision: 'hindi_dubbed', isPreferred: true },
        { topicId, mediaId: mediaRow.id, resolution: '1080p', sourceTagRaw: 'WEB-DL', sourceTag: 'WEB-DL', sizeBytes: 2, infohash: '5'.repeat(40), decision: 'hindi_dubbed', isPreferred: true },
      ])
      .run();

    const body = (await app().inject({ url: url('/api/v1/stats') })).json() as { preferred: number };

    // Two preferred rows, one title+resolution pair: "best per resolution" must grow by 1, not 2.
    expect(body.preferred).toBe(before + 1);
  });
});

describe('stats: unresolved backlog', () => {
  it('reports the four actionable states', async () => {
    const forumId = db.select().from(forums).get()?.id ?? 0;
    db.insert(topics)
      .values([
        { sourceId: 1, forumId, sourceTopicId: 501, slug: 'a', rawTitle: 'A', kind: 'movie', status: 'external' },
        { sourceId: 1, forumId, sourceTopicId: 502, slug: 'b', rawTitle: 'B', kind: 'movie', status: 'no_link' },
        { sourceId: 1, forumId, sourceTopicId: 503, slug: 'c', rawTitle: 'C', kind: 'movie', status: 'parse_failed' },
        { sourceId: 1, forumId, sourceTopicId: 504, slug: 'd', rawTitle: 'D', kind: 'movie', status: 'gone' },
        { sourceId: 1, forumId, sourceTopicId: 505, slug: 'e', rawTitle: 'E', kind: 'movie', status: 'parsed' },
      ])
      .run();

    const body = (await app().inject({ url: url('/api/v1/stats') })).json() as {
      unresolved: Record<string, number>;
    };

    // `parsed` is not backlog: it has a servable variant.
    expect(body.unresolved).toMatchObject({ external: 1, no_link: 1, parse_failed: 1, gone: 1 });
  });
});
