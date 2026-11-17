import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logEvent, type Db } from '@tamilcache/db';
import { variants } from '@tamilcache/db/schema';
import { audioCodecToken, imdbIdDigits, renderCapsXml, renderSearchXml, type TorznabItem } from '@tamilcache/shared';
import { parseCategories } from '../categories.js';
import { search } from '../queries.js';

/**
 * 1TamilMV publishes no swarm data and the magnets we store carry only `xt`/`dn`/`xl`/`tr`, so
 * seeders cannot be measured. A client with a minimum-seeders rule treats 0 as "dead" and rejects
 * the release, which makes this whole indexer unusable; this sentinel means "not measured" and is
 * the smallest value that keeps the feed grabbable. See docs/DECISIONS.md.
 */
const SEEDERS_UNKNOWN = 1;

export interface TorznabOptions {
  bestVariantOnly: boolean;
  /** Per-request origin resolver: the feed must link back to the host the client used. */
  originFor: (request: { headers: Record<string, unknown>; protocol?: string }) => string;
  apiKey: string;
}

function int(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function torznabRoutes(app: FastifyInstance, db: Db, options: TorznabOptions): void {
  const capsHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    // The *arrs poll caps and search constantly, so both stay at debug: present when you ask,
    // silent on a normal day.
    logEvent(db, {
      source: 'api',
      level: 'debug',
      class: 'diag',
      scope: 'torznab',
      event: 'caps',
      message: 'caps requested',
    });
    reply.type('application/xml');
    return renderCapsXml();
  };

  const searchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(int(query['limit']) ?? 50, 0), 100);
    const offset = Math.max(int(query['offset']) ?? 0, 0);

    const rows = search(db, {
      q: query['q'],
      imdbid: query['imdbid'],
      tmdbid: int(query['tmdbid']),
      // Accepted but ignored: we do not advertise tvdbid, and filtering on an id we usually
      // cannot resolve would return zero results for a perfectly good series.
      tvdbid: undefined,
      // Advertised in caps: Radarr sends the year on every movie search.
      year: int(query['year']),
      season: int(query['season']),
      ep: int(query['ep']),
      categories: parseCategories(query['cat'] as string | string[] | undefined),
      limit,
      offset,
      // `BEST_VARIANT_ONLY` collapses every title to its top-ranked variant.
      bestVariantOnly: options.bestVariantOnly || query['bestonly'] === '1',
      // The *arrs get one entry per resolution by default (largest 1080p, smallest 4K).
      includeAlternatives: query['alternatives'] === '1',
    });

    const items: TorznabItem[] = rows.map((row) => ({
      title: row.normTitle ?? row.rawTitle,
      guid: `tamilcache-${row.id}`,
      // A pinned TORZNAB_API_KEY may contain reserved characters; the enclosure is now the
      // only URL a client downloads from, so it must survive a round trip.
      link: `${options.originFor(request)}/api/v1/download/${row.id}?apikey=${encodeURIComponent(options.apiKey)}`,
      magnetUrl: row.magnet,
      infohash: row.infohash,
      sizeBytes: row.sizeBytes,
      pubDate: row.publishedAt ?? new Date().toISOString(),
      categoryId: row.categoryId ?? 2040,
      seeders: SEEDERS_UNKNOWN,
      peers: 0,
      attrs: {
        resolution: row.resolution,
        video: row.codec,
        audio: row.audioCodecs ? audioCodecToken(row.audioCodecs) : null,
        codec: row.codec,
        // Every emitted variant passed the Hindi filter, so this is not a guess.
        language: 'Hindi',
        // `subs` is only claimed when the release name actually says so; the site tags ESub
        // inconsistently and inventing it would make clients prefer releases without subs.
        subs: /esub|sub/i.test(row.normTitle ?? '') ? 'English' : null,
        year: row.year,
        imdb: imdbIdDigits(row.imdbId),
        // A manual (OMDb/TVDB) row carries a negative sentinel in `media.tmdb_id`; it must never
        // reach a client, which would then try to fetch a TMDB title that does not exist.
        tmdbid: row.tmdbId !== null && row.tmdbId > 0 ? row.tmdbId : null,
        tvdbid: row.tvdbId,
        season: row.season,
        episode: row.epFrom,
      },
    }));

    logEvent(db, {
      source: 'api',
      level: 'debug',
      class: 'diag',
      scope: 'torznab',
      event: 'search',
      message: `search returned ${items.length} results`,
      detail: {
        q: query['q'] ?? null,
        season: int(query['season']) ?? null,
        ep: int(query['ep']) ?? null,
        results: items.length,
      },
    });
    reply.type('application/xml');
    return renderSearchXml(items);
  };

  app.get('/api/v1/caps', capsHandler);
  app.get('/api/v1/search', searchHandler);

  /**
   * Radarr and Sonarr build `{BaseUrl}/api?t=…` unconditionally, so a Torznab indexer pointed at
   * `…/api/v1` asks for `…/api/v1/api` and would 404. Generic Torznab clients instead treat the
   * URL as the whole feed (`…/api/v1?t=…`). One dispatcher serves both shapes: `search` already
   * ignores `t` and validates every other parameter, so only the caps branch needs deciding.
   */
  const torznabAlias = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    return query['t'] === 'caps' ? capsHandler(request, reply) : searchHandler(request, reply);
  };

  app.get('/api/v1/api', torznabAlias);
  app.get('/api/v1', torznabAlias);

  app.get('/api/v1/download/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.select().from(variants).where(eq(variants.id, Number(id))).get();
    if (!row) {
      logEvent(db, {
        source: 'api',
        level: 'warn',
        class: 'diag',
        scope: 'torznab',
        event: 'reject',
        message: `download refused: variant ${id} not found`,
        variantId: Number(id),
        detail: { reason: 'not found', route: '/api/v1/download/:id' },
      });
      return reply.code(404).send({ error: 'not found' });
    }
    if (!row.torrentLocalPath && !row.magnet) {
      logEvent(db, {
        source: 'api',
        level: 'warn',
        class: 'diag',
        scope: 'torznab',
        event: 'reject',
        message: `download refused: variant ${id} has no magnet or torrent`,
        variantId: row.id,
        detail: { reason: 'no magnet and no torrent', route: '/api/v1/download/:id' },
      });
      return reply.code(404).send({ error: 'no magnet and no torrent for this variant' });
    }
    // The grab is the moment a client takes a release: an audit record, because "what did Sonarr
    // grab and when" cannot be reconstructed from the catalogue afterwards.
    logEvent(db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'torznab',
      event: 'grab',
      message: `grabbed variant ${row.id} (${row.infohash})`,
      variantId: row.id,
      detail: {
        infohash: row.infohash,
        served: row.torrentLocalPath ? 'torrent' : 'magnet',
        resolution: row.resolution ?? null,
        decision: row.decision,
      },
    });
    if (row.torrentLocalPath) return reply.redirect(`/torrents/${row.id}.torrent`);
    return reply.redirect(row.magnet as string);
  });
}
