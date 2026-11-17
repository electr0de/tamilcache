import { CircuitOpenError } from './http-client.js';

/**
 * One readable line for a dead letter. Never a stack: `detail` is capped at 2 KB and a stack
 * would crowd out the reason. `PoliteHttpClient` returns 404s as ordinary results, so most dead
 * letters surface as parse reasons rather than HTTP errors — that distinction is the point.
 */
export function describeError(error: unknown): string {
  if (error instanceof CircuitOpenError) {
    return `circuit open until ${new Date(error.untilMs).toISOString()}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
