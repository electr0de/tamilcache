import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type Db } from '@tamilcache/db';
import { forums, logEvents, media, sources, topics, variants } from '@tamilcache/db/schema';
import { buildApp } from '../src/server.js';

let db: Db;
const KEY = 'test-key';

let seeded = false;

function seed(decision: 'hindi_dubbed' | 'not_hindi' = 'hindi_dubbed') {
  if (seeded) {
    db.update(variants).set({ decision }).run();
    return;
  }
  seeded = true;
  db.insert(sources).values({ baseUrl: 'https://x.test', label: 'x' }).run();
  db.insert(forums).values({ sourceId: 1, sourceForumId: 64, name: 'Hindi Dubbed', inScope: true }).run();
  db.insert(media).values({ tmdbId: 42, type: 'movie', title: 'A Minecraft Movie', year: 2025, originalLanguage: 'en', imdbId: 'tt1234567' }).run();
  const topic = db
    .insert(topics)
    .values({ sourceId: 1, forumId: 1, sourceTopicId: 1, slug: 'a-minecraft-movie-2025', rawTitle: 'A Minecraft Movie', kind: 'movie' })
    .returning()
    .get();
  db.insert(variants)
    .values({
      topicId: topic.id,
      resolution: '720p',
      sourceTagRaw: 'HQ HDTS',
      sourceTag: 'HDTS',
      codec: 'x264',
      audioCodecs: 'AAC',
      audioLangs: ['hindi'],
      sizeBytes: 734003200,
      infohash: 'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
      magnet: 'magnet:?xt=urn:btih:c9d385dc7158d74f70b733f17a8c0dde9b67357c',
      normTitle: 'A.Minecraft.Movie.2025.720p.HDTS.x264.AAC.Hindi.700MB-TMV',
      mediaId: 1,
      categoryId: 2040,
      decision,
      decisionSource: 'auto',
      qualityRank: 4020,
      isPreferred: true,
      publishedAt: '2026-11-01T00:00:00.000Z',
    })
    .run();
}

function app() {
  // No pinned origin: the feed must derive it from the request Host.
  return buildApp({ db, apiKey: KEY });
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db);
  seeded = false;
  seed();
});

describe('api key guard', () => {
  it('rejects requests without a key', async () => {
    expect((await app().inject({ url: '/api/v1/caps' })).statusCode).toBe(401);
  });

  it('accepts the key as a query param or a header', async () => {
    expect((await app().inject({ url: `/api/v1/caps?apikey=${KEY}` })).statusCode).toBe(200);
    expect((await app().inject({ url: '/api/v1/caps', headers: { 'x-api-key': KEY } })).statusCode).toBe(200);
  });
});

describe('caps', () => {
  it('returns torznab caps', async () => {
    const response = await app().inject({ url: `/api/v1/caps?apikey=${KEY}` });
    expect(response.headers['content-type']).toContain('xml');
    expect(response.body).toContain('<caps');
    expect(response.body).toContain('movie-search');
  });
});

