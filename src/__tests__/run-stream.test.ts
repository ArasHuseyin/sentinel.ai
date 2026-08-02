import { describe, it, expect } from '@jest/globals';
import { Sentinel } from '../index.js';
import type { AgentStepEvent, AgentResult, AgentRunOptions } from '../agent/agent-loop.js';
import type { LLMProvider } from '../utils/llm-provider.js';

// These tests drive the real `Sentinel.runStream()`.
//
// They used to run against `makeRunStream`, a copy of the generator pasted into
// the test file. That verified the copy: the production generator could have
// been deleted outright and the suite would still have passed. The queue
// mechanics are identical, but now a regression in `src/index.ts` actually
// fails here — which is the entire point of the file.
//
// No browser is involved: a stub provider satisfies the constructor (no Gemini
// key needed, since `provider` is its own credential path) and a fake agent loop
// is installed in place of the real one.

/** Satisfies the LLMProvider contract; never called by these tests. */
const stubProvider: LLMProvider = {
  modelName: 'stub-model',
  generateStructuredData: async () => {
    throw new Error('not used');
  },
  generateText: async () => {
    throw new Error('not used');
  },
  analyzeImage: async () => {
    throw new Error('not used');
  },
};

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

interface FakeLoop {
  run: (goal: string, options?: AgentRunOptions) => Promise<AgentResult>;
  /** Steps the fake emitted before it stopped — the abort evidence. */
  emitted: number;
  /** Signal the last run was given, so tests can assert it was aborted. */
  seenSignal?: AbortSignal | undefined;
}

/**
 * Fake AgentLoop that emits `steps` one at a time, checking the abort signal
 * before each — the same contract the real loop implements at its step
 * boundary.
 *
 * The `setTimeout` between steps matters: a real step costs seconds of browser
 * and LLM latency, so the consumer always gets scheduled between them. With a
 * bare `await Promise.resolve()` the fake drains its whole list within a single
 * microtask checkpoint and finishes before the consumer can react — which would
 * make the cancellation tests pass or fail for reasons that have nothing to do
 * with cancellation.
 */
function fakeAgentLoop(steps: AgentStepEvent[], opts: { throwAfter?: number } = {}): FakeLoop {
  const loop: FakeLoop = {
    emitted: 0,
    run: async (_goal: string, options?: AgentRunOptions) => {
      loop.seenSignal = options?.signal;
      for (const step of steps) {
        if (options?.signal?.aborted) {
          return { ...finalResult, success: false, goalAchieved: false, aborted: true };
        }
        await new Promise(resolve => setTimeout(resolve, 1));
        loop.emitted++;
        options?.onStep?.(step);
        if (opts.throwAfter !== undefined && loop.emitted === opts.throwAfter) {
          throw new Error('agent crashed');
        }
      }
      return finalResult;
    },
  };
  return loop;
}

function makeSentinel(loop: FakeLoop): Sentinel {
  const sentinel = new Sentinel({ provider: stubProvider, verbose: 0 });
  // agentLoop is private and normally built by init(); swapping it here is the
  // narrowest seam that avoids launching Chromium.
  (sentinel as unknown as { agentLoop: FakeLoop }).agentLoop = loop;
  return sentinel;
}

describe('Sentinel.runStream', () => {
  it('yields each step event in order, then the final result', async () => {
    const steps = [makeStep(1), makeStep(2), makeStep(3)];
    const sentinel = makeSentinel(fakeAgentLoop(steps));
    const yielded: Array<AgentStepEvent | AgentResult> = [];

    for await (const event of sentinel.runStream('goal')) {
      yielded.push(event);
    }

    expect(yielded).toHaveLength(4); // 3 steps + final result
    expect((yielded[0] as AgentStepEvent).stepNumber).toBe(1);
    expect((yielded[1] as AgentStepEvent).stepNumber).toBe(2);
    expect((yielded[2] as AgentStepEvent).stepNumber).toBe(3);
    expect((yielded[3] as AgentResult).goalAchieved).toBe(true);
  });

  it('works with zero steps (immediate completion)', async () => {
    const sentinel = makeSentinel(fakeAgentLoop([]));
    const items: Array<AgentStepEvent | AgentResult> = [];
    for await (const event of sentinel.runStream('goal')) {
      items.push(event);
    }
    expect(items).toHaveLength(1);
    expect((items[0] as AgentResult).goalAchieved).toBe(true);
  });

  it('propagates errors thrown during the run', async () => {
    const sentinel = makeSentinel(fakeAgentLoop([makeStep(1)], { throwAfter: 1 }));
    await expect(async () => {
      for await (const _ of sentinel.runStream('goal')) {
        // consume until it throws
      }
    }).rejects.toThrow('agent crashed');
  });

  it('throws when called before init()', async () => {
    const sentinel = new Sentinel({ provider: stubProvider, verbose: 0 });
    await expect(async () => {
      for await (const _ of sentinel.runStream('goal')) {
        // no-op
      }
    }).rejects.toThrow('Sentinel not initialized');
  });

  // ─── Cancellation ───────────────────────────────────────────────────────────
  //
  // The bug: the agent ran detached from the generator, so a consumer that
  // stopped iterating (an SSE client disconnecting) left it stepping — and
  // billing — against a page nobody was reading.

  it('aborts the background run when the consumer breaks out of the loop', async () => {
    const steps = [makeStep(1), makeStep(2), makeStep(3), makeStep(4), makeStep(5)];
    const loop = fakeAgentLoop(steps);
    const sentinel = makeSentinel(loop);

    for await (const event of sentinel.runStream('goal')) {
      if ((event as AgentStepEvent).stepNumber === 2) break;
    }

    expect(loop.seenSignal?.aborted).toBe(true);
    // The loop stopped at its next boundary instead of running all five steps.
    expect(loop.emitted).toBeLessThan(steps.length);
  });

  it('aborts the background run when the consumer throws', async () => {
    const loop = fakeAgentLoop([makeStep(1), makeStep(2), makeStep(3), makeStep(4)]);
    const sentinel = makeSentinel(loop);

    await expect(async () => {
      for await (const _ of sentinel.runStream('goal')) {
        throw new Error('consumer exploded');
      }
    }).rejects.toThrow('consumer exploded');

    expect(loop.seenSignal?.aborted).toBe(true);
  });

  it('forwards an externally supplied AbortSignal', async () => {
    const controller = new AbortController();
    const loop = fakeAgentLoop([makeStep(1), makeStep(2), makeStep(3), makeStep(4)]);
    const sentinel = makeSentinel(loop);

    const seen: AgentStepEvent[] = [];
    for await (const event of sentinel.runStream('goal', { signal: controller.signal })) {
      seen.push(event as AgentStepEvent);
      if (seen.length === 1) controller.abort();
    }

    expect(loop.seenSignal?.aborted).toBe(true);
    expect(loop.emitted).toBeLessThan(4);
  });

  it('does not start the run at all when the external signal is already aborted', async () => {
    const loop = fakeAgentLoop([makeStep(1), makeStep(2)]);
    const sentinel = makeSentinel(loop);

    const events: Array<AgentStepEvent | AgentResult> = [];
    for await (const event of sentinel.runStream('goal', { signal: AbortSignal.abort() })) {
      events.push(event);
    }

    expect(loop.emitted).toBe(0);
    expect((events[events.length - 1] as AgentResult).aborted).toBe(true);
  });
});
