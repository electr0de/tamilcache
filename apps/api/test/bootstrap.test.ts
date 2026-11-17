import { afterEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '@tamilcache/db';
import { logEvents } from '@tamilcache/db/schema';
import { buildApp } from '../src/server.js';

const KEY = 'generated-key-0123456789';

function app() {
  const db = createDb(':memory:');
  migrate(db);
  return buildApp({ db, apiKey: KEY, webDist: '/nonexistent', dataDir: '/tmp/none' });
}

afterEach(() => {
  delete process.env['ALLOW_BOOTSTRAP'];
  delete process.env['TRUSTED_HOSTS'];
  delete process.env['SELF_ORIGIN'];
});

interface Case {
  name: string;
  host?: string;
  remote: string;
  headers?: Record<string, string>;
  expect: number;
}

/** The security surface is the point of this table, so every shape gets a row. */
const CASES: Case[] = [
  { name: 'LAN IP + port (the real Docker case)', host: '192.168.0.204:8484', remote: '10.89.1.2', expect: 200 },
  { name: 'localhost', host: 'localhost:8484', remote: '10.89.1.2', expect: 200 },
  { name: 'dotless hostname', host: 'unraid:8484', remote: '10.89.1.2', expect: 200 },
  { name: '.local hostname', host: 'unraid.local:8484', remote: '10.89.1.2', expect: 200 },
  { name: 'IPv6 literal', host: '[fe80::1]:8484', remote: '10.89.1.2', expect: 200 },
  { name: 'same-origin fetch', host: '192.168.0.204:8484', remote: '10.89.1.2', headers: { 'sec-fetch-site': 'same-origin' }, expect: 200 },
  { name: 'top-level navigation', host: '192.168.0.204:8484', remote: '10.89.1.2', headers: { 'sec-fetch-site': 'none' }, expect: 200 },
  { name: 'cross-site browser fetch', host: '192.168.0.204:8484', remote: '10.89.1.2', headers: { 'sec-fetch-site': 'cross-site' }, expect: 403 },
  { name: 'Origin mismatch', host: '192.168.0.204:8484', remote: '10.89.1.2', headers: { origin: 'https://evil.example' }, expect: 403 },
  { name: 'Origin match', host: '192.168.0.204:8484', remote: '10.89.1.2', headers: { origin: 'http://192.168.0.204:8484' }, expect: 200 },
  { name: 'DNS-rebinding domain', host: 'evil.example:8484', remote: '10.89.1.2', expect: 403 },
];

describe('bootstrap header matrix', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} → ${testCase.expect}`, async () => {
      const response = await app().inject({
        url: '/api/v1/bootstrap',
        remoteAddress: testCase.remote,
        headers: { ...(testCase.host ? { host: testCase.host } : {}), ...(testCase.headers ?? {}) },
      });
      expect(response.statusCode).toBe(testCase.expect);
      if (testCase.expect === 200) expect(response.json()).toMatchObject({ apiKey: KEY });
      else expect(response.body).not.toContain(KEY);
    });
  }

  it('is refused outright when ALLOW_BOOTSTRAP=false', async () => {
    process.env['ALLOW_BOOTSTRAP'] = 'false';
    const response = await app().inject({ url: '/api/v1/bootstrap', headers: { host: 'localhost:8484' } });
    expect(response.statusCode).toBe(403);
  });

  it('accepts an explicit TRUSTED_HOSTS entry for a dotted domain', async () => {
    process.env['TRUSTED_HOSTS'] = 'media.example';
    const response = await app().inject({ url: '/api/v1/bootstrap', headers: { host: 'media.example:8484' } });
    expect(response.statusCode).toBe(200);
  });

  it('never lets the key be cached', async () => {
    const response = await app().inject({ url: '/api/v1/bootstrap', headers: { host: '192.168.0.204:8484' } });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('feed origin', () => {
  it('reports the origin the client used, so Radarr can grab', async () => {
    const response = await app().inject({ url: '/api/v1/bootstrap', headers: { host: '192.168.0.204:8484' } });
    expect(response.json()).toMatchObject({ torznabUrl: 'http://192.168.0.204:8484/api/v1' });
  });

  it('lets SELF_ORIGIN pin the origin', async () => {
    process.env['SELF_ORIGIN'] = 'http://pinned.example:9000';
    const response = await app().inject({ url: '/api/v1/bootstrap', headers: { host: '192.168.0.204:8484' } });
    expect(response.json()).toMatchObject({ torznabUrl: 'http://pinned.example:9000/api/v1' });
  });
});

describe('bootstrap telemetry', () => {
  it('records which condition refused the request', async () => {
    const db = createDb(':memory:');
    migrate(db);
    const instance = buildApp({ db, apiKey: KEY, webDist: '/nonexistent', dataDir: '/tmp/none' });
    const response = await instance.inject({
      url: '/api/v1/bootstrap',
      headers: { host: 'evil.example:8484' },
    });
    expect(response.statusCode).toBe(403);
    const reject = db.select().from(logEvents).all().find((row) => row.event === 'reject')!;
    expect(reject.scope).toBe('auth');
    expect(reject.class).toBe('audit');
    expect(reject.detail).toContain('host');
  });

  it('records a released key as an audit row', async () => {
    const db = createDb(':memory:');
    migrate(db);
    const instance = buildApp({ db, apiKey: KEY, webDist: '/nonexistent', dataDir: '/tmp/none' });
    const response = await instance.inject({
      url: '/api/v1/bootstrap',
      headers: { host: '192.168.0.204:8484' },
    });
    expect(response.statusCode).toBe(200);
    const released = db.select().from(logEvents).all().find((row) => row.event === 'bootstrap_key_released')!;
    expect(released.class).toBe('audit');
    expect(released.detail).not.toContain(KEY);
  });
});
