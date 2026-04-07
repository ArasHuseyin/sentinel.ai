import { describe, it, expect } from '@jest/globals';
import { TokenTracker } from '../../utils/token-tracker.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TokenTracker', () => {
  it('track() accumulates input and output tokens', () => {
    const tracker = new TokenTracker();
    tracker.track('plan', 100, 50);
    tracker.track('act', 200, 80);

    const usage = tracker.getUsage();
    expect(usage.totalInputTokens).toBe(300);
    expect(usage.totalOutputTokens).toBe(130);
  });

  it('getUsage() returns correct totals', () => {
    const tracker = new TokenTracker();
    tracker.track('step1', 400, 100);
    tracker.track('step2', 600, 200);

    const usage = tracker.getUsage();
    expect(usage.totalTokens).toBe(1300);
    expect(usage.entries).toHaveLength(2);
    expect(usage.entries[0]?.operation).toBe('step1');
  });

  it('estimatedCostUsd is calculated based on model pricing', () => {
    // gpt-4o: input $2.50/1M, output $10.00/1M
    const tracker = new TokenTracker('gpt-4o');
    tracker.track('query', 1_000_000, 1_000_000);

    const usage = tracker.getUsage();
    // 1M input × $2.50 + 1M output × $10.00 = $12.50
    expect(usage.estimatedCostUsd).toBeCloseTo(12.5, 4);
  });

  it('reset() clears all entries', () => {
    const tracker = new TokenTracker();
    tracker.track('op1', 100, 50);
    tracker.track('op2', 200, 80);

    tracker.reset();
    const usage = tracker.getUsage();
    expect(usage.entries).toHaveLength(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.estimatedCostUsd).toBe(0);
  });
});
