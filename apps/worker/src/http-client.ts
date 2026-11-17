export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PoliteHttpClientOptions {
  mirrors: string[];
  delayMs: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  userAgent?: string;
  /**
   * Telemetry hook. The client stays DB-free: the worker wires this to `logEvent`. A throwing
   * callback is swallowed, because observability must never break the request it observes.
   */
  onEvent?: (event: HttpEvent) => void;
}

export interface HttpEvent {
  event: 'request' | 'retry' | 'circuit_open';
  url: string;
  status?: number;
  ms: number;
  mirror?: string;
  attempt?: number;
  backoffMs?: number;
}

export interface HttpResult {
  status: number;
  body: string;
  url: string;
}

/** Binary result for `.torrent` attachments, whose bytes must not be decoded as text. */
export interface HttpBufferResult {
  status: number;
  body: Buffer;
  url: string;
}

export class CircuitOpenError extends Error {
  constructor(public readonly untilMs: number) {
    super('circuit open: repeated 403/429 responses, crawling paused');
  }
}

const USER_AGENT = 'TamilCache/0.1 (personal, single-user indexer; contact: localhost)';

/**
 * The single choke point for every outbound request.
 *
 * Slow is a feature here: the whole design accepts a days-long backfill in exchange for never
 * being throttled. So the delay, the retry policy, the breaker and the mirror rotation all live
 * in one place instead of being sprinkled as `sleep()` calls at call sites.
 */
export class PoliteHttpClient {
  private lastRequestAt = -Infinity;
  private throttleGate: Promise<void> = Promise.resolve();
  private consecutiveBlocks = 0;
  private mirrorIndex = 0;
  private openUntil = 0;

  private readonly mirrors: string[];
  private readonly delayMs: number;
  private readonly maxAttempts: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly onEvent: ((event: HttpEvent) => void) | undefined;   

  constructor(options: PoliteHttpClientOptions) {
    if (options.mirrors.length === 0) throw new Error('PoliteHttpClient: at least one mirror is required');
    this.mirrors = options.mirrors;
    this.delayMs = options.delayMs;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.breakerThreshold = options.breakerThreshold ?? 3;
    this.breakerCooldownMs = options.breakerCooldownMs ?? 30 * 60 * 1000;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.onEvent = options.onEvent;
  }

  private emit(event: HttpEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Deliberately silent: a broken telemetry sink must not fail a crawl.
    }
  }

  get circuitOpen(): boolean {
    return this.now() < this.openUntil;
  }

  get circuitOpenUntil(): number {
    return this.openUntil;
  }

  get activeMirror(): string {
    return this.mirrors[this.mirrorIndex % this.mirrors.length] as string;
  }

  /** Rewrite an absolute URL onto the active mirror, keeping path and query. */
  canonicalise(url: string, knownHosts: string[]): string {
    const parsed = new URL(url, this.activeMirror);
    const bare = parsed.hostname.replace(/^www\./, '');
    if (knownHosts.some((host) => host.replace(/^www\./, '') === bare)) {
      return `${this.activeMirror}${parsed.pathname}${parsed.search}`;
    }
    return parsed.toString();
  }

  async get(url: string): Promise<HttpResult> {
    const result = await this.request(url, 'text');
    return { status: result.status, body: result.body as string, url: result.url };
  }

  /**
   * Same mirror list, throttle, retry ladder and circuit breaker as `get` — only the decode
   * differs. A `.torrent` is binary, so reading it as text and re-encoding would corrupt its
   * bencode and yield a wrong infohash.
   */
  async getBuffer(url: string): Promise<HttpBufferResult> {
    const result = await this.request(url, 'buffer');
    return { status: result.status, body: result.body as Buffer, url: result.url };
  }

  private async request(url: string, as: 'text' | 'buffer'): Promise<{ status: number; body: string | Buffer; url: string }> {
    if (this.circuitOpen) {
      this.emit({ event: 'circuit_open', url, ms: 0, mirror: this.activeMirror });
      throw new CircuitOpenError(this.openUntil);
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.throttle();
      const target = attempt > 1 ? this.rotate(url) : url;
      const startedAt = this.now();
      try {
        const response = await this.fetchImpl(target, {
          redirect: 'follow',
          headers: { 'user-agent': this.userAgent, 'accept-language': 'en-IN,en;q=0.9' },
        });
        const body = as === 'buffer' ? Buffer.from(await response.arrayBuffer()) : await response.text();

        if (response.status === 403 || response.status === 429) {
          this.consecutiveBlocks++;
          if (this.consecutiveBlocks >= this.breakerThreshold) {
            this.openUntil = this.now() + this.breakerCooldownMs;
            this.emit({ event: 'circuit_open', url: target, status: response.status, ms: this.now() - startedAt, mirror: this.activeMirror });
            throw new CircuitOpenError(this.openUntil);
          }
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.delayMs * attempt;
          this.emit({ event: 'retry', url: target, status: response.status, ms: this.now() - startedAt, attempt, backoffMs: waitMs, mirror: this.activeMirror });
          lastError = new Error(`HTTP ${response.status}`);
          await this.sleep(waitMs);
          continue;
        }

        if (response.status >= 500) {
          this.emit({ event: 'retry', url: target, status: response.status, ms: this.now() - startedAt, attempt, backoffMs: 1000 * attempt * attempt, mirror: this.activeMirror });
          lastError = new Error(`HTTP ${response.status}`);
          await this.sleep(1000 * attempt * attempt);
          continue;
        }

        this.consecutiveBlocks = 0;
        this.emit({ event: 'request', url: target, status: response.status, ms: this.now() - startedAt, mirror: this.activeMirror });
        // `fetch` follows redirects (`redirect: 'follow'`), so `response.url` is where the page
        // actually landed. Reporting the *requested* target hid the 303 the site sends for a page
        // past a board's end, which is what let 14 boards crawl themselves to page 2131.
        return { status: response.status, body, url: response.url === '' ? target : response.url };
      } catch (error) {
        if (error instanceof CircuitOpenError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.sleep(1000 * attempt * attempt);
      }
    }

    throw lastError ?? new Error(`request failed: ${url}`);
  }

  private rotate(url: string): string {
    this.mirrorIndex++;
    const from = new URL(url, this.activeMirror);
    return `${this.activeMirror}${from.pathname}${from.search}`;
  }

  /**
   * Serialised behind a promise chain: two concurrent callers would otherwise both read the same
   * `lastRequestAt`, both compute "no wait needed", and hit the site simultaneously — which is
   * exactly the behaviour the 2s budget exists to prevent.
   */
  private async throttle(): Promise<void> {
    const previous = this.throttleGate;
    let release: () => void = () => undefined;
    this.throttleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const elapsed = this.now() - this.lastRequestAt;
      const remaining = this.delayMs - elapsed;
      if (remaining > 0) await this.sleep(remaining);
      this.lastRequestAt = this.now();
    } finally {
      release();
    }
  }
}
