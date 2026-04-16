import { describe, it, expect } from '@jest/globals';
import { RateLimiter } from '../../utils/rate-limiter.js';

describe('RateLimiter', () => {
  it('first acquire for any host returns immediately', async () => {
    const limiter = new RateLimiter(2); // 500ms between requests
    const start = Date.now();
    await limiter.acquire('example.com');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // Essentially instant
  });

  it('second acquire on the same host waits the configured interval', async () => {
    const limiter = new RateLimiter(10); // 100ms between requests
    await limiter.acquire('example.com');
    const start = Date.now();
    await limiter.acquire('example.com');
    const elapsed = Date.now() - start;
    // Should wait ~100ms; allow generous upper bound for CI jitter
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(300);
  });

  it('different hosts are tracked independently', async () => {
    const limiter = new RateLimiter(2); // 500ms between requests (sloooow)
    await limiter.acquire('example.com');
    const start = Date.now();
    await limiter.acquire('other.com'); // different host — no wait
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('three back-to-back acquires chain correctly', async () => {
    const limiter = new RateLimiter(20); // 50ms interval
    const start = Date.now();
    await limiter.acquire('example.com');
    await limiter.acquire('example.com');
    await limiter.acquire('example.com');
    const elapsed = Date.now() - start;
    // Total should be ~2 × 50ms = 100ms (first is free, next two wait)
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(300);
  });

  it('concurrent acquires on same host all serialize through reserved slots', async () => {
    const limiter = new RateLimiter(20); // 50ms interval
    const start = Date.now();
    await Promise.all([
      limiter.acquire('example.com'),
      limiter.acquire('example.com'),
      limiter.acquire('example.com'),
    ]);
    const elapsed = Date.now() - start;
    // All three reservations are scheduled before any timer completes — each
    // one adds intervalMs on top of the previous reservation, so the last
    // awaiter waits ~2× interval = 100ms total.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(400);
  });

  it('rejects non-positive requestsPerSecond', () => {
    expect(() => new RateLimiter(0)).toThrow();
    expect(() => new RateLimiter(-1)).toThrow();
    expect(() => new RateLimiter(NaN)).toThrow();
  });
});
