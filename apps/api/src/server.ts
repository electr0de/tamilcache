import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { logEvent, type Db } from '@tamilcache/db';
import type { OmdbClient, TmdbClient, TvdbClient } from '@tamilcache/worker';
import { requestOrigin } from './origin.js';
import { registerRestRoutes } from './routes/rest.js';
import { torznabRoutes } from './routes/torznab.js';

export interface BuildOptions {
  db: Db;
  apiKey: string;
  bestVariantOnly?: boolean;
  selfOrigin?: string | undefined;
  webDist?: string;
  logger?: boolean;
  dataDir?: string;
  /** Replaces the env-configured TMDB client. Only tests pass this; production leaves it unset. */
  tmdb?: TmdbClient | null;
  /** Same seam for the manual-only providers. */
  omdb?: OmdbClient | null;
  tvdb?: TvdbClient | null;
}

type BootstrapMode = 'validated' | 'never';

function resolveBootstrapMode(): BootstrapMode {
  const raw = (process.env['ALLOW_BOOTSTRAP'] ?? '').toLowerCase();
  return raw === 'false' || raw === 'never' ? 'never' : 'validated';
}

function isCrossSite(request: { headers: Record<string, unknown> }): boolean {
  const site = request.headers['sec-fetch-site'];
  return typeof site === 'string' && site.toLowerCase() === 'cross-site';
}

