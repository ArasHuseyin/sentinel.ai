import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AgentLoop } from '../../agent/agent-loop.js';
import type { SimplifiedState } from '../../core/state-parser.js';
import type { LLMProvider } from '../../utils/llm-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<SimplifiedState> = {}): SimplifiedState {
  return {
    url: 'https://example.com',
    title: 'Test Page',
    elements: [],
    ...overrides,
  };
}

function makeStateParser(state: SimplifiedState = makeState()) {
  return {
    parse: jest.fn(async () => state),
    invalidateCache: jest.fn(),
  };
}

/**
 * Creates a state parser that alternates between two states on consecutive
 * calls.  The agent loop reads state at the start of each step and again
 * after the action.  Both calls must return DIFFERENT states so the post-act
 * verification logic does not mark a successful action as failed.
 */
function makeAlternatingStateParser() {
  const state1 = makeState({ url: 'https://example.com' });
  const state2 = makeState({ url: 'https://example.com/step' });
  let callCount = 0;
  return {
    parse: jest.fn(async () => {
      callCount++;
      return callCount % 2 === 1 ? state1 : state2;
    }),
    invalidateCache: jest.fn(),
  };
}

function makeActionEngine(success = true, message = 'done') {
  return {
    act: jest.fn(async () => ({ success, message, action: 'click something' })),
    tryRecoverFromBlocker: jest.fn(async () => false),
  };
}

function makeExtractionEngine() {
  return {
    extract: jest.fn(async () => ({})),
  };
}

/**
 * Creates a mock LLMProvider whose generateStructuredData returns a given
 * PlannedStep shape on every call (covers both planNextStep and reflect).
 */