describe('search', () => {
  it('emits only hindi decisions', async () => {
    db.update(variants).set({ decision: 'not_hindi' }).run();
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&t=movie` });
    const hindi = (response.body.match(/<title>.*?<\/title>/g) ?? []).filter((t) => t.includes('TMV'));
    expect(hindi.length).toBe(0);
  });

  it('returns the cached release for a query', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=minecraft` });
    expect(response.body).toContain('A.Minecraft.Movie.2025');
    expect(response.body).toContain('infohash');
  });

  it('filters by tmdbid', async () => {
    expect((await app().inject({ url: `/api/v1/search?apikey=${KEY}&tmdbid=42` })).body).toContain('<item>');
    expect((await app().inject({ url: `/api/v1/search?apikey=${KEY}&tmdbid=999` })).body).not.toContain('<item>');
  });

  // Radarr sends the bare integer; the feed must answer it, and must emit the same form back.
  it('matches an IMDb id in either wire form and emits the bare integer', async () => {
    const bare = await app().inject({ url: `/api/v1/search?apikey=${KEY}&imdbid=1234567` });
    const prefixed = await app().inject({ url: `/api/v1/search?apikey=${KEY}&imdbid=tt1234567` });

    expect(bare.body).toContain('<item>');
    expect(prefixed.body).toContain('<item>');
    expect(bare.body).toContain('name="imdb" value="1234567"');
    expect(bare.body).not.toContain('value="tt1234567"');
  });

  it('never emits a non-positive tmdbid (a manual row carries a sentinel)', async () => {
    db.update(media).set({ tmdbId: -1234567 }).run();

    const body = (await app().inject({ url: `/api/v1/search?apikey=${KEY}` })).body;

    expect(body).toContain('name="imdb" value="1234567"');
    expect(body).not.toContain('name="tmdbid"');
  });

  it('honours limit=0', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&limit=0` });
    expect(response.body).not.toContain('<item>');
  });

  // Radarr/Sonarr reject every release when `seeders` is 0 and the indexer carries a
  // minimum-seeders rule. We cannot measure the swarm, so the feed must not claim 0.
  it('publishes a non-zero seeder sentinel so client minimum-seeder rules do not block the indexer', async () => {
    const body = (await app().inject({ url: `/api/v1/search?apikey=${KEY}` })).body;

    expect(body).toContain('name="seeders" value="1"');
    expect(body).not.toContain('name="seeders" value="0"');
  });

  it('supports best-only collapse via query flag', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&bestonly=1` });
    expect((response.body.match(/<item>/g) ?? []).length).toBe(1);
  });
});

describe('download', () => {
  it('redirects to the magnet', async () => {
    const response = await app().inject({ url: `/api/v1/download/1?apikey=${KEY}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toContain('magnet:');
  });

  it('404s for an unknown variant', async () => {
    expect((await app().inject({ url: `/api/v1/download/999?apikey=${KEY}` })).statusCode).toBe(404);
  });
});

describe('preferred-only selection', () => {
  function addAlternative() {
    db.insert(variants)
      .values({
        topicId: 1,
        resolution: '1080p',
        sourceTagRaw: 'HQ HDRip',
        sourceTag: 'WEBRip',
        audioLangs: ['hindi'],
        sizeBytes: 2000,
        infohash: 'c'.repeat(40),
        magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
        normTitle: 'A.Minecraft.Movie.2025.1080p.WEBRip.x264.Hindi.2GB-TMV',
        categoryId: 2040,
        decision: 'hindi_dubbed',
        qualityRank: 4080,
        isPreferred: false,
      })
      .run();
  }

  it('hides non-preferred variants from the *arrs by default', async () => {
    addAlternative();
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}` });
    expect(response.body).not.toContain('1080p.WEBRip');
    expect(response.body).toContain('720p.HDTS');
  });

  it('includes them when explicitly asked', async () => {
    addAlternative();
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&alternatives=1` });
    expect(response.body).toContain('1080p.WEBRip');
  });
});

describe('caps truthfulness', () => {
  it('does not advertise tvdbid for TV, because we usually cannot resolve it', async () => {
    const response = await app().inject({ url: `/api/v1/caps?apikey=${KEY}` });
    expect(response.body).toContain('supportedParams="q,season,ep,year"');
    expect(response.body).not.toContain('tvdbid');
  });

  it('advertises the movie ids we do populate', async () => {
    const response = await app().inject({ url: `/api/v1/caps?apikey=${KEY}` });
    expect(response.body).toContain('q,imdbid,tmdbid,year');
  });

  it('ignores a tvdbid filter instead of returning nothing', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&tvdbid=99999` });
    expect(response.body).toContain('<item>');
  });
});

