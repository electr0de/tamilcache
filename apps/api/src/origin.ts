const DEFAULT_PORT = process.env['PORT'] ?? '8484';

export interface OriginSource {
  headers: Record<string, unknown>;
  protocol?: string;
}

/**
 * The origin the calling client actually used.
 *
 * A container told `localhost:8484` fetches *itself*, so a feed built on a static localhost
 * origin hands Radarr links that can never be grabbed — while the search itself looks fine.
 * `SELF_ORIGIN` still wins when someone pins it (e.g. behind a proxy).
 */
export function requestOrigin(request: OriginSource, pinned?: string): string {
  const fromEnv = process.env['SELF_ORIGIN']?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  if (pinned) return pinned.replace(/\/+$/, '');

  const host = request.headers['host'];
  if (typeof host === 'string' && host.length > 0) {
    const protocol = request.protocol === 'https' ? 'https' : 'http';
    return `${protocol}://${host}`;
  }
  return `http://localhost:${DEFAULT_PORT}`;
}
