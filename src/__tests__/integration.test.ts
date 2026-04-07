import { jest, describe, it, expect } from '@jest/globals';
import { ActionEngine } from '../api/act.js';
import { ExtractionEngine } from '../api/extract.js';
import { AgentLoop } from '../agent/agent-loop.js';
import { Verifier } from '../reliability/verifier.js';
import type { SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<SimplifiedState> = {}): SimplifiedState {
  return {
    url: 'https://example.com',
    title: 'Example',
    elements: [
      { id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
      { id: 1, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 60, width: 200, height: 30 } },
    ],
    ...overrides,
  };
}

function makeMockStateParser(states: SimplifiedState | SimplifiedState[]) {
  const stateArray = Array.isArray(states) ? states : [states];
  let callIndex = 0;
  return {
    parse: jest.fn(async () => {
      const state = stateArray[Math.min(callIndex, stateArray.length - 1)]!;
      callIndex++;
      return state;
    }),
    invalidateCache: jest.fn(),
  };
}

function makeMockPage() {
  const locatorInstance: any = {
    click: jest.fn(async () => {}),
    dblclick: jest.fn(async () => {}),
    hover: jest.fn(async () => {}),
    fill: jest.fn(async () => {}),
    focus: jest.fn(async () => {}),
    press: jest.fn(async () => {}),
    pressSequentially: jest.fn(async () => {}),
    selectOption: jest.fn(async () => []),
    scrollIntoViewIfNeeded: jest.fn(async () => {}),
    evaluate: jest.fn(async () => {}),
    boundingBox: jest.fn(async () => ({ x: 10, y: 20, width: 80, height: 30 })),
    isVisible: jest.fn(async () => true),
    first: jest.fn(() => locatorInstance),
  };
  return {
    url: () => 'https://example.com',
    viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
    waitForLoadState: jest.fn(async () => {}),
    mouse: {
      click: jest.fn(async () => {}),
      dblclick: jest.fn(async () => {}),
      move: jest.fn(async () => {}),
      wheel: jest.fn(async () => {}),
    },
    keyboard: {
      press: jest.fn(async () => {}),
      type: jest.fn(async () => {}),
    },
    evaluate: jest.fn(async () => {}),
    waitForNavigation: jest.fn(async () => {}),
    waitForTimeout: jest.fn(async () => {}),
    locator: jest.fn(() => locatorInstance),
    getByRole: jest.fn(() => locatorInstance),
    getByText: jest.fn(() => locatorInstance),
  };
}

// ─── Integration: ActionEngine + Verifier ─────────────────────────────────────