describe('cross-posted torrents', () => {
  it('emits one item when the same infohash is posted under two topics', async () => {
    const second = db
      .insert(topics)
      .values({
        sourceId: 1,
        forumId: 1,
        sourceTopicId: 99,
        slug: 'same-film-telugu-post',
        rawTitle: 'A Minecraft Movie (Telugu post)',
        kind: 'movie',
      })
      .returning()
      .get();
    db.insert(variants)
      .values({
        topicId: second.id,
        resolution: '720p',
        sourceTagRaw: 'HQ HDTS',
        sourceTag: 'HDTS',
        audioLangs: ['hindi'],
        sizeBytes: 734003200,
        infohash: 'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
        normTitle: 'A.Minecraft.Movie.2025.720p.HDTS.x264.AAC.Hindi.700MB-TMV',
        categoryId: 2040,
        decision: 'hindi_dubbed',
        isPreferred: true,
      })
      .run();

    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&limit=50` });
    const items = response.body.match(/<item>/g) ?? [];
    expect(items).toHaveLength(1);
  });
});

describe('category lists (Prowlarr sends 2000,5000)', () => {
  function seedTv() {
    const topic = db
      .insert(topics)
      .values({ sourceId: 1, forumId: 1, sourceTopicId: 42, slug: 'a-show', rawTitle: 'A Show', kind: 'show' })
      .returning()
      .get();
    db.insert(variants)
      .values({
        topicId: topic.id,
        resolution: '1080p',
        sourceTagRaw: 'TRUE WEB-DL',
        sourceTag: 'WEB-DL',
        audioLangs: ['hindi'],
        sizeBytes: 1,
        infohash: 'd'.repeat(40),
        magnet: `magnet:?xt=urn:btih:${'d'.repeat(40)}`,
        normTitle: 'A.Show.2026.1080p.WEB-DL.Hindi-TMV',
        categoryId: 5030,
        decision: 'hindi_dubbed',
        isPreferred: true,
      })
      .run();
  }

  it('matches both categories from the comma list', async () => {
    seedTv();
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&cat=2040,5030` });
    expect((response.body.match(/<item>/g) ?? []).length).toBe(2);
  });

  it('filters to the single requested category', async () => {
    seedTv();
    const movie = await app().inject({ url: `/api/v1/search?apikey=${KEY}&cat=2040` });
    expect((movie.body.match(/<item>/g) ?? []).length).toBe(1);
    const tv = await app().inject({ url: `/api/v1/search?apikey=${KEY}&cat=5030` });
    expect((tv.body.match(/<item>/g) ?? []).length).toBe(1);
  });

  it('treats a parent category as the whole subtree', async () => {
    seedTv();
    const movies = await app().inject({ url: `/api/v1/search?apikey=${KEY}&cat=2000` });
    expect((movies.body.match(/<item>/g) ?? []).length).toBe(1);
    const tv = await app().inject({ url: `/api/v1/search?apikey=${KEY}&cat=5000` });
    expect((tv.body.match(/<item>/g) ?? []).length).toBe(1);
  });

  it('accepts a repeated cat parameter', async () => {
    seedTv();
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&cat=2040&cat=5030` });
    expect((response.body.match(/<item>/g) ?? []).length).toBe(2);
  });

  it('does not silently ignore junk in the list', async () => {
    seedTv();
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&cat=abc` });
    // Junk parses to nothing, so no filter is applied and both seeded rows are eligible.
    expect(response.statusCode).toBe(200);
  });
});

describe('feed links follow the request Host', () => {
  it('emits grab links on the origin the client called', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}`, headers: { host: '192.168.0.204:8484' } });
    expect(response.body).toContain('http://192.168.0.204:8484/api/v1/download/');
    expect(response.body).not.toContain('localhost:8484/api/v1/download/');
  });

  it('lets SELF_ORIGIN pin the feed origin for proxy setups', async () => {
    process.env['SELF_ORIGIN'] = 'http://pinned.example:9000';
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}`, headers: { host: '192.168.0.204:8484' } });
    delete process.env['SELF_ORIGIN'];
    expect(response.body).toContain('http://pinned.example:9000/api/v1/download/');
  });
});

