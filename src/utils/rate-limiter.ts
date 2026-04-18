/**
 * Per-domain navigation rate limiter.
 *
 * Maintains one "next-allowed" timestamp per hostname. When `acquire(host)`
 * is called more frequently than `1000 / requestsPerSecond` ms for that
 * host, the call awaits the required delay; other hosts are unaffected.
 *
 * Motivation: parallel runs or tight retry loops hitting the same domain
 * (Amazon, Booking, any e-commerce site) trip bot-detection systems. A
 * conservative per-domain cap keeps traffic below detection thresholds
 * without affecting throughput against other hosts.
 *
 * The implementation is intentionally minimal — no queue, no token bucket,
 * no burst credit. It is correct under sequential use and under concurrent
 * use from a single process (Map reads/writes are synchronous in V8).
 */
export class RateLimiter {
  private nextAllowed = new Map<string, number>();
  private readonly intervalMs: number;

  /**
   * @param requestsPerSecond Upper bound on navigations per hostname. Must be > 0.
   */
  constructor(requestsPerSecond: number) {
    if (!(requestsPerSecond > 0)) {
      throw new Error(`requestsPerSecond must be > 0, got ${requestsPerSecond}`);
    }
    this.intervalMs = Math.ceil(1000 / requestsPerSecond);
  }

  /**
   * Waits until the next slot for `hostname` is available, then reserves it.
   * Different hostnames are tracked independently.
   */
  async acquire(hostname: string): Promise<void> {
    const now = Date.now();
    const prev = this.nextAllowed.get(hostname) ?? 0;
    // Reserve the slot synchronously — BEFORE any await — so concurrent
    // callers chain through the Map correctly. Each awaiter captures its
    // own slot; the next caller sees the updated `nextAllowed` even while
    // the previous one is still sleeping.
    const mySlot = Math.max(now, prev);
    this.nextAllowed.set(hostname, mySlot + this.intervalMs);
    const wait = mySlot - now;
    if (wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}