function originMatchesHost(request: { headers: Record<string, unknown> }): boolean {
  const origin = request.headers['origin'];
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers['host'] ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export function buildApp(options: BuildOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024 } });

  // Fastify's default handler echoes `error.message`, which for a driver throw is a raw SQLite
  // message. 5xx bodies get a generic message; the detail goes to the log.
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(status).send({ error: 'internal error' });
    }
    return reply.code(status).send({ error: error.message });
  });

  /**
   * Bootstrap lets the SPA pick up the generated key, with no copying by the user.
   *
   * A loopback-peer test cannot work here: through a published container port the peer is the
   * bridge address, so the browser of the person sitting at the machine looks remote. What is
   * checked instead is what a *browser* cannot forge — `Sec-Fetch-Site`, `Origin`, and a `Host`
   * rule. Everything a script sends is by definition forgeable, and that residual risk is
   * accepted and documented: this app is LAN-only and the catalogue is public metadata.
   */
  const bootstrapMode = resolveBootstrapMode();
  const trustedHosts = new Set(
    (process.env['TRUSTED_HOSTS'] ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );

  /** `192.168.0.204:8484` → `192.168.0.204`; `[fe80::1]:8484` → `fe80::1`. */
  function hostnameOf(host: string | undefined): string | null {
    if (!host) return null;
    const stripped = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return stripped.length > 0 ? stripped : null;
  }

  /**
   * DNS rebinding needs an attacker-controlled *domain*, and every such name contains a dot.
   * IP literals (the documented access pattern: LAN IP + published port), dotless names and
   * `.local` are therefore allowed by default; a dotted name must be listed in TRUSTED_HOSTS.
   */
  function isAllowedHost(hostname: string | null): boolean {
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname === '::1') return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
    if (hostname.includes(':') && /^[0-9a-f:]+$/.test(hostname)) return true;
    if (!hostname.includes('.')) return true;
    if (hostname.endsWith('.local')) return true;
    return trustedHosts.has(hostname);
  }

  /**
   * A refusal returned to the caller and dropped is a refusal nobody can explain later. Each
   * branch records which condition fired; the key itself is never written.
   */
  const refuseBootstrap = (
    request: { headers: Record<string, unknown>; url: string },
    condition: 'disabled' | 'cross-site' | 'origin' | 'host',
    message: string,
  ) => {
    logEvent(options.db, {
      source: 'api',
      level: 'warn',
      class: 'audit',
      scope: 'auth',
      event: 'reject',
      message,
      detail: {
        condition,
        host: request.headers['host'] ?? null,
        origin: request.headers['origin'] ?? null,
        secFetchSite: request.headers['sec-fetch-site'] ?? null,
        mode: bootstrapMode,
      },
    });
  };

  app.get('/api/v1/bootstrap', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (bootstrapMode === 'never') {
      refuseBootstrap(request, 'disabled', 'bootstrap refused: disabled by ALLOW_BOOTSTRAP=false');
      return reply.code(403).send({ error: 'bootstrap disabled (ALLOW_BOOTSTRAP=false)' });
    }
    if (isCrossSite(request)) {
      refuseBootstrap(request, 'cross-site', 'bootstrap refused: cross-site request');
      return reply.code(403).send({ error: 'cross-site request refused' });
    }
    if (!originMatchesHost(request)) {
      refuseBootstrap(request, 'origin', 'bootstrap refused: origin does not match host');
      return reply.code(403).send({ error: 'origin does not match host' });
    }
    if (!isAllowedHost(hostnameOf(request.headers['host'] as string | undefined))) {
      refuseBootstrap(request, 'host', 'bootstrap refused: host not allowed');
      return reply.code(403).send({
        error: 'bootstrap refused for this Host',
        hint: 'use an IP address or a `.local` name, or add this host to TRUSTED_HOSTS',
      });
    }
    logEvent(options.db, {
      source: 'api',
      level: 'info',
      class: 'audit',
      scope: 'auth',
      event: 'bootstrap_key_released',
      message: 'API key released to the SPA',
      detail: { host: request.headers['host'] ?? null, mode: bootstrapMode },
    });
    return { apiKey: options.apiKey, torznabUrl: `${requestOrigin(request, options.selfOrigin)}/api/v1` };
  });

  // Every other /api route is key-guarded: a stray scanner on the LAN must not be able to
  // trigger crawls, read the review queue, or read the key itself.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/v1/bootstrap')) return;
    const query = request.query as Record<string, string | undefined>;
    const key = query['apikey'] ?? (request.headers['x-api-key'] as string | undefined);
    if (key !== options.apiKey) {
      logEvent(options.db, {
        source: 'api',
        level: 'warn',
        class: 'audit',
        scope: 'auth',
        event: 'reject',
        message: 'refused: bad or missing API key',
        detail: {
          condition: key === undefined ? 'missing key' : 'bad key',
          method: request.method,
          route: request.url.split('?')[0] ?? null,
          ip: request.ip,
        },
      });
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  /**
   * One hook covers every route, including the ones with no logging of their own. `/logs` is
   * skipped: a page that polls the log table must not write to it on every poll.
   */
  app.addHook('onResponse', async (request, reply) => {
    // Only API calls count as pipeline events. Static assets and the SPA shell are noise: one
    // page load would otherwise write a row per file the moment debug is enabled.
    if (!request.url.startsWith('/api/')) return;
    const route = request.routeOptions.url ?? request.url;
    if (route.startsWith('/api/v1/logs')) return;
    const status = reply.statusCode;
    const ms = Math.round(reply.elapsedTime);
    logEvent(options.db, {
      source: 'api',
      level: 'debug',
      class: 'diag',
      scope: 'api',
      event: 'request',
      message: `${request.method} ${route} → ${status} in ${ms}ms`,
      detail: { method: request.method, route, status, ms },
    });
    if (status >= 500) {
      logEvent(options.db, {
        source: 'api',
        level: 'error',
        class: 'diag',
        scope: 'api',
        event: 'error',
        message: `${request.method} ${route} → ${status}`,
        detail: { method: request.method, route, status, ms },
      });
    }
  });

  const dataDir = options.dataDir ?? resolve(process.cwd(), 'data');
  // Origin is resolved per request: a client that reached us on 192.168.x.x:8484 must get grab
  // links on that origin, not on a hardcoded localhost.
  const originFor = (request: { headers: Record<string, unknown>; protocol?: string }): string =>
    requestOrigin(request, options.selfOrigin);

  torznabRoutes(app, options.db, {
    bestVariantOnly: options.bestVariantOnly ?? false,
    originFor,
    apiKey: options.apiKey,
  });
  registerRestRoutes(app, options.db, originFor, dataDir, options.tmdb, options.omdb, options.tvdb);

  if (existsSync(dataDir)) {
    app.register(fastifyStatic, { root: dataDir, prefix: '/torrents/', decorateReply: false });
  }

  const webDist = options.webDist ?? resolve(process.cwd(), 'apps/web/dist');
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