describe('Integration: ActionEngine + Verifier', () => {
  it('act() succeeds when verifier confirms state change', async () => {
    const stateBefore = makeState();
    const stateAfter = makeState({
      url: 'https://example.com/success',
      title: 'Success',
    });
    const stateParser = makeMockStateParser([stateBefore, stateAfter]);
    const page = makeMockPage();

    const actionLLM: LLMProvider = {
      generateStructuredData: jest.fn(async () => ({
        elementId: 0,
        action: 'click',
        reasoning: 'Submit button found',
      })) as any,
      generateText: jest.fn(async () => ''),
    };

    const verifierLLM: LLMProvider = {
      generateStructuredData: jest.fn(async () => ({
        success: true,
        confidence: 0.9,
        explanation: 'Form submitted successfully',
      })) as any,
      generateText: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, actionLLM);
    const verifier = new Verifier(page as any, stateParser as any, verifierLLM);

    const actResult = await engine.act('Click the submit button');
    expect(actResult.success).toBe(true);

    const beforeState = stateBefore;
    const afterState = await stateParser.parse();
    const verification = await verifier.verifyAction('Click the submit button', beforeState, afterState);

    expect(verification.success).toBe(true);
    expect(verification.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('act() retries when verifier reports low confidence', async () => {
    const stateBefore = makeState();
    const stateUnchanged = makeState();
    const stateChanged = makeState({
      title: 'Updated Page',
      elements: [
        { id: 0, role: 'button', name: 'Done', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
      ],
    });

    const page = makeMockPage();

    const actionLLM: LLMProvider = {
      generateStructuredData: jest.fn(async () => ({
        elementId: 0,
        action: 'click',
        reasoning: 'Submit button',
      })) as any,
      generateText: jest.fn(async () => ''),
    };

    const verifierLLM: LLMProvider = {
      generateStructuredData: jest.fn<() => Promise<any>>()
        .mockResolvedValueOnce({ success: false, confidence: 0.3, explanation: 'Nothing changed' })
        .mockResolvedValueOnce({ success: true, confidence: 0.85, explanation: 'State changed' }),
      generateText: jest.fn(async () => ''),
    };

    const verifier = new Verifier(page as any, {} as any, verifierLLM);

    // First attempt: verifier says low confidence
    const stateParser1 = makeMockStateParser(stateBefore);
    const engine1 = new ActionEngine(page as any, stateParser1 as any, actionLLM);
    await engine1.act('Click submit');

    const result1 = await verifier.verifyAction('Click submit', stateBefore, stateUnchanged);
    expect(result1.success).toBe(false);
    expect(result1.confidence).toBeLessThan(0.7);

    // Second attempt: verifier confirms
    const stateParser2 = makeMockStateParser(stateChanged);
    const engine2 = new ActionEngine(page as any, stateParser2 as any, actionLLM);
    await engine2.act('Click submit');

    const result2 = await verifier.verifyAction('Click submit', stateUnchanged, stateChanged);
    // Title changed → fast path triggers
    expect(result2.success).toBe(true);
    expect(result2.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

// ─── Integration: AgentLoop ───────────────────────────────────────────────────

describe('Integration: AgentLoop', () => {
  it('completes a multi-step goal', async () => {
    const page = makeMockPage();
    const state = makeState();
    const stateParser = makeMockStateParser(state);

    // LLM mock: alternates between planner calls and action engine calls.
    // Pattern per step: planner.planNextStep → actionEngine.act
    // After 3 steps: planner marks goal complete
    const llm: LLMProvider = {
      generateStructuredData: jest.fn<() => Promise<any>>()
        // Step 1: planner
        .mockResolvedValueOnce({ type: 'act', instruction: 'Click search field', reasoning: 'Need to search', isGoalComplete: false })
        // Step 1: action engine
        .mockResolvedValueOnce({ elementId: 1, action: 'click', reasoning: 'Search field found' })
        // Step 2: planner
        .mockResolvedValueOnce({ type: 'act', instruction: 'Type query', reasoning: 'Enter search term', isGoalComplete: false })
        // Step 2: action engine
        .mockResolvedValueOnce({ elementId: 1, action: 'fill', value: 'test', reasoning: 'Fill search' })
        // Step 3: planner
        .mockResolvedValueOnce({ type: 'act', instruction: 'Click submit', reasoning: 'Submit search', isGoalComplete: false })
        // Step 3: action engine
        .mockResolvedValueOnce({ elementId: 0, action: 'click', reasoning: 'Submit button' })
        // Step 4: planner marks goal complete
        .mockResolvedValueOnce({ type: 'act', instruction: 'Done', reasoning: 'Search completed', isGoalComplete: true }),
      generateText: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const agentLoop = new AgentLoop(engine, { extract: jest.fn(async () => ({})) } as any, stateParser as any, llm);
    const result = await agentLoop.run('Search for test', { maxSteps: 10 });

    expect(result.goalAchieved).toBe(true);
    expect(result.history).toHaveLength(4);
    expect(result.success).toBe(true);
  });

  it('aborts after 3 consecutive failures', async () => {
    const page = makeMockPage();
    const state = makeState({ elements: [] });
    const stateParser = makeMockStateParser(state);

    // Planner always returns an instruction; action engine always returns
    // an element ID that doesn't exist (empty elements list → failure)
    const llm: LLMProvider = {
      generateStructuredData: jest.fn<() => Promise<any>>()
        // Step 1: planner
        .mockResolvedValueOnce({ type: 'act', instruction: 'Click login', reasoning: 'Need login', isGoalComplete: false })
        // Step 1: action → element 5 not in empty list
        .mockResolvedValueOnce({ elementId: 5, action: 'click', reasoning: 'Login button' })
        // Step 2: planner
        .mockResolvedValueOnce({ type: 'act', instruction: 'Click sign in', reasoning: 'Try sign in', isGoalComplete: false })
        // Step 2: action → element 5 not in empty list
        .mockResolvedValueOnce({ elementId: 5, action: 'click', reasoning: 'Sign in button' })
        // Step 3: planner
        .mockResolvedValueOnce({ type: 'act', instruction: 'Click enter', reasoning: 'Try enter', isGoalComplete: false })
        // Step 3: action → element 5 not in empty list
        .mockResolvedValueOnce({ elementId: 5, action: 'click', reasoning: 'Enter button' })
        // Reflection after abort
        .mockResolvedValueOnce({ goalAchieved: false, reason: 'Could not find login button' }),
      generateText: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const agentLoop = new AgentLoop(engine, { extract: jest.fn(async () => ({})) } as any, stateParser as any, llm);
    const result = await agentLoop.run('Log in to the site', { maxSteps: 10 });

    expect(result.goalAchieved).toBe(false);
    expect(result.totalSteps).toBe(3);
    expect(result.history.every(h => !h.success)).toBe(true);
  });

  it('detects instruction loop and aborts', async () => {
    const page = makeMockPage();
    const state = makeState();
    const stateParser = makeMockStateParser(state);

    // Planner always returns the same instruction, action engine always succeeds
    const repeatedInstruction = 'Click the submit button';
    const llm: LLMProvider = {
      generateStructuredData: jest.fn<() => Promise<any>>()
        // Step 1
        .mockResolvedValueOnce({ type: 'act', instruction: repeatedInstruction, reasoning: 'Submit form', isGoalComplete: false })
        .mockResolvedValueOnce({ elementId: 0, action: 'click', reasoning: 'Submit button' })
        // Step 2
        .mockResolvedValueOnce({ type: 'act', instruction: repeatedInstruction, reasoning: 'Submit form', isGoalComplete: false })
        .mockResolvedValueOnce({ elementId: 0, action: 'click', reasoning: 'Submit button' })
        // Step 3
        .mockResolvedValueOnce({ type: 'act', instruction: repeatedInstruction, reasoning: 'Submit form', isGoalComplete: false })
        .mockResolvedValueOnce({ elementId: 0, action: 'click', reasoning: 'Submit button' })
        // Reflection after loop detection
        .mockResolvedValueOnce({ goalAchieved: false, reason: 'Stuck in loop' }),
      generateText: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const agentLoop = new AgentLoop(engine, { extract: jest.fn(async () => ({})) } as any, stateParser as any, llm);
    const result = await agentLoop.run('Submit the form', { maxSteps: 10 });

    expect(result.goalAchieved).toBe(false);
    expect(result.totalSteps).toBe(3);
  });
});

// ─── Integration: ExtractionEngine ────────────────────────────────────────────

describe('Integration: ExtractionEngine', () => {
  it('combines AOM state and page text in prompt', async () => {
    const state = makeState({
      elements: [
        { id: 0, role: 'heading', name: 'Products', boundingClientRect: { x: 0, y: 0, width: 200, height: 40 } },
        { id: 1, role: 'link', name: 'Widget A', boundingClientRect: { x: 0, y: 50, width: 100, height: 20 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const pageTextContent = 'Products Widget A $19.99 Widget B $29.99';

    const page = makeMockPage();
    (page.evaluate as jest.Mock<() => Promise<any>>).mockResolvedValue(pageTextContent);

    const extractedData = { products: [{ name: 'Widget A', price: 19.99 }] };
    const llm: LLMProvider = {
      generateStructuredData: jest.fn(async () => extractedData) as any,
      generateText: jest.fn(async () => ''),
    };

    const engine = new ExtractionEngine(page as any, stateParser as any, llm);
    const result = await engine.extract('Extract product names and prices', {
      type: 'object',
      properties: {
        products: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              price: { type: 'number' },
            },
          },
        },
      },
    });

    expect(result).toEqual(extractedData);

    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    expect(promptArg).toContain('Widget A');
    expect(promptArg).toContain('Products');
    expect(promptArg).toContain(pageTextContent);
    expect(promptArg).toContain('INTERACTIVE ELEMENTS (AOM)');
    expect(promptArg).toContain('VISIBLE PAGE TEXT');
  });

  it('handles page text extraction failure gracefully', async () => {
    const state = makeState();
    const stateParser = makeMockStateParser(state);
    const page = makeMockPage();
    (page.evaluate as jest.Mock<() => Promise<any>>).mockRejectedValue(new Error('Page not ready'));

    const llm: LLMProvider = {
      generateStructuredData: jest.fn(async () => ({ title: 'Example' })) as any,
      generateText: jest.fn(async () => ''),
    };

    const engine = new ExtractionEngine(page as any, stateParser as any, llm);
    const result = await engine.extract('Get the page title', {
      type: 'object',
      properties: { title: { type: 'string' } },
    });

    expect(result).toEqual({ title: 'Example' });

    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    expect(promptArg).toContain('[Could not extract page text]');
  });
});
