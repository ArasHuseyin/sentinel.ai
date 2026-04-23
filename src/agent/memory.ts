export interface StepRecord {
  stepNumber: number;
  instruction: string;
  action: string;
  success: boolean;
  pageUrl: string;
  pageTitle: string;
  timestamp: number;
  /**
   * For extract steps: the data returned by the extraction. Stored so the planner
   * can tell whether a goal has already been answered and stop re-extracting.
   * Kept out of click/fill steps to avoid bloating the context.
   */
  data?: unknown;
}

/** Hard cap on per-step data text shown to the planner, to keep the summary compact. */
const DATA_PREVIEW_MAX_CHARS = 300;

/**
 * Serializes arbitrary data to a stable, truncated JSON preview for the planner
 * summary. Falls back to String(data) if JSON.stringify fails (cyclic refs etc.).
 */
function previewData(data: unknown): string {
  let text: string;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    text = String(data);
  }
  if (text.length > DATA_PREVIEW_MAX_CHARS) {
    return text.slice(0, DATA_PREVIEW_MAX_CHARS) + '…';
  }
  return text;
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
      .map(s => {
        const head = `Step ${s.stepNumber}: [${s.success ? 'OK' : 'FAIL'}] ${s.instruction} → ${s.action} (${s.pageTitle})`;
        return s.data !== undefined ? `${head} :: data=${previewData(s.data)}` : head;
      })
      .join('\n');
  }

  clear(): void {
    this.history = [];
  }

  get length(): number {
    return this.history.length;
  }
}