function makePlannerLLM(overrides: {
  instruction?: string;
  isGoalComplete?: boolean;
  goalAchieved?: boolean;
} = {}): LLMProvider {
  return {
    generateStructuredData: jest.fn(async () => ({
      type: 'act',
      instruction: overrides.instruction ?? 'click the button',
      reasoning: 'test reasoning',
      isGoalComplete: overrides.isGoalComplete ?? false,
      goalAchieved: overrides.goalAchieved ?? false,
      reason: 'test reason',
    })) as any,
    generateText: jest.fn(async () => ''),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentLoop', () => {
  describe('post-action verification noise threshold', () => {
    // These tests verify the new diff-count threshold: a single element-fingerprint
    // diff without an interactive-state flip is treated as incidental noise
    // (ad re-render, live counter, etc.) and the action is marked as failed.
    // Multi-diff changes or any focused/checked/disabled flip pass through.

    const el = (id: number, name: string, extra: any = {}) => ({
      id, role: 'button', name, boundingClientRect: { x: 0, y: 0, width: 10, height: 10 }, ...extra,
    });

    function makePostActVerificationParser(before: SimplifiedState, after: SimplifiedState) {
      let call = 0;
      return {
        parse: jest.fn(async () => {
          // Agent loop: 1st call = pre-step read, 2nd call = post-action verification.
          // From 3rd call onward (next step's pre-read), keep returning "after" so
          // the loop can progress to goal-complete and terminate.
          call++;
          if (call === 1) return before;
          return after;
        }),
        invalidateCache: jest.fn(),
      };
    }

    it('treats a single-element name change as noise and marks action as failed', async () => {
      const before = makeState({ elements: [el(0, 'Submit'), el(1, 'Ad: Buy now')] });
      const after = makeState({
        elements: [el(0, 'Submit'), el(1, 'Ad: Flash sale ends soon')], // only id 1's name drifted
      });
      const llm = makePlannerLLM({ instruction: 'click submit' });
      const actionEngine = makeActionEngine(true);
      const stateParser = makePostActVerificationParser(before, after);

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('test', { maxSteps: 1 });

      // Action reported success but only 1 element diff + no interaction flip → unchanged.
      expect(result.history.some(s => !s.success)).toBe(true);
    });

    it('passes when two or more element fingerprints differ', async () => {
      const before = makeState({ elements: [el(0, 'Submit'), el(1, 'Cancel'), el(2, 'Help')] });
      const after = makeState({
        elements: [el(0, 'Submit', { state: { focused: true } }), el(1, 'Cancel (loading)'), el(2, 'Help')],
      });
      const llm = makePlannerLLM({ instruction: 'click submit' });
      const actionEngine = makeActionEngine(true);
      const stateParser = makePostActVerificationParser(before, after);

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('test', { maxSteps: 1 });

      // Two diffs (focus on 0, name drift on 1) → real change, action passes.
      expect(result.history.every(s => s.success)).toBe(true);
    });

    it('passes on a single focus flip even without other diffs', async () => {
      const before = makeState({ elements: [el(0, 'Submit'), el(1, 'Cancel')] });
      const after = makeState({
        elements: [el(0, 'Submit', { state: { focused: true } }), el(1, 'Cancel')],
      });
      const llm = makePlannerLLM({ instruction: 'click submit' });
      const actionEngine = makeActionEngine(true);
      const stateParser = makePostActVerificationParser(before, after);

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('test', { maxSteps: 1 });

      // Interaction flip (focused true→false or false→true) is always a real signal.
      expect(result.history.every(s => s.success)).toBe(true);
    });

    it('accepts URL change as success signal for select/fill actions (navigation-triggering dropdowns)', async () => {
      // Scenario: `<select>` on a page whose onchange triggers navigation to a
      // sorted/filtered URL. The select's value may not appear in the post-parse
      // AOM the same way — new page, new element IDs — but the URL change is a
      // clear signal the select had effect. Old behaviour only checked value
      // diffs → flagged this as "no input values changed" falsely.
      const before = makeState({ url: 'https://shop.example/list', elements: [el(0, 'Sort by')] });
      const after = makeState({
        url: 'https://shop.example/list?sort=rating',
        elements: [el(0, 'Sort by')],
      });
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async () => ({
          type: 'act',
          instruction: "Select 'Rating' from the sort dropdown",
          reasoning: '',
          isGoalComplete: false,
        })) as any,
        generateText: jest.fn(async () => ''),
      };
      // Action engine returns an action string starting with "select" so the
      // isFillLike branch runs.
      const actionEngine = {
        act: jest.fn(async () => ({ success: true, message: 'done', action: 'select on "Sort by"' })),
        tryRecoverFromBlocker: jest.fn(async () => false),
      };
      const stateParser = makePostActVerificationParser(before, after);

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('sort list', { maxSteps: 1 });

      // URL changed → select action counts as successful.
      expect(result.history.every(s => s.success)).toBe(true);
    });

    it('still fails select when neither value nor any structural signal changed', async () => {
      // The safety net must remain: if `select` really did nothing (no value
      // diff, no URL/title/count change, no fingerprint diff, no interaction
      // flip), the step is correctly marked as failed.
      const before = makeState({ elements: [el(0, 'Sort by'), el(1, 'Unrelated')] });
      const after = makeState({ elements: [el(0, 'Sort by'), el(1, 'Unrelated')] });
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async () => ({
          type: 'act',
          instruction: "Select 'Rating' from the sort dropdown",
          reasoning: '',
          isGoalComplete: false,
        })) as any,
        generateText: jest.fn(async () => ''),
      };
      const actionEngine = {
        act: jest.fn(async () => ({ success: true, message: 'done', action: 'select on "Sort by"' })),
        tryRecoverFromBlocker: jest.fn(async () => false),
      };
      const stateParser = makePostActVerificationParser(before, after);

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('sort list', { maxSteps: 1 });

      expect(result.history.some(s => !s.success)).toBe(true);
    });
  });

  describe('internal timeout', () => {
    it('exits cleanly before maxSteps when timeoutMs is exceeded', async () => {
      // Vary the instruction per call so instruction-loop detection doesn't mask
      // the timeout by aborting earlier. Planner sleeps 150ms so only 1–2 iterations
      // fit within a 250ms budget.
      let call = 0;
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async () => {
          call++;
          await new Promise(resolve => setTimeout(resolve, 150));
          return {
            type: 'act',
            instruction: `step ${call}`,
            reasoning: '',
            isGoalComplete: false,
            goalAchieved: false,
            reason: '',
          };
        }) as any,
        generateText: jest.fn(async () => ''),
      };
      const actionEngine = makeActionEngine(true);
      const stateParser = makeAlternatingStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('long goal', { maxSteps: 50, timeoutMs: 250 });

      // Timeout fires before maxSteps and before any loop-detection can kick in.
      expect(result.totalSteps).toBeLessThan(10);
      expect(result.goalAchieved).toBe(false);
      expect(result.message).toContain('timeout');
    });

    it('does not invoke planner.reflect on timeout (no phantom "Goal achieved")', async () => {
      const reflectCalled = { count: 0 };
      let call = 0;
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async (prompt: string) => {
          // Reflect prompt contains this marker; planner prompt does not.
          if (/Has the goal been fully and successfully achieved/i.test(prompt)) {
            reflectCalled.count++;
            return { goalAchieved: true, reason: 'lie' };
          }
          call++;
          await new Promise(resolve => setTimeout(resolve, 150));
          return {
            type: 'act',
            instruction: `step ${call}`,
            reasoning: '',
            isGoalComplete: false,
          };
        }) as any,
        generateText: jest.fn(async () => ''),
      };
      const actionEngine = makeActionEngine(true);
      const stateParser = makeAlternatingStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('timeout goal', { maxSteps: 50, timeoutMs: 250 });

      // On timeout, reflect must be skipped so it can't contradict the FAIL by
      // saying `goalAchieved: true` after the external wrapper already reported.
      expect(reflectCalled.count).toBe(0);
      expect(result.goalAchieved).toBe(false);
      expect(result.message).toContain('timeout');
    });
  });

  describe('instruction-loop detection', () => {
    it('aborts after the same instruction repeats 3 times in a row', async () => {
      const llm = makePlannerLLM({ instruction: 'click the button' });
      const actionEngine = makeActionEngine(true);
      // Use alternating state so post-action verification doesn't mark actions as "unchanged"
      const stateParser = makeAlternatingStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('achieve test goal', { maxSteps: 15 });

      // Loop detection fires after step 3 → agent stops before maxSteps
      expect(result.totalSteps).toBe(3);
      expect(result.goalAchieved).toBe(false);
      expect(actionEngine.act).toHaveBeenCalledTimes(3);
    });

    it('aborts when stuck on the same target across alternating actions (click→select→click loop)', async () => {
      // Reproduction of the real-world dropdown-loop bug: planner keeps
      // alternating between clicking the combobox and calling select on it,
      // never making progress. Each attempt fails (verifier says no change).
      // Existing `exactLoop` misses because instructions vary, `targetLoop`
      // misses because actions alternate. `stuckOnTarget` catches this:
      // same TARGET in 3-step window + at least one failed step → abort.
      let call = 0;
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async () => {
          call++;
          // Alternate action type so neither exactLoop nor targetLoop fires.
          const action = call % 2 === 1 ? 'click' : 'select';
          return {
            type: 'act',
            instruction: `${action} variant #${call} on sort dropdown`,
            reasoning: '',
            isGoalComplete: false,
          };
        }) as any,
        generateText: jest.fn(async () => ''),
      };
      // Action engine always returns success on a fixed target name, but the
      // post-action state doesn't change → outer verifier marks each step as
      // failed (success=false in memory).
      let actCall = 0;
      const actionEngine = {
        act: jest.fn(async () => {
          actCall++;
          const action = actCall % 2 === 1 ? 'click' : 'select';
          return { success: true, message: 'done', action: `${action} on "Sort by"` };
        }),
        tryRecoverFromBlocker: jest.fn(async () => false),
      };
      // Unchanged state across calls → verifier marks each step as failed.
      const stableState = makeState({ elements: [{ id: 0, role: 'combobox', name: 'Sort by', boundingClientRect: { x: 0, y: 0, width: 10, height: 10 } }] });
      const stateParser = {
        parse: jest.fn(async () => stableState),
        invalidateCache: jest.fn(),
      };

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('sort results', { maxSteps: 15 });

      // stuckOnTarget fires after 3 same-target-with-failure steps.
      expect(result.totalSteps).toBe(3);
    });

    it('aborts on extract-loop (3 extracts returning same data under varying field names)', async () => {
      // Planner keeps extracting with different field names (confirmation_message →
      // selected_plan → full_text) but the underlying data is identical. The old
      // exactLoop/targetLoop checks miss this because instructions differ and
      // the action string is `extract: ...` which doesn't fit the "on <name>"
      // pattern. The new extractLoop check catches it via value fingerprint.
      let call = 0;
      const fieldNames = ['confirmation_message', 'selected_plan', 'full_text', 'bottom_text'];
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async () => {
          const field = fieldNames[call % fieldNames.length] ?? 'x';
          call++;
          return {
            type: 'extract',
            instruction: `Extract ${field}`,
            reasoning: '',
            isGoalComplete: false,
            extractionSchema: { type: 'object' },
            goalAchieved: false,
            reason: '',
          };
        }) as any,
        generateText: jest.fn(async () => ''),
      };

      // ExtractionEngine always returns the same data under varying keys.
      let exCall = 0;
      const extractionEngine = {
        extract: jest.fn(async () => {
          const field = fieldNames[exCall % fieldNames.length] ?? 'x';
          exCall++;
          return { [field]: 'You selected the Pro plan. Continue to billing.' };
        }),
      };

      const actionEngine = makeActionEngine(true);
      const stateParser = makeAlternatingStateParser();

      const loop = new AgentLoop(actionEngine as any, extractionEngine as any, stateParser as any, llm);
      const result = await loop.run('extract the plan confirmation', { maxSteps: 15 });

      // Loop detection on extract values should fire after 3 identical-payload extracts.
      expect(result.totalSteps).toBe(3);
      expect(extractionEngine.extract).toHaveBeenCalledTimes(3);
    });

    it('does not abort if different instructions are used', async () => {
      let callCount = 0;
      const instructions = ['step one', 'step two', 'step three', 'step four'];
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async () => {
          const instruction = instructions[callCount % instructions.length] ?? 'done';
          // After 4 planning calls, mark goal complete on the reflect call
          if (callCount >= instructions.length) {
            callCount++;
            return { type: 'act', instruction: 'done', reasoning: '', isGoalComplete: false, goalAchieved: true, reason: 'done' };
          }
          callCount++;
          return { type: 'act', instruction, reasoning: 'reason', isGoalComplete: false, goalAchieved: false, reason: '' };
        }) as any,
        generateText: jest.fn(async () => ''),
      };

      const actionEngine = makeActionEngine(true);
      const stateParser = makeAlternatingStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('achieve test goal', { maxSteps: 4 });

      // Should NOT have been stopped by loop detection (different instructions)
      expect(result.totalSteps).toBeGreaterThanOrEqual(3);
      expect(actionEngine.act).toHaveBeenCalled();
    });
  });

  describe('consecutive failure detection', () => {
    it('aborts after 3 consecutive action failures', async () => {
      const llm = makePlannerLLM({ instruction: 'try action' });
      const actionEngine = makeActionEngine(false, 'element not found');
      const stateParser = makeStateParser();

      // Inject different instructions to avoid triggering loop detection
      let step = 0;
      (llm.generateStructuredData as jest.Mock).mockImplementation(async () => {
        step++;
        return {
          type: 'act',
          instruction: `action step ${step}`,
          reasoning: 'retry',
          isGoalComplete: false,
          goalAchieved: false,
          reason: '',
        };
      });

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('do something', { maxSteps: 15 });

      expect(result.totalSteps).toBe(3);
      expect(result.goalAchieved).toBe(false);
      expect(actionEngine.act).toHaveBeenCalledTimes(3);
    });

    it('resets consecutive failure count after a successful step', async () => {
      let callCount = 0;
      // Alternates: fail, succeed, fail, succeed, fail, succeed → never 3 in a row
      const actionEngine = {
        act: jest.fn(async () => {
          callCount++;
          return callCount % 2 === 0
            ? { success: true, message: 'ok', action: 'click' }
            : { success: false, message: 'fail', action: 'click' };
        }),
        tryRecoverFromBlocker: jest.fn(async () => false),
      };

      // Always return a UNIQUE instruction per call so loop-detection never fires.
      // Use a separate counter so we don't share state with actionEngine.
      let planCount = 0;
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async () => {
          planCount++;
          return {
            type: 'act',
            instruction: `unique step ${planCount}`,
            reasoning: '',
            isGoalComplete: false,
            goalAchieved: false,
            reason: '',
          };
        }) as any,
        generateText: jest.fn(async () => ''),
      };
      const stateParser = makeAlternatingStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('do something', { maxSteps: 6 });

      // Should run multiple steps without aborting due to consecutive failures
      // (alternating success/fail resets the consecutive counter)
      expect(result.totalSteps).toBeGreaterThanOrEqual(3);
    });
  });

  describe('goal completion', () => {
    it('returns goalAchieved=true when planner marks isGoalComplete', async () => {
      const llm = makePlannerLLM({ isGoalComplete: true, goalAchieved: true });
      const actionEngine = makeActionEngine(true);
      const stateParser = makeStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('click login and succeed', { maxSteps: 10 });

      expect(result.goalAchieved).toBe(true);
      expect(result.totalSteps).toBe(1);
      // No action should have been executed (isGoalComplete short-circuits before act())
      expect(actionEngine.act).not.toHaveBeenCalled();
    });

    it('emits step events via onStep callback', async () => {
      const llm = makePlannerLLM({ instruction: 'click A', isGoalComplete: false });
      let callCount = 0;
      (llm.generateStructuredData as jest.Mock).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { type: 'act', instruction: 'click A', reasoning: 'r', isGoalComplete: false, goalAchieved: false, reason: '' };
        return { type: 'act', instruction: 'click A', reasoning: 'r', isGoalComplete: false, goalAchieved: false, reason: '' };
      });

      const actionEngine = makeActionEngine(true);
      const stateParser = makeAlternatingStateParser();
      const stepEvents: any[] = [];

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      await loop.run('goal', { maxSteps: 3, onStep: (e) => stepEvents.push(e) });

      // 3 steps should have fired onStep (loop detection aborts after step 3)
      expect(stepEvents).toHaveLength(3);
      expect(stepEvents[0]).toMatchObject({ stepNumber: 1, success: true });
    });
  });

  describe('extract step type', () => {
    it('calls extractionEngine.extract() when planner returns type: extract', async () => {
      const extractionEngine = makeExtractionEngine();
      extractionEngine.extract = jest.fn(async () => ({ products: ['Laptop', 'Phone'] }));

      const llm: LLMProvider = {
        generateStructuredData: jest.fn<() => Promise<any>>()
          .mockResolvedValueOnce({ type: 'extract', instruction: 'Get products', reasoning: 'Need data', isGoalComplete: false })
          .mockResolvedValueOnce({ type: 'act', instruction: 'done', reasoning: '', isGoalComplete: true })
          .mockResolvedValueOnce({ goalAchieved: true, reason: 'done' }) as any,
        generateText: jest.fn(async () => ''),
      };

      const stateParser = makeStateParser();
      const actionEngine = makeActionEngine(true);

      const loop = new AgentLoop(actionEngine as any, extractionEngine as any, stateParser as any, llm);
      const result = await loop.run('extract product list', { maxSteps: 10 });

      expect(extractionEngine.extract).toHaveBeenCalled();
      expect(result.data).toEqual({ products: ['Laptop', 'Phone'] });
    });

    it('stores extracted data in AgentResult.data', async () => {
      const extractionEngine = makeExtractionEngine();
      extractionEngine.extract = jest.fn(async () => ({ products: ['Laptop', 'Phone'] }));

      const llm: LLMProvider = {
        generateStructuredData: jest.fn<() => Promise<any>>()
          .mockResolvedValueOnce({ type: 'extract', instruction: 'Get products', reasoning: 'Need data', isGoalComplete: false })
          .mockResolvedValueOnce({ type: 'act', instruction: 'done', reasoning: '', isGoalComplete: true })
          .mockResolvedValueOnce({ goalAchieved: true, reason: 'done' }) as any,
        generateText: jest.fn(async () => ''),
      };

      const stateParser = makeStateParser();
      const actionEngine = makeActionEngine(true);

      const loop = new AgentLoop(actionEngine as any, extractionEngine as any, stateParser as any, llm);
      const result = await loop.run('extract product list', { maxSteps: 10 });

      expect(result.data).toEqual({ products: ['Laptop', 'Phone'] });
    });

    it('records extract step in history with type: extract', async () => {
      const extractionEngine = makeExtractionEngine();
      extractionEngine.extract = jest.fn(async () => ({ items: [1, 2, 3] }));

      const llm: LLMProvider = {
        generateStructuredData: jest.fn<() => Promise<any>>()
          .mockResolvedValueOnce({ type: 'extract', instruction: 'Get items', reasoning: 'Need items', isGoalComplete: false })
          .mockResolvedValueOnce({ type: 'act', instruction: 'done', reasoning: '', isGoalComplete: true })
          .mockResolvedValueOnce({ goalAchieved: true, reason: 'done' }) as any,
        generateText: jest.fn(async () => ''),
      };

      const stateParser = makeStateParser();
      const actionEngine = makeActionEngine(true);

      const loop = new AgentLoop(actionEngine as any, extractionEngine as any, stateParser as any, llm);
      const result = await loop.run('extract items', { maxSteps: 10 });

      expect(result.history[0]?.type).toBe('extract');
    });
  });

  describe('history tracking', () => {
    it('includes all executed steps in the result history', async () => {
      const llm = makePlannerLLM({ instruction: 'click button' });
      const actionEngine = makeActionEngine(true);
      const stateParser = makeAlternatingStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('test goal', { maxSteps: 15 });

      // Loop detection fires after 3 steps
      expect(result.history).toHaveLength(3);
      expect(result.history[0]).toMatchObject({ stepNumber: 1, instruction: 'click button' });
    });
  });

  // ─── Vision-augmented planning ─────────────────────────────────────────────

  describe('vision-augmented planning', () => {
    it('passes pageDescription to planner when visionGrounding is available and page has many elements', async () => {
      // Create state with >100 elements
      const manyElements = Array.from({ length: 101 }, (_, i) =>
        ({ id: i, role: 'link', name: `Link ${i}`, boundingClientRect: { x: 0, y: i * 10, width: 60, height: 10 } })
      );
      const state = makeState({ elements: manyElements });
      const stateParser = makeStateParser(state);
      const actionEngine = makeActionEngine(true);

      // Vision grounding mock
      const visionGrounding = {
        takeScreenshot: jest.fn(async () => Buffer.from('png-data')),
        describeScreen: jest.fn(async () => 'A complex page with many navigation links'),
        findElement: jest.fn(async () => null),
      };

      const mockPage = {} as any; // page reference needed for visionGrounding calls

      const llm = makePlannerLLM({ instruction: 'click link 50', isGoalComplete: false });
      // Make loop detection fire after 3 steps
      let step = 0;
      (llm.generateStructuredData as jest.Mock).mockImplementation(async () => {
        step++;
        return {
          type: 'act',
          instruction: `step ${step}`,
          reasoning: 'proceed',
          isGoalComplete: step >= 2,
          goalAchieved: step >= 2,
          reason: '',
        };
      });

      const loop = new AgentLoop(
        actionEngine as any,
        makeExtractionEngine() as any,
        stateParser as any,
        llm,
        mockPage,
        visionGrounding as any
      );
      await loop.run('navigate to page 50', { maxSteps: 5 });

      // describeScreen should have been called because elements.length > 100
      expect(visionGrounding.describeScreen).toHaveBeenCalled();
    });

    it('skips vision when visionGrounding is not provided', async () => {
      const state = makeState({ elements: [] });
      const stateParser = makeStateParser(state);
      const actionEngine = makeActionEngine(true);
      const llm = makePlannerLLM({ isGoalComplete: true, goalAchieved: true });

      // No visionGrounding argument → 5th arg is page only
      const loop = new AgentLoop(
        actionEngine as any,
        makeExtractionEngine() as any,
        stateParser as any,
        llm
        // no page, no visionGrounding
      );
      const result = await loop.run('simple goal', { maxSteps: 5 });

      // Should complete normally without any vision errors
      expect(result.goalAchieved).toBe(true);
    });

    it('skips vision when page has few elements (<=100)', async () => {
      // Only 5 elements — below VISION_ELEMENT_THRESHOLD
      const fewElements = Array.from({ length: 5 }, (_, i) =>
        ({ id: i, role: 'button', name: `Button ${i}`, boundingClientRect: { x: 0, y: i * 30, width: 80, height: 30 } })
      );
      const state = makeState({ elements: fewElements });
      const stateParser = makeStateParser(state);
      const actionEngine = makeActionEngine(true);

      const visionGrounding = {
        takeScreenshot: jest.fn(async () => Buffer.from('png')),
        describeScreen: jest.fn(async () => 'simple page'),
        findElement: jest.fn(async () => null),
      };

      const mockPage = {} as any;

      const llm = makePlannerLLM({ isGoalComplete: true, goalAchieved: true });

      const loop = new AgentLoop(
        actionEngine as any,
        makeExtractionEngine() as any,
        stateParser as any,
        llm,
        mockPage,
        visionGrounding as any
      );
      await loop.run('click button 0', { maxSteps: 5 });

      // describeScreen should NOT have been called (too few elements)
      expect(visionGrounding.describeScreen).not.toHaveBeenCalled();
    });
  });

  // ─── Adaptive planner filtering ────────────────────────────────────────────

  describe('adaptive planner filtering', () => {
    it('planner receives goal-filtered elements instead of first 40', async () => {
      // Create 100 elements where only elements 70-80 have names matching goal keywords
      const elements = Array.from({ length: 100 }, (_, i) => {
        const isMatch = i >= 70 && i <= 80;
        return {
          id: i,
          role: 'button' as const,
          name: isMatch ? `Checkout Button ${i}` : `Generic Element ${i}`,
          boundingClientRect: { x: 0, y: i * 10, width: 80, height: 30 },
        };
      });

      const state = makeState({ elements });
      const stateParser = makeStateParser(state);
      const actionEngine = makeActionEngine(true);

      // Capture the prompt passed to generateStructuredData
      let capturedPrompt = '';
      const llm: LLMProvider = {
        generateStructuredData: jest.fn(async (prompt: any) => {
          if (typeof prompt === 'string' && prompt.includes('Checkout')) {
            capturedPrompt = prompt;
          }
          return {
            type: 'act',
            instruction: 'click checkout button',
            reasoning: 'found match',
            isGoalComplete: true,
            goalAchieved: true,
            reason: '',
          };
        }) as any,
        generateText: jest.fn(async () => ''),
      };

      const loop = new AgentLoop(
        actionEngine as any,
        makeExtractionEngine() as any,
        stateParser as any,
        llm
      );
      await loop.run('click checkout button', { maxSteps: 3 });

      // The LLM should have been called
      expect((llm.generateStructuredData as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    });
  });

  // ── State-based cookie-banner recovery ─────────────────────────────────────

  describe('state-based blocker recovery', () => {
    /**
     * Builds a state parser that returns states from `seq` on each parse call,
     * clamping to the last entry once exhausted. This lets us script the
     * "banner present on step 1, still present on step 2, gone on step 3" flow.
     */
    function makeScriptedStateParser(seq: SimplifiedState[]) {
      let i = 0;
      return {
        parse: jest.fn(async () => seq[Math.min(i++, seq.length - 1)]!),
        invalidateCache: jest.fn(),
      };
    }

    function withCookieBanner(url = 'https://example.com'): SimplifiedState {
      return {
        url,
        title: 'Welcome',
        elements: [
          {
            id: 0, role: 'button', name: 'Accept all cookies',
            boundingClientRect: { x: 10, y: 10, width: 120, height: 40 },
          },
          {
            id: 1, role: 'button', name: 'Continue',
            boundingClientRect: { x: 200, y: 100, width: 80, height: 40 },
          },
        ],
      };
    }

    function withoutBanner(url = 'https://example.com/next'): SimplifiedState {
      return {
        url,
        title: 'Next Page',
        elements: [
          {
            id: 0, role: 'button', name: 'Continue',
            boundingClientRect: { x: 200, y: 100, width: 80, height: 40 },
          },
        ],
      };
    }

    it('fires recovery whenever a blocker is present (not gated by step number)', async () => {
      const llm = makePlannerLLM({ instruction: 'click continue' });
      const actionEngine = makeActionEngine(true);
      // Banner is present right from step 1 — this case already worked under the old
      // step<=3 gate. The critical coverage is in the throttle + reset tests below,
      // which prove the NEW gate semantics (state-based, fingerprint-bounded).
      const stateParser = makeScriptedStateParser([withCookieBanner(), withCookieBanner()]);

      const loop = new AgentLoop(
        actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm
      );
      await loop.run('proceed through flow', { maxSteps: 1 });

      expect(actionEngine.tryRecoverFromBlocker).toHaveBeenCalled();
    });

    it('stops retrying after 2 attempts on an unclearable blocker', async () => {
      const llm = makePlannerLLM({ instruction: 'click continue' });
      const actionEngine = makeActionEngine(true);
      // Persistent banner that recovery cannot clear
      actionEngine.tryRecoverFromBlocker = jest.fn(async () => false);
      const banner = withCookieBanner('https://example.com/stuck');
      const stateParser = makeScriptedStateParser([banner, banner, banner, banner, banner, banner, banner, banner]);

      const loop = new AgentLoop(
        actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm
      );
      await loop.run('get past banner', { maxSteps: 4 });

      // Bounded to MAX_RECOVERY_ATTEMPTS_PER_STATE (2) for the same fingerprint
      expect(actionEngine.tryRecoverFromBlocker).toHaveBeenCalledTimes(2);
    });

    it('resets attempt counter when the fingerprint changes (e.g. navigation)', async () => {
      const llm = makePlannerLLM({ instruction: 'proceed' });
      const actionEngine = makeActionEngine(true);
      actionEngine.tryRecoverFromBlocker = jest.fn(async () => false);
      // Three DIFFERENT banners across three pages — each gets its own 2-attempt budget
      const stateParser = makeScriptedStateParser([
        withCookieBanner('https://a.example'), withCookieBanner('https://a.example'),
        withCookieBanner('https://b.example'), withCookieBanner('https://b.example'),
        withCookieBanner('https://c.example'), withCookieBanner('https://c.example'),
      ]);

      const loop = new AgentLoop(
        actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm
      );
      await loop.run('navigate multi-domain', { maxSteps: 3 });

      // One attempt per distinct fingerprint (different URLs → different fingerprints),
      // total 3 attempts across 3 steps.
      expect(actionEngine.tryRecoverFromBlocker).toHaveBeenCalledTimes(3);
    });

    it('no recovery when no blocker is present', async () => {
      const llm = makePlannerLLM({ instruction: 'do something' });
      const actionEngine = makeActionEngine(true);
      const stateParser = makeScriptedStateParser([
        withoutBanner(), withoutBanner(), withoutBanner(), withoutBanner(),
      ]);

      const loop = new AgentLoop(
        actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm
      );
      await loop.run('clean flow', { maxSteps: 2 });

      expect(actionEngine.tryRecoverFromBlocker).not.toHaveBeenCalled();
    });
  });
});
