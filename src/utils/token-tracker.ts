import * as fs from 'node:fs';
import * as path from 'node:path';
import { BudgetExceededError } from '../types/errors.js';
import { createLogger, type Logger } from './logger.js';

export interface TokenUsageEntry {
  operation: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
}

/**
 * Per-run spend cap. Either limit can be omitted — the tracker only checks
 * fields that are present. Exceeding any configured limit throws
 * `BudgetExceededError` from the next `track()` call.
 */
export interface TokenBudget {
  /** Hard cap on cumulative input+output tokens across all operations. */
  maxTokens?: number;
  /** Hard cap on estimated USD cost (derived from the model's pricing table). */
  maxCostUsd?: number;
}

// Approximate cost per 1M tokens (USD) – update as pricing changes
// Sources: ai.google.dev/pricing, openai.com/pricing, anthropic.com/pricing
//
// Keys are matched exactly first, then by longest registered prefix, so dated
// snapshot ids (e.g. "claude-haiku-4-5-20251001") resolve to their base entry
// instead of silently falling through to "no pricing".
const COST_PER_1M: Record<string, { input: number; output: number }> = {
  // Gemini — Flash models (budget tier)
  'gemini-2.5-flash-preview': { input: 0.075, output: 0.3 },
  'gemini-3-flash-preview': { input: 0.075, output: 0.3 }, // estimate, update when GA
  'gemini-2.0-flash': { input: 0.075, output: 0.3 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  // Gemini — Pro models
  'gemini-3.1-pro-preview': { input: 1.25, output: 5.0 }, // estimate, update when GA
  'gemini-2.5-pro-preview': { input: 1.25, output: 5.0 },
  'gemini-1.5-pro': { input: 3.5, output: 10.5 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Anthropic — current generation
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  // Anthropic — legacy
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
};

/**
 * Resolves a model id to its pricing entry, or `null` when the model is not in
 * the table.
 *
 * Returning `null` rather than a zero-cost fallback is deliberate: `getUsage()`
 * used to default unknown models to `{ input: 0, output: 0 }`, so
 * `estimatedCostUsd` stayed at exactly $0.00 forever and the `maxCostUsd`
 * budget check could never fire. A spend cap that silently does nothing is
 * worse than no cap at all.
 */
export function resolvePricing(model: string): { input: number; output: number } | null {
  const exact = COST_PER_1M[model];
  if (exact) return exact;

  // Longest-prefix match handles dated snapshots ("claude-haiku-4-5-20251001")
  // and regional/suffixed variants without needing an entry per snapshot.
  let bestKey = '';
  for (const key of Object.keys(COST_PER_1M)) {
    if (model.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  return bestKey ? COST_PER_1M[bestKey]! : null;
}

export interface TokenTrackerOptions {
  /** Per-run spend cap. See `TokenBudget` for semantics. */
  budget?: TokenBudget;
  /**
   * Optional JSON file path for persistent cost audit. When set, the tracker
   * loads prior entries at construction time and appends every `track()` call
   * back to disk. Survives process restarts and is mergeable across parallel
   * runs (each run gets a distinct file, aggregated externally).
   *
   * Writes are synchronous — acceptable at typical agent cadences (≪100
   * LLM calls per second). Not suitable for hot loops.
   */
  persistPath?: string;
  /** Sink for budget diagnostics. Defaults to a console logger. */
  logger?: Logger;
}

/**
 * Tracks token usage and estimates costs across all LLM calls.
 * Optionally enforces a `TokenBudget`: once a threshold is crossed, the
 * next `track()` throws `BudgetExceededError`, which propagates out of
 * whichever engine is mid-LLM-call and halts further spend.
 *
 * When constructed with a `persistPath`, entries are also flushed to disk
 * after every `track()` so cost audits survive crashes and can be merged
 * across parallel worker processes.
 */
export class TokenTracker {
  private entries: TokenUsageEntry[] = [];
  private model: string;
  private budget: TokenBudget;
  private readonly persistPath: string | undefined;
  /** Guards the "cost cap cannot be enforced" warning to one emission per run. */
  private warnedUnpriced = false;
  private readonly logger: Logger;

  constructor(model = 'gemini-1.5-flash', budgetOrOptions: TokenBudget | TokenTrackerOptions = {}) {
    this.model = model;
    // Support both legacy `(model, TokenBudget)` and new `(model, TokenTrackerOptions)` forms.
    const isOptions = 'budget' in budgetOrOptions || 'persistPath' in budgetOrOptions;
    if (isOptions) {
      const opts = budgetOrOptions;
      this.budget = opts.budget ?? {};
      this.persistPath = opts.persistPath;
      this.logger = (opts.logger ?? createLogger(false, 1)).child('TokenTracker');
    } else {
      this.budget = budgetOrOptions as TokenBudget;
      this.persistPath = undefined;
      this.logger = createLogger(false, 1).child('TokenTracker');
    }
    if (this.persistPath) this.load();
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw) as TokenUsageEntry[];
      if (Array.isArray(parsed)) {
        // Validate entries; tolerate extra fields for forward-compat
        this.entries = parsed.filter(
          e =>
            typeof e?.operation === 'string' &&
            typeof e?.inputTokens === 'number' &&
            typeof e?.outputTokens === 'number' &&
            typeof e?.timestamp === 'number'
        );
      }
    } catch {
      // File absent or malformed — start with an empty ledger.
    }
  }

  private flush(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch {
      // Persistence failure must not abort the agent — the in-memory ledger remains authoritative.
    }
  }

  setBudget(budget: TokenBudget): void {
    this.budget = budget;
  }

  track(operation: string, inputTokens: number, outputTokens: number): void {
    this.entries.push({ operation, inputTokens, outputTokens, timestamp: Date.now() });
    this.flush();
    this.checkBudget();
  }

  private checkBudget(): void {
    if (this.budget.maxTokens === undefined && this.budget.maxCostUsd === undefined) return;
    const usage = this.getUsage();
    if (this.budget.maxTokens !== undefined && usage.totalTokens > this.budget.maxTokens) {
      throw new BudgetExceededError(
        `Token budget exceeded: ${usage.totalTokens} tokens > limit ${this.budget.maxTokens}`,
        { usage, budget: this.budget }
      );
    }
    if (this.budget.maxCostUsd !== undefined) {
      // An unpriced model cannot be cost-capped. Say so loudly once instead of
      // letting a $0.00 estimate quietly satisfy the limit forever.
      if (!usage.pricingKnown) {
        this.warnUnpricedBudgetOnce();
      } else if (usage.estimatedCostUsd > this.budget.maxCostUsd) {
        throw new BudgetExceededError(
          `Cost budget exceeded: $${usage.estimatedCostUsd.toFixed(5)} > limit $${this.budget.maxCostUsd.toFixed(5)}`,
          { usage, budget: this.budget }
        );
      }
    }
  }

  private warnUnpricedBudgetOnce(): void {
    if (this.warnedUnpriced) return;
    this.warnedUnpriced = true;
    this.logger.warn(
      `maxCostUsd is set but no pricing is known for model "${this.model}" — ` +
        `the cost cap cannot be enforced. Token counts are still tracked; use maxTokens for a ` +
        `hard limit, or add "${this.model}" to the pricing table.`
    );
  }

  getUsage(): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    /**
     * False when the model has no pricing entry. Callers must not read
     * `estimatedCostUsd` as "this run cost nothing" in that case — it means
     * "unknown", and it is why `maxCostUsd` is not enforceable for this model.
     */
    pricingKnown: boolean;
    entries: TokenUsageEntry[];
  } {
    const totalInputTokens = this.entries.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutputTokens = this.entries.reduce((s, e) => s + e.outputTokens, 0);
    const totalTokens = totalInputTokens + totalOutputTokens;

    const pricing = resolvePricing(this.model);
    const estimatedCostUsd = pricing
      ? (totalInputTokens / 1_000_000) * pricing.input +
        (totalOutputTokens / 1_000_000) * pricing.output
      : 0;

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
      pricingKnown: pricing !== null,
      entries: [...this.entries],
    };
  }

  reset(): void {
    this.entries = [];
    this.flush();
  }

  exportAsJSON(): string {
    return JSON.stringify(this.getUsage(), null, 2);
  }
}
