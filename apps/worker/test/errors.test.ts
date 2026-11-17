import { describe, expect, it } from 'vitest';
import { describeError } from '../src/errors.js';
import { CircuitOpenError } from '../src/http-client.js';

describe('describeError', () => {
  it('names a circuit open with the time it reopens', () => {
    expect(describeError(new CircuitOpenError(Date.parse('2026-11-10T18:42:00Z')))).toBe(
      'circuit open until 2026-11-10T18:42:00.000Z',
    );
  });

  it('keeps an Error message verbatim', () => {
    expect(describeError(new Error('listing page yielded no topics: https://x/1'))).toBe(
      'listing page yielded no topics: https://x/1',
    );
  });

  it('stringifies a non-error', () => {
    expect(describeError('boom')).toBe('boom');
  });
});
