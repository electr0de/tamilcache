import { afterEach, describe, expect, it } from 'vitest';
import { api, ensureApiKey, getApiKey, setApiKey, setFetchImpl } from '../src/api.js';

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('getApiKey', () => {
  it('adopts a key from the url and strips it from the address bar', () => {
    window.history.replaceState({}, '', '/browse?apikey=from-url&type=movie');

    expect(getApiKey()).toBe('from-url');
    expect(window.location.search).toBe('?type=movie');
  });
});

describe('ensureApiKey', () => {
  it('adopts the key the app bootstraps from the server', async () => {
    window.localStorage.clear();
    setFetchImpl(async (url) => {
      expect(url).toBe('/api/v1/bootstrap');
      return new Response(JSON.stringify({ apiKey: 'generated-key' }), { status: 200 });
    });

    expect(await ensureApiKey()).toBe('generated-key');
    expect(getApiKey()).toBe('generated-key');
  });

  it('falls back to nothing when bootstrap is refused (non-loopback client)', async () => {
    window.localStorage.clear();
    setFetchImpl(async () => new Response(JSON.stringify({ error: 'localhost only' }), { status: 403 }));

    expect(await ensureApiKey()).toBe('');
  });

  it('discards a stale key, re-bootstraps and retries the request once', async () => {
    window.localStorage.setItem('tamilcache.apikey', 'stale');
    const calls: string[] = [];
    setFetchImpl(async (url) => {
      calls.push(url);
      if (url === '/api/v1/bootstrap') return new Response(JSON.stringify({ apiKey: 'fresh' }), { status: 200 });
      if (url.includes('apikey=stale')) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      return new Response(JSON.stringify({ total: 0, limit: 48, offset: 0, titles: [] }), { status: 200 });
    });

    // A stale key must heal itself: the user is never asked to supply one.
    const body = await api.library({ limit: 48 });

    expect(body.total).toBe(0);
    expect(calls).toEqual(['/api/v1/library?limit=48&apikey=stale', '/api/v1/bootstrap', '/api/v1/library?limit=48&apikey=fresh']);
    expect(getApiKey()).toBe('fresh');
  });

  it('reports an actionable error when the server refuses even a fresh key', async () => {
    window.localStorage.setItem('tamilcache.apikey', 'stale');
    setFetchImpl(async (url) =>
      url === '/api/v1/bootstrap'
        ? new Response(JSON.stringify({ apiKey: 'fresh' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );

    await expect(api.forums()).rejects.toThrow(/refused the key this page was issued/);
  });

  it('never overwrites a key the user already has', async () => {
    window.localStorage.clear();
    window.localStorage.setItem('tamilcache.apikey', 'existing');
    setFetchImpl(async () => {
      throw new Error('should not be called');
    });

    expect(await ensureApiKey()).toBe('existing');
  });
});

describe('request headers', () => {
  it('does not claim a JSON body when a POST has none', async () => {
    const seen: Array<Record<string, string>> = [];
    setApiKey('k');
    setFetchImpl(async (_url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await api.requestDelta();
    expect(seen[0]?.['content-type']).toBeUndefined();
  });

  it('still sends JSON when there is a body', async () => {
    const seen: Array<Record<string, string>> = [];
    setApiKey('k');
    setFetchImpl(async (_url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ armed: '1' }), { status: 200 });
    });
    await api.setBackfill({ armed: true });
    expect(seen[0]?.['content-type']).toBe('application/json');
  });
});
