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

function makeActionEngine(success = true, message = 'done') {
  return {
    act: jest.fn(async () => ({ success, message, action: 'click something' })),
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
  describe('instruction-loop detection', () => {
    it('aborts after the same instruction repeats 3 times in a row', async () => {
      const llm = makePlannerLLM({ instruction: 'click the button' });
      const actionEngine = makeActionEngine(true);
      const stateParser = makeStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('achieve test goal', { maxSteps: 15 });

      // Loop detection fires after step 3 → agent stops before maxSteps
      expect(result.totalSteps).toBe(3);
      expect(result.goalAchieved).toBe(false);
      expect(actionEngine.act).toHaveBeenCalledTimes(3);
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
      const stateParser = makeStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('achieve test goal', { maxSteps: 4 });

      // Should NOT have been stopped by loop detection (different instructions)
      // It stops because maxSteps is reached
      expect(result.totalSteps).toBe(4);
      expect(actionEngine.act).toHaveBeenCalledTimes(4);
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
      const stateParser = makeStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('do something', { maxSteps: 6 });

      // Should reach maxSteps without aborting due to consecutive failures
      expect(result.totalSteps).toBe(6);
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
      const stateParser = makeStateParser();
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
      const stateParser = makeStateParser();

      const loop = new AgentLoop(actionEngine as any, makeExtractionEngine() as any, stateParser as any, llm);
      const result = await loop.run('test goal', { maxSteps: 15 });

      // Loop detection fires after 3 steps
      expect(result.history).toHaveLength(3);
      expect(result.history[0]).toMatchObject({ stepNumber: 1, instruction: 'click button' });
    });
  });
});
