import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { parseRetryAfter, withRetry } from '../../utils/with-retry.js';
import type { Logger } from '../../utils/logger.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as Logger;

const NOW = 1_700_000_000_000;

describe('parseRetryAfter', () => {
  it('reads delta-seconds from a plain headers object', () => {
    expect(parseRetryAfter({ headers: { 'retry-after': '5' } }, NOW)).toBe(5000);
  });

  it('reads the capitalised header name', () => {
    expect(parseRetryAfter({ headers: { 'Retry-After': '2' } }, NOW)).toBe(2000);
  });

  it('reads from a fetch-style Headers object', () => {
    const headers = new Headers({ 'retry-after': '3' });
    expect(parseRetryAfter({ headers }, NOW)).toBe(3000);
  });

  it('reads from err.response.headers', () => {
    // SDKs differ in where they hang the response; both shapes are common.
    expect(parseRetryAfter({ response: { headers: { 'retry-after': '7' } } }, NOW)).toBe(7000);
  });

  it('reads a numeric retryAfter property', () => {
    expect(parseRetryAfter({ retryAfter: 4 }, NOW)).toBe(4000);
  });

  it('parses the HTTP-date form', () => {
    const at = new Date(NOW + 12_000).toUTCString();
    // toUTCString truncates to whole seconds, so allow the rounding.
    expect(parseRetryAfter({ headers: { 'retry-after': at } }, NOW)).toBeGreaterThan(11_000);
  });

  it('caps an absurd delay rather than parking the agent', () => {
    expect(parseRetryAfter({ headers: { 'retry-after': '3600' } }, NOW)).toBe(30_000);
  });

  it('returns null for a past HTTP-date', () => {
    const at = new Date(NOW - 5_000).toUTCString();
    expect(parseRetryAfter({ headers: { 'retry-after': at } }, NOW)).toBeNull();
  });

  it('returns null for a non-positive delta', () => {
    // "0" means retry now — treated as no hint so backoff still spaces attempts.
    expect(parseRetryAfter({ headers: { 'retry-after': '0' } }, NOW)).toBeNull();
  });

  it('returns null when the header is absent or unparseable', () => {
    expect(parseRetryAfter({}, NOW)).toBeNull();
    expect(parseRetryAfter({ headers: {} }, NOW)).toBeNull();
    expect(parseRetryAfter({ headers: { 'retry-after': 'soon' } }, NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Advances fake timers until the promise settles. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const race = promise.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error })
    );
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(60_000);
    }
    const outcome = await race;
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  it('returns the value without retrying on success', async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
    await expect(settle(withRetry(fn, 'test', 3, silentLogger))).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable error and eventually succeeds', async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('rate limit'), { status: 429 }))
      .mockResolvedValue('recovered');
    await expect(settle(withRetry(fn, 'test', 3, silentLogger))).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error', async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    await expect(settle(withRetry(fn, 'test', 3, silentLogger))).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of attempts', async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('overloaded'), { status: 503 }));
    await expect(settle(withRetry(fn, 'test', 3, silentLogger))).rejects.toThrow('overloaded');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('applies jitter so parallel workers do not retry in lockstep', async () => {
    // Without jitter every worker that hit the same 429 woke at exactly the
    // same millisecond and reproduced the burst that caused the rate limit.
    const randomSpy = jest.spyOn(Math, 'random');
    const delays: number[] = [];
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        cb();
        return 0 as unknown as NodeJS.Timeout;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);

    randomSpy.mockReturnValue(0);
    const failing = () => Promise.reject(Object.assign(new Error('rate limit'), { status: 429 }));
    await withRetry(failing, 'test', 2, silentLogger).catch(() => {});
    const low = delays.at(-1)!;

    delays.length = 0;
    randomSpy.mockReturnValue(0.999);
    await withRetry(failing, 'test', 2, silentLogger).catch(() => {});
    const high = delays.at(-1)!;

    setTimeoutSpy.mockRestore();

    // Full jitter spans [ceiling/2, ceiling): identical inputs must not produce
    // an identical delay.
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(500);
    expect(high).toBeLessThanOrEqual(1000);
  });

  it('honours a Retry-After hint over exponential backoff', async () => {
    const delays: number[] = [];
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        cb();
        return 0 as unknown as NodeJS.Timeout;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);
    jest.spyOn(Math, 'random').mockReturnValue(0.999);

    const failing = () =>
      Promise.reject(
        Object.assign(new Error('rate limit'), { status: 429, headers: { 'retry-after': '10' } })
      );
    await withRetry(failing, 'test', 2, silentLogger).catch(() => {});
    setTimeoutSpy.mockRestore();

    // Base backoff for attempt 0 is 1000ms; the server said 10s, so the delay
    // must come from the header, jittered into [5000, 10000).
    expect(delays.at(-1)!).toBeGreaterThanOrEqual(5000);
    expect(delays.at(-1)!).toBeLessThanOrEqual(10_000);
  });
});
