import { describe, expect, it } from 'vitest';
import { CircuitOpenError, PoliteHttpClient, type FetchLike, type HttpEvent } from '../src/http-client.js';

interface Stub {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function harness(responses: Stub[], overrides: Partial<ConstructorParameters<typeof PoliteHttpClient>[0]> = {}) {
  let index = 0;
  const calls: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;

  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const stub = responses[Math.min(index, responses.length - 1)] as Stub;
    index++;
    const init: ResponseInit = stub.headers ? { status: stub.status, headers: stub.headers } : { status: stub.status };
    return new Response(stub.body ?? 'ok', init);
  };

  const client = new PoliteHttpClient({
    mirrors: ['https://a.test', 'https://b.test'],
    delayMs: 2000,
    fetchImpl,
    // Sleeps advance the fake clock, which is what makes throttling testable without waiting.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  });

  return { client, calls, sleeps, advance: (ms: number) => (clock += ms) };
}

describe('throttling', () => {
  it('waits delayMs between requests', async () => {
    const { client, sleeps } = harness([{ status: 200 }]);
    await client.get('https://a.test/x');
    await client.get('https://a.test/y');
    expect(sleeps).toContain(2000);
  });
});

describe('retries', () => {
  it('retries a 500 and eventually succeeds', async () => {
    const { client, calls } = harness([{ status: 500 }, { status: 200 }]);
    const result = await client.get('https://a.test/x');
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('honours Retry-After over its own backoff', async () => {
    const { client, sleeps } = harness([{ status: 429, headers: { 'retry-after': '7' } }, { status: 200 }]);
    await client.get('https://a.test/x');
    expect(sleeps).toContain(7000);
  });

  it('gives up after maxAttempts', async () => {
    const { client, calls } = harness([{ status: 500 }], { maxAttempts: 2 });
    await expect(client.get('https://a.test/x')).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(2);
  });
});

describe('circuit breaker', () => {
  it('opens after three consecutive 403/429 and refuses further work', async () => {
    const { client } = harness([{ status: 403 }], { breakerThreshold: 3 });
    for (let i = 0; i < 3; i++) await client.get('https://a.test/x').catch(() => undefined);
    expect(client.circuitOpen).toBe(true);
    await expect(client.get('https://a.test/y')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('does not open on scattered failures separated by success', async () => {
    const { client } = harness([{ status: 403 }, { status: 200 }, { status: 403 }, { status: 200 }], {
      breakerThreshold: 2,
    });
    await client.get('https://a.test/1').catch(() => undefined);
    await client.get('https://a.test/2');
    expect(client.circuitOpen).toBe(false);
  });
});

describe('mirror rotation', () => {
  it('rotates to the next mirror on retry', async () => {
    const { client, calls } = harness([{ status: 500 }, { status: 200 }]);
    await client.get('https://a.test/x');
    expect(calls[1]?.startsWith('https://b.test')).toBe(true);
  });

  it('rewrites a known host onto the active mirror only', () => {
    const { client } = harness([{ status: 200 }]);
    expect(client.canonicalise('https://www.1tamilmv.io/index.php?/forums/topic/1-x/', ['www.1tamilmv.io'])).toBe(
      'https://a.test/index.php?/forums/topic/1-x/',
    );
    expect(client.canonicalise('https://example.com/a', ['www.1tamilmv.io'])).toBe('https://example.com/a');
  });
});

describe('telemetry', () => {
  it('reports a successful request with status and latency', async () => {
    const events: HttpEvent[] = [];
    const { client } = harness([{ status: 200 }], { onEvent: (event) => events.push(event) });
    await client.get('https://a.test/x');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'request', status: 200 });
    expect(typeof events[0]!.ms).toBe('number');
  });

  it('reports a retry with its status', async () => {
    const events: HttpEvent[] = [];
    const { client } = harness([{ status: 500 }, { status: 200 }], { onEvent: (event) => events.push(event) });
    await client.get('https://a.test/x');
    expect(events.some((event) => event.event === 'retry' && event.status === 500)).toBe(true);
  });

  it('reports a circuit open and still throws', async () => {
    const events: HttpEvent[] = [];
    const { client } = harness([{ status: 403 }, { status: 403 }], {
      breakerThreshold: 2,
      onEvent: (event) => events.push(event),
    });
    await expect(client.get('https://a.test/x')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(events.some((event) => event.event === 'circuit_open')).toBe(true);
  });

  it('never lets a throwing onEvent break the request', async () => {
    const { client } = harness([{ status: 200 }], {
      onEvent: () => {
        throw new Error('telemetry exploded');
      },
    });
    await expect(client.get('https://a.test/x')).resolves.toMatchObject({ status: 200 });
  });
});

describe('redirect reporting', () => {
  it('returns the final URL, so a page past a board end can be detected', async () => {
    const final = 'https://a.test/index.php?/forums/forum/27-hdtv-sdtv-hdtv-rips/';
    const fetchImpl = (async () => ({
      status: 200,
      url: final,
      headers: new Headers(),
      text: async () => 'body',
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as FetchLike;
    const client = new PoliteHttpClient({ mirrors: ['https://a.test'], delayMs: 0, fetchImpl, sleep: async () => undefined, now: () => 0 });

    const result = await client.get('https://a.test/index.php?/forums/forum/27-hdtv-sdtv-hdtv-rips/page/2132/');

    // `fetch` follows the 303 the site sends; the caller must see where it *landed*.
    expect(result.url).toBe(final);
    expect(result.url).not.toContain('/page/2132/');
  });
});
