import { describe, expect, it } from 'vitest';
import { createDb, migrate } from '@tamilcache/db';
import { resolveApiKey } from '../src/apikey.js';
import { buildApp } from '../src/server.js';

describe('resolveApiKey', () => {
  it('generates a key when none is configured, and persists it', () => {
    const db = createDb(':memory:');
    migrate(db);
    const first = resolveApiKey(db, {});
    expect(first.source).toBe('generated');
    expect(first.key).toMatch(/^[0-9a-f]{48}$/);

    const second = resolveApiKey(db, {});
    expect(second).toEqual({ key: first.key, source: 'stored' });
  });

  it('honours an explicit env override and stores it', () => {
    const db = createDb(':memory:');
    migrate(db);
    const resolved = resolveApiKey(db, { TORZNAB_API_KEY: 'explicit-key' });
    expect(resolved).toEqual({ key: 'explicit-key', source: 'env' });
    expect(resolveApiKey(db, {}).key).toBe('explicit-key');
  });

  it('generates a different key for a different database', () => {
    const a = createDb(':memory:');
    migrate(a);
    const b = createDb(':memory:');
    migrate(b);
    expect(resolveApiKey(a, {}).key).not.toBe(resolveApiKey(b, {}).key);
  });

  it('refuses the documentation value in production', () => {
    const db = createDb(':memory:');
    migrate(db);
    expect(() => resolveApiKey(db, { TORZNAB_API_KEY: 'devkey', NODE_ENV: 'production' })).toThrow(/devkey/);
  });
});

describe('bootstrap endpoint', () => {
  function appWith(key: string) {
    const db = createDb(':memory:');
    migrate(db);
    return buildApp({ db, apiKey: key, dataDir: '/tmp/none', webDist: '/nonexistent' });
  }

  it('hands the key to a loopback client without authentication', async () => {
    const response = await appWith('generated-key').inject({ url: '/api/v1/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ apiKey: 'generated-key' });
  });

  it('hands the key to a LAN client that reached us on a LAN IP (the Docker case)', async () => {
    // This is the request shape a browser on the LAN makes through a published port; the
    // previous loopback-only rule rejected it and left the SPA unable to configure itself.
    const response = await appWith('generated-key').inject({
      url: '/api/v1/bootstrap',
      remoteAddress: '10.89.1.2',
      headers: { host: '192.168.0.204:8484' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ apiKey: 'generated-key' });
  });

  it('still requires the key for every other route', async () => {
    expect((await appWith('k').inject({ url: '/api/v1/stats' })).statusCode).toBe(401);
  });
});
