import { jest, describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TokenTracker, type TokenUsageEntry } from '../../utils/token-tracker.js';
import { BudgetExceededError } from '../../types/errors.js';

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

  // ─── Pricing resolution ────────────────────────────────────────────────────
  //
  // getUsage() used to fall back to `{ input: 0, output: 0 }` for any model
  // missing from the pricing table, so estimatedCostUsd was a hard $0.00 and
  // indistinguishable from a genuinely free run. `pricingKnown` makes the
  // difference explicit, and the maxCostUsd cap keys off it.
  describe('pricing resolution', () => {
    it('reports pricingKnown for a model in the table', () => {
      const tracker = new TokenTracker('gpt-4o');
      tracker.track('query', 1000, 1000);
      expect(tracker.getUsage().pricingKnown).toBe(true);
    });

    it('reports pricingKnown=false and $0 for an unknown model', () => {
      const tracker = new TokenTracker('some-model-that-does-not-exist');
      tracker.track('query', 1_000_000, 1_000_000);

      const usage = tracker.getUsage();
      expect(usage.pricingKnown).toBe(false);
      expect(usage.estimatedCostUsd).toBe(0);
      // Token counts stay accurate — only the money is unknown.
      expect(usage.totalTokens).toBe(2_000_000);
    });

    it('resolves dated model snapshots to their base pricing entry', () => {
      // claude-haiku-4-5: input $1.00/1M, output $5.00/1M
      const tracker = new TokenTracker('claude-haiku-4-5-20251001');
      tracker.track('query', 1_000_000, 1_000_000);

      const usage = tracker.getUsage();
      expect(usage.pricingKnown).toBe(true);
      expect(usage.estimatedCostUsd).toBeCloseTo(6.0, 4);
    });

    it('prices the current Claude generation', () => {
      const tracker = new TokenTracker('claude-sonnet-5');
      tracker.track('query', 1_000_000, 0);
      expect(tracker.getUsage().estimatedCostUsd).toBeCloseTo(3.0, 4);
    });
  });

  describe('budget enforcement', () => {
    it('no budget → track never throws regardless of volume', () => {
      const tracker = new TokenTracker();
      expect(() => tracker.track('huge', 10_000_000, 10_000_000)).not.toThrow();
    });

    it('maxTokens still applies when the model has no pricing', () => {
      // The tokens cap must not depend on the pricing table at all.
      const tracker = new TokenTracker('some-model-that-does-not-exist', {
        budget: { maxTokens: 1000 },
      });
      expect(() => tracker.track('big', 900, 900)).toThrow(BudgetExceededError);
    });

    it('warns instead of silently passing when maxCostUsd is set on an unpriced model', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const tracker = new TokenTracker('some-model-that-does-not-exist', {
          budget: { maxCostUsd: 0.01 },
        });

        // Previously this was a no-op forever: cost was pinned at $0.00, so the
        // cap could never trigger and the user got no indication at all.
        expect(() => tracker.track('huge', 50_000_000, 50_000_000)).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('cost cap cannot be enforced');

        // The warning is emitted once per run, not on every tracked call.
        tracker.track('huge-again', 50_000_000, 50_000_000);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('throws BudgetExceededError when maxTokens is crossed', () => {
      const tracker = new TokenTracker('gpt-4o', { maxTokens: 1000 });
      tracker.track('step1', 400, 300); // 700 total — under limit
      expect(() => tracker.track('step2', 200, 200)).toThrow(BudgetExceededError); // 1100 total
    });

    it('throws BudgetExceededError when maxCostUsd is crossed', () => {
      // gpt-4o: $2.50/1M input, $10.00/1M output
      // 100k input + 100k output = $0.25 + $1.00 = $1.25
      const tracker = new TokenTracker('gpt-4o', { maxCostUsd: 1.0 });
      expect(() => tracker.track('expensive', 100_000, 100_000)).toThrow(BudgetExceededError);
    });

    it('the throwing call IS recorded (fire-after-bill semantics)', () => {
      const tracker = new TokenTracker('gpt-4o', { maxTokens: 500 });
      expect(() => tracker.track('crossing', 400, 200)).toThrow(BudgetExceededError);
      expect(tracker.getUsage().totalTokens).toBe(600);
      expect(tracker.getUsage().entries).toHaveLength(1);
    });

    it('setBudget updates limits at runtime', () => {
      const tracker = new TokenTracker();
      tracker.track('step1', 500, 500);
      tracker.setBudget({ maxTokens: 100 });
      expect(() => tracker.track('step2', 1, 1)).toThrow(BudgetExceededError);
    });

    it('error carries usage + budget context for diagnostics', () => {
      const tracker = new TokenTracker('gpt-4o', { maxTokens: 100 });
      let thrown: unknown;
      try {
        tracker.track('too-big', 200, 0);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      {
        const e = thrown;
        expect(e).toBeInstanceOf(BudgetExceededError);
        const err = e as BudgetExceededError;
        expect(err.code).toBe('BUDGET_EXCEEDED');
        expect(err.context?.usage.totalTokens).toBe(200);
        expect(err.context?.budget.maxTokens).toBe(100);
      }
    });

    it('only checks limits that are defined', () => {
      // maxCostUsd only — token count irrelevant
      const tracker = new TokenTracker('gpt-4o', { maxCostUsd: 100 });
      expect(() => tracker.track('many-cheap', 1_000_000, 0)).not.toThrow(); // $2.50, under $100
    });
  });

  describe('persistent cost audit', () => {
    function tempPath(label = 'audit'): string {
      return path.join(
        os.tmpdir(),
        `sentinel-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
      );
    }

    it('writes entries to disk on each track()', () => {
      const file = tempPath();
      try {
        const tracker = new TokenTracker('gpt-4o', { persistPath: file });
        tracker.track('plan', 100, 50);
        tracker.track('act', 200, 80);
        const raw = fs.readFileSync(file, 'utf-8');
        const entries = JSON.parse(raw) as TokenUsageEntry[];
        expect(entries).toHaveLength(2);
        expect(entries[0]!.operation).toBe('plan');
        expect(entries[1]!.inputTokens).toBe(200);
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ok */
        }
      }
    });

    it('reloads entries from disk at construction', () => {
      const file = tempPath();
      try {
        const first = new TokenTracker('gpt-4o', { persistPath: file });
        first.track('step1', 100, 50);
        first.track('step2', 200, 100);

        const second = new TokenTracker('gpt-4o', { persistPath: file });
        const usage = second.getUsage();
        expect(usage.entries).toHaveLength(2);
        expect(usage.totalTokens).toBe(450);
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ok */
        }
      }
    });

    it('creates parent directories on first write', () => {
      const dir = path.join(os.tmpdir(), `sentinel-nested-${Date.now()}`, 'audit');
      const file = path.join(dir, 'usage.json');
      try {
        const tracker = new TokenTracker('gpt-4o', { persistPath: file });
        tracker.track('op', 10, 10);
        expect(fs.existsSync(file)).toBe(true);
      } finally {
        try {
          fs.rmSync(path.dirname(dir), { recursive: true, force: true });
        } catch {
          /* ok */
        }
      }
    });

    it('tolerates missing/malformed files gracefully', () => {
      const file = tempPath('malformed');
      try {
        fs.writeFileSync(file, '{not-json');
        // Should not throw; should start with empty ledger
        const tracker = new TokenTracker('gpt-4o', { persistPath: file });
        expect(tracker.getUsage().entries).toHaveLength(0);
        // And overwrites on next track()
        tracker.track('fresh', 1, 1);
        const reloaded = new TokenTracker('gpt-4o', { persistPath: file });
        expect(reloaded.getUsage().entries).toHaveLength(1);
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ok */
        }
      }
    });

    it('reset() clears persisted entries', () => {
      const file = tempPath('reset');
      try {
        const tracker = new TokenTracker('gpt-4o', { persistPath: file });
        tracker.track('op', 100, 50);
        tracker.reset();
        const reloaded = new TokenTracker('gpt-4o', { persistPath: file });
        expect(reloaded.getUsage().entries).toHaveLength(0);
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ok */
        }
      }
    });

    it('combined budget + persist: throws after flush so next run sees the prior spend', () => {
      const file = tempPath('combined');
      try {
        const tracker = new TokenTracker('gpt-4o', {
          budget: { maxTokens: 50 },
          persistPath: file,
        });
        expect(() => tracker.track('over', 60, 10)).toThrow(BudgetExceededError);
        // The crossing entry is flushed before the throw — survives restart
        const reloaded = new TokenTracker('gpt-4o', { persistPath: file });
        expect(reloaded.getUsage().totalTokens).toBe(70);
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ok */
        }
      }
    });
  });
});
