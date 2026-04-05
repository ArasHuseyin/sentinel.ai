export interface TokenUsageEntry {
  operation: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
}

// Approximate cost per 1M tokens (USD) – update as pricing changes
const COST_PER_1M: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 3.50, output: 10.50 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
};

/**
 * Tracks token usage and estimates costs across all LLM calls.
 */
export class TokenTracker {
  private entries: TokenUsageEntry[] = [];
  private model: string;

  constructor(model = 'gemini-1.5-flash') {
    this.model = model;
  }

  track(operation: string, inputTokens: number, outputTokens: number): void {
    this.entries.push({ operation, inputTokens, outputTokens, timestamp: Date.now() });
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
  }

  exportAsJSON(): string {
    return JSON.stringify(this.getUsage(), null, 2);
  }
}