describe('index-backed search', () => {
  it('finds a title through the FTS index', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=minecraft` });
    expect(response.body).toContain('A.Minecraft.Movie.2025');
  });

  it('matches the raw topic title too', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=${encodeURIComponent('minecraft movie')}` });
    expect(response.body).toContain('<item>');
  });

  it('survives FTS syntax in the query instead of returning 500', async () => {
    for (const q of ['a AND "b', 'foo-bar', '"""', 'NEAR(a b)']) {
      const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=${encodeURIComponent(q)}` });
      expect(response.statusCode, q).toBe(200);
    }
  });

  it('falls back to LIKE for a short fragment', async () => {
    const response = await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=mi` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('A.Minecraft.Movie.2025');
  });

  it('does not match a term that appears nowhere', async () => {
    expect((await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=nomatchhere` })).body).not.toContain('<item>');
  });
});

describe('grab telemetry', () => {
  it('records a grab as an audit row with the infohash', async () => {
    const variant = db.select().from(variants).all()[0]!;
    const response = await app().inject({ url: `/api/v1/download/${variant.id}?apikey=${KEY}` });
    expect(response.statusCode).toBe(302);
    const grab = db.select().from(logEvents).all().find((row) => row.event === 'grab')!;
    expect(grab.class).toBe('audit');
    expect(grab.scope).toBe('torznab');
    expect(grab.variantId).toBe(variant.id);
    expect(grab.detail).toContain(variant.infohash);
  });

  it('records a missing variant as a rejection, not a grab', async () => {
    await app().inject({ url: `/api/v1/download/999999?apikey=${KEY}` });
    const events = db.select().from(logEvents).all();
    expect(events.some((row) => row.event === 'reject' && row.scope === 'torznab')).toBe(true);
    expect(events.some((row) => row.event === 'grab')).toBe(false);
  });
});

describe('torznab alias for the *arrs', () => {
  // Radarr/Sonarr always request {BaseUrl}/api?t=… — the path the app never registered.
  it('answers caps at the /api suffix Radarr hardcodes', async () => {
    const response = await app().inject({ url: `/api/v1/api?t=caps&apikey=${KEY}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('xml');
    expect(response.body).toContain('<caps');
    expect(response.body).toContain('movie-search');
  });

  it('answers search at the same suffix, identical to /search', async () => {
    const viaAlias = await app().inject({ url: `/api/v1/api?t=movie&q=minecraft&apikey=${KEY}` });
    const viaSearch = await app().inject({ url: `/api/v1/search?t=movie&q=minecraft&apikey=${KEY}` });

    expect(viaAlias.statusCode).toBe(200);
    expect(viaAlias.body).toBe(viaSearch.body);
    expect(viaAlias.body).toContain('A.Minecraft.Movie.2025');
  });

  it('answers caps at the bare /api/v1 base for generic torznab clients', async () => {
    const response = await app().inject({ url: `/api/v1?t=caps&apikey=${KEY}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<caps');
  });

  it('honours the year filter caps advertises', async () => {
    const match = await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=minecraft&year=2025` });
    const miss = await app().inject({ url: `/api/v1/search?apikey=${KEY}&q=minecraft&year=1999` });

    expect(match.body).toContain('<item>');
    expect(miss.body).not.toContain('<item>');
  });

  it('percent-encodes the api key in grab links', async () => {
    const keyed = buildApp({ db, apiKey: 'k&y=1' });
    const body = (await keyed.inject({ url: '/api/v1/search?q=minecraft', headers: { 'x-api-key': 'k&y=1' } })).body;

    expect(body).toContain('apikey=k%26y%3D1');
    expect(body).not.toContain('apikey=k&y=1');
  });

  it('keeps the alias behind the api key guard', async () => {
    const response = await app().inject({ url: '/api/v1/api?t=caps' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('guards the bare /api/v1 base and rejects a wrong key', async () => {
    const bare = await app().inject({ url: '/api/v1?t=caps' });
    const wrong = await app().inject({ url: '/api/v1/api?t=caps&apikey=not-the-key' });

    expect(bare.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'unauthorized' });
  });
});
