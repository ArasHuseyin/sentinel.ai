import { jest, describe, it, expect } from '@jest/globals';
import { ActionEngine } from '../api/act.js';
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
      { id: 2, role: 'link', name: 'Home', boundingClientRect: { x: 10, y: 100, width: 60, height: 20 } },
    ],
    ...overrides,
  };
}

function makeMockStateParser(state: SimplifiedState) {
  return {
    parse: jest.fn(async () => state),
    invalidateCache: jest.fn(),
  };
}

function makeMockLocator() {
  const locator: any = {
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
    first: jest.fn(() => locator),
  };
  return locator;
}

function makeMockPage(viewportOverride?: { width: number; height: number }) {
  const locatorInstance = makeMockLocator();
  return {
    url: () => 'https://example.com',
    viewportSize: jest.fn(() => viewportOverride ?? { width: 1280, height: 720 }),
    waitForLoadState: jest.fn(async () => {}),
    mouse: {
      click: jest.fn(async () => {}),
      dblclick: jest.fn(async () => {}),
      move: jest.fn(async () => {}),
    },
    keyboard: {
      press: jest.fn(async () => {}),
      type: jest.fn(async () => {}),
    },
    evaluate: jest.fn(async () => {}),
    waitForTimeout: jest.fn(async () => {}),
    locator: jest.fn(() => locatorInstance),
    getByRole: jest.fn(() => locatorInstance),
    getByText: jest.fn(() => locatorInstance),
  };
}

function makeMockLLM(decision: {
  elementId: number;
  action: string;
  value?: string;
  reasoning: string;
}): LLMProvider {
  return {
    generateStructuredData: jest.fn(async () => decision) as any,
    generateText: jest.fn(async () => ''),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ActionEngine', () => {
  it('returns success for a click action', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Submit button found' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click the submit button');

    expect(result.success).toBe(true);
    expect(result.action).toContain('click');
  });

  it('returns success for a fill action with value', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 1, action: 'fill', value: 'test@example.com', reasoning: 'Email field' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Fill in the email field with test@example.com');

    expect(result.success).toBe(true);
    expect(result.action).toContain('fill');
  });

  it('interpolates %variable% placeholders', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 1, action: 'fill', value: 'user@test.com', reasoning: 'Email field' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Fill %email% into the email field', { variables: { email: 'user@test.com' } });

    // The prompt passed to LLM should contain the resolved value
    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    expect(promptArg).toContain('user@test.com');
    expect(promptArg).not.toContain('%email%');
  });

  it('returns failure when element id not found', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    // LLM returns an elementId that does not exist in state
    const llm = makeMockLLM({ elementId: 99, action: 'click', reasoning: 'Non-existent element' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click something that does not exist');

    expect(result.success).toBe(false);
  });

  it('handles scroll-down without target element (elementId 0)', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-down', reasoning: 'Scroll page down' });
    // Use a state with NO element id=0 so isScrollWithoutTarget logic triggers correctly
    const emptyState = makeState({ elements: [] });
    const emptyParser = makeMockStateParser(emptyState);

    const engine = new ActionEngine(page as any, emptyParser as any, llm);
    const result = await engine.act('Scroll down the page');

    expect(result.success).toBe(true);
    expect(result.action).toContain('scroll-down');
  });

  it('handles press action with keyboard shortcut', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'press', value: 'Enter', reasoning: 'Press Enter' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Press Enter');

    expect(result.success).toBe(true);
    expect(result.action).toContain('press');
  });

  it('calls stateParser.parse() to get current state', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Click submit');

    expect(stateParser.parse).toHaveBeenCalled();
  });

  it('includes page url and title in LLM prompt', async () => {
    const page = makeMockPage();
    const state = makeState({ url: 'https://shop.example.com', title: 'My Shop' });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Click submit');

    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    expect(promptArg).toContain('https://shop.example.com');
    expect(promptArg).toContain('My Shop');
  });

  it('falls through to semantic fallback when element is outside viewport', async () => {
    // Viewport is 200×200 but the element sits at y=500 → out of bounds
    const page = makeMockPage({ width: 200, height: 200 });
    const outOfViewportState = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } },
      ],
    });
    const stateParser = makeMockStateParser(outOfViewportState);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click the submit button');

    // Primary action (mouse.click) must NOT have been called
    expect((page.mouse.click as jest.Mock).mock.calls).toHaveLength(0);
    // Semantic fallback locator click must have been called instead
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.click).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain('via fallback');
  });

  it('returns failure when both primary and semantic fallback fail', async () => {
    const locatorInstance = makeMockLocator();
    const page = {
      viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
      waitForLoadState: jest.fn(async () => {}),
      mouse: { click: jest.fn(async () => { throw new Error('primary failed'); }), dblclick: jest.fn(async () => {}), move: jest.fn(async () => {}) },
      keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
      evaluate: jest.fn(async () => {}),
      waitForTimeout: jest.fn(async () => {}),
      locator: jest.fn(() => locatorInstance),
      getByRole: jest.fn(() => locatorInstance),
      getByText: jest.fn(() => locatorInstance),
    };
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    // Make the locator's click fail and isVisible return false (no strategy visible)
    locatorInstance.click.mockRejectedValue(new Error('fallback failed'));
    locatorInstance.isVisible.mockResolvedValue(false);

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click submit');

    expect(result.success).toBe(false);
  });
});
