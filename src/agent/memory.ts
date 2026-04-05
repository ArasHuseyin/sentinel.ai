export interface StepRecord {
  stepNumber: number;
  instruction: string;
  action: string;
  success: boolean;
  pageUrl: string;
  pageTitle: string;
  timestamp: number;
}

/**
 * Sliding context window over agent step history.
 * Keeps the last N steps to avoid exceeding LLM context limits.
 */
export class AgentMemory {
  private history: StepRecord[] = [];

  constructor(private readonly maxSteps: number = 20) {}

  add(record: StepRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxSteps) {
      this.history.shift();
    }
  }

  getHistory(): StepRecord[] {
    return [...this.history];
  }

  getSummary(): string {
    if (this.history.length === 0) return 'No steps taken yet.';
    return this.history
      .map(
        s =>
          `Step ${s.stepNumber}: [${s.success ? 'OK' : 'FAIL'}] ${s.instruction} → ${s.action} (${s.pageTitle})`
      )
      .join('\n');
  }

  clear(): void {
    this.history = [];
  }

  get length(): number {
    return this.history.length;
  }
}
