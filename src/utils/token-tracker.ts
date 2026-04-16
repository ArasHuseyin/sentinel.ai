import * as fs from 'node:fs';
import * as path from 'node:path';
import { BudgetExceededError } from '../types/errors.js';

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
const COST_PER_1M: Record<string, { input: number; output: number }> = {
  // Gemini — Flash models (budget tier)
  'gemini-2.5-flash-preview': { input: 0.075, output: 0.30 },
  'gemini-3-flash-preview':   { input: 0.075, output: 0.30 }, // estimate, update when GA
  'gemini-2.0-flash':         { input: 0.075, output: 0.30 },
  'gemini-1.5-flash':         { input: 0.075, output: 0.30 },
  // Gemini — Pro models
  'gemini-2.5-pro-preview':   { input: 1.25,  output: 5.00 },
  'gemini-1.5-pro':           { input: 3.50,  output: 10.50 },
  // OpenAI
  'gpt-4o':                   { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':              { input: 0.15,  output: 0.60 },
  'o3-mini':                  { input: 1.10,  output: 4.40 },
  // Anthropic
  'claude-3-5-sonnet':        { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku':         { input: 0.80,  output: 4.00 },
  'claude-3-haiku':           { input: 0.25,  output: 1.25 },
};

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

  constructor(
    model = 'gemini-1.5-flash',
    budgetOrOptions: TokenBudget | TokenTrackerOptions = {}
  ) {
    this.model = model;
    // Support both legacy `(model, TokenBudget)` and new `(model, TokenTrackerOptions)` forms.
    const isOptions = 'budget' in budgetOrOptions || 'persistPath' in budgetOrOptions;
    if (isOptions) {
      const opts = budgetOrOptions as TokenTrackerOptions;
      this.budget = opts.budget ?? {};
      this.persistPath = opts.persistPath;
    } else {
      this.budget = budgetOrOptions as TokenBudget;
      this.persistPath = undefined;
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
          e => typeof e?.operation === 'string' &&
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
    if (this.budget.maxCostUsd !== undefined && usage.estimatedCostUsd > this.budget.maxCostUsd) {
      throw new BudgetExceededError(
        `Cost budget exceeded: $${usage.estimatedCostUsd.toFixed(5)} > limit $${this.budget.maxCostUsd.toFixed(5)}`,
        { usage, budget: this.budget }
      );
    }
  }

  getUsage(): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    entries: TokenUsageEntry[];
  } {
    const totalInputTokens = this.entries.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutputTokens = this.entries.reduce((s, e) => s + e.outputTokens, 0);
    const totalTokens = totalInputTokens + totalOutputTokens;

    const pricing = COST_PER_1M[this.model] ?? { input: 0, output: 0 };
    const estimatedCostUsd =
      (totalInputTokens / 1_000_000) * pricing.input +
      (totalOutputTokens / 1_000_000) * pricing.output;

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
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
