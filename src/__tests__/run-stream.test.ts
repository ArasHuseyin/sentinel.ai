import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentStepEvent, AgentResult } from '../agent/agent-loop.js';

// ─── Minimal stub for runStream logic ─────────────────────────────────────────
// We test the generator contract without spinning up a real browser.

/**
 * Standalone replica of the runStream generator so we can test the queue
 * mechanics and typing independently of the Sentinel class.
 */
async function* makeRunStream(
  steps: AgentStepEvent[],
  finalResult: AgentResult,
  shouldThrow?: Error
): AsyncGenerator<AgentStepEvent | AgentResult> {
  const queue: Array<AgentStepEvent | AgentResult | Error | null> = [];
  let notify: (() => void) | null = null;

  const enqueue = (item: AgentStepEvent | AgentResult | Error | null) => {
    queue.push(item);
    notify?.();
  };

  const waitForItem = (): Promise<void> =>
    new Promise(resolve => {
      if (queue.length > 0) { resolve(); return; }
      notify = () => { notify = null; resolve(); };
    });

  // Simulate the async agent run
  const runPromise = (async () => {
    for (const step of steps) {
      await Promise.resolve(); // yield to event loop
      enqueue(step);
    }
    if (shouldThrow) {
      enqueue(shouldThrow);
    } else {
      enqueue(finalResult);
    }
    enqueue(null);
  })();

  while (true) {
    await waitForItem();
    const item = queue.shift()!;
    if (item === null) break;
    if (item instanceof Error) { await runPromise; throw item; }
    yield item as AgentStepEvent | AgentResult;
  }

  await runPromise;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const makeStep = (n: number): AgentStepEvent => ({
  stepNumber: n,
  type: 'act',
  instruction: `step ${n}`,
  reasoning: 'test',
  success: true,
  pageUrl: 'https://example.com',
  pageTitle: 'Test',
});

const finalResult: AgentResult = {
  success: true,
  goalAchieved: true,
  totalSteps: 3,
  message: 'done',
  history: [],
};

describe('runStream', () => {
  it('yields each step event in order', async () => {
    const steps = [makeStep(1), makeStep(2), makeStep(3)];
    const yielded: Array<AgentStepEvent | AgentResult> = [];

    for await (const event of makeRunStream(steps, finalResult)) {
      yielded.push(event);
    }

    expect(yielded).toHaveLength(4); // 3 steps + final result
    expect((yielded[0] as AgentStepEvent).stepNumber).toBe(1);
    expect((yielded[1] as AgentStepEvent).stepNumber).toBe(2);
    expect((yielded[2] as AgentStepEvent).stepNumber).toBe(3);
    expect((yielded[3] as AgentResult).goalAchieved).toBe(true);
  });

  it('yields final AgentResult as last item', async () => {
    const steps = [makeStep(1)];
    const items: Array<AgentStepEvent | AgentResult> = [];

    for await (const event of makeRunStream(steps, finalResult)) {
      items.push(event);
    }

    const last = items[items.length - 1] as AgentResult;
    expect(last).toHaveProperty('goalAchieved');
    expect(last.message).toBe('done');
  });

  it('works with zero steps (immediate completion)', async () => {
    const items: Array<AgentStepEvent | AgentResult> = [];
    for await (const event of makeRunStream([], finalResult)) {
      items.push(event);
    }
    expect(items).toHaveLength(1); // only the final result
    expect((items[0] as AgentResult).goalAchieved).toBe(true);
  });

  it('propagates errors thrown during the run', async () => {
    const err = new Error('agent crashed');
    await expect(async () => {
      for await (const _ of makeRunStream([], finalResult, err)) {
        // should throw
      }
    }).rejects.toThrow('agent crashed');
  });

  it('is async-iterable and can be collected with Array.from via manual loop', async () => {
    const steps = [makeStep(1), makeStep(2)];
    const collected: Array<AgentStepEvent | AgentResult> = [];
    for await (const e of makeRunStream(steps, finalResult)) {
      collected.push(e);
    }
    expect(collected.length).toBeGreaterThan(0);
  });
});
