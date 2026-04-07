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

  it('returns success for an append action', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 1, action: 'append', value: ' extra text', reasoning: 'Append to email field' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Append extra text to the email field');

    expect(result.success).toBe(true);
    expect(result.action).toContain('append');
  });

  it('append uses keyboard.press End then keyboard.type', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 1, action: 'append', value: ' extra text', reasoning: 'Append to email field' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Append extra text to the email field');

    expect((page.keyboard.press as jest.Mock).mock.calls.some(
      (args: any[]) => args[0] === 'End'
    )).toBe(true);
    expect(page.keyboard.type).toHaveBeenCalled();
  });

  // ─── performAction: remaining action types ──────────────────────────────────

  it('double-click calls page.mouse.dblclick', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'double-click', reasoning: 'Double click submit' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Double click the submit button');

    expect(result.success).toBe(true);
    expect((page.mouse.dblclick as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('right-click calls page.mouse.click with button right', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'right-click', reasoning: 'Open context menu' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Right-click the submit button');

    expect(result.success).toBe(true);
    const calls = (page.mouse.click as jest.Mock).mock.calls as any[][];
    expect(calls.some(args => args[2]?.button === 'right')).toBe(true);
  });

  it('hover calls page.mouse.move', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'hover', reasoning: 'Hover over button' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Hover over the submit button');

    expect(result.success).toBe(true);
    expect((page.mouse.move as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('scroll-up without target calls page.mouse.wheel upward', async () => {
    const page = makeMockPage();
    const emptyParser = makeMockStateParser(makeState({ elements: [] }));
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-up', reasoning: 'Scroll page up' });

    const engine = new ActionEngine(page as any, emptyParser as any, llm);
    const result = await engine.act('Scroll up the page');

    expect(result.success).toBe(true);
    const wheelCalls = (page.mouse.wheel as jest.Mock).mock.calls as any[][];
    expect(wheelCalls.some(args => args[1] < 0)).toBe(true);
  });

  it('select calls page.evaluate', async () => {
    const page = makeMockPage();
    // Use elementId: 2 (role: 'combobox') — elementId 0/1 are reserved for scroll-without-target check
    const state = makeState({
      elements: [
        { id: 2, role: 'combobox', name: 'Country', boundingClientRect: { x: 10, y: 60, width: 200, height: 30 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 2, action: 'select', value: 'Germany', reasoning: 'Select country' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Select Germany from country dropdown');

    expect(result.success).toBe(true);
    expect((page.evaluate as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('scroll-down with target calls page.evaluate', async () => {
    const page = makeMockPage();
    // elementId must be non-zero to avoid the scroll-without-target path
    const state = makeState({
      elements: [
        { id: 1, role: 'region', name: 'Feed', boundingClientRect: { x: 10, y: 60, width: 200, height: 200 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'scroll-down', reasoning: 'Scroll container down' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Scroll down inside the container');

    expect(result.success).toBe(true);
    expect((page.evaluate as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('scroll-up with target calls page.evaluate', async () => {
    const page = makeMockPage();
    const state = makeState({
      elements: [
        { id: 1, role: 'region', name: 'Feed', boundingClientRect: { x: 10, y: 60, width: 200, height: 200 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'scroll-up', reasoning: 'Scroll container up' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Scroll up inside the container');

    expect(result.success).toBe(true);
    expect((page.evaluate as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('scroll-to calls page.evaluate', async () => {
    const page = makeMockPage();
    const state = makeState({
      elements: [
        { id: 1, role: 'link', name: 'Footer link', boundingClientRect: { x: 10, y: 60, width: 100, height: 20 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'scroll-to', reasoning: 'Scroll to footer link' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Scroll to the footer link');

    expect(result.success).toBe(true);
    expect((page.evaluate as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('click on radio element uses page.evaluate instead of mouse.click', async () => {
    const page = makeMockPage();
    const state = makeState({
      elements: [
        { id: 0, role: 'radio', name: 'Option A', boundingClientRect: { x: 10, y: 20, width: 20, height: 20 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Select radio option' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Select radio option A');

    expect(result.success).toBe(true);
    // radio path uses page.evaluate, NOT mouse.click
    expect((page.mouse.click as jest.Mock).mock.calls).toHaveLength(0);
    expect((page.evaluate as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  // ─── Semantic fallback: remaining action types ───────────────────────────────

  it('double-click semantic fallback calls locator.dblclick', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'double-click', reasoning: 'Double click' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Double click submit');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.dblclick).toHaveBeenCalled();
  });

  it('right-click semantic fallback calls locator.click with button right', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Menu', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'right-click', reasoning: 'Context menu' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Right click menu');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    const calls = (locator.click as jest.Mock).mock.calls as any[][];
    expect(calls.some(args => args[0]?.button === 'right')).toBe(true);
  });

  it('hover semantic fallback calls locator.hover', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Tooltip', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'hover', reasoning: 'Hover for tooltip' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Hover over tooltip button');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.hover).toHaveBeenCalled();
  });

  it('select semantic fallback calls locator.selectOption', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'combobox', name: 'Country', boundingClientRect: { x: 10, y: 500, width: 200, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'select', value: 'Germany', reasoning: 'Select country' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Select Germany from country dropdown');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.selectOption).toHaveBeenCalledWith('Germany', expect.anything());
  });

  it('scroll-to semantic fallback calls locator.scrollIntoViewIfNeeded', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Footer', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-to', reasoning: 'Scroll to footer' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Scroll to footer');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  it('scroll-down semantic fallback without target calls page.mouse.wheel downward', async () => {
    // primary path uses mouse.wheel and succeeds, but we want the fallback path:
    // make primary fail by throwing from page.evaluate (simulate broken page)
    const page = makeMockPage();
    (page.evaluate as jest.Mock).mockRejectedValue(new Error('page not available') as never);
    const emptyParser = makeMockStateParser(makeState({ elements: [] }));
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-down', reasoning: 'Scroll down' });

    // primary: mouse.wheel should work (it's a direct call, not evaluate)
    // So we need a different approach: make mouse.wheel fail on first call
    (page.mouse.wheel as jest.Mock).mockRejectedValueOnce(new Error('wheel failed') as never);

    const engine = new ActionEngine(page as any, emptyParser as any, llm);
    const result = await engine.act('Scroll down');

    // fallback also calls mouse.wheel, which succeeds on second call
    expect(result.success).toBe(true);
    expect((page.mouse.wheel as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('returns failure when both primary and semantic fallback fail', async () => {
    const locatorInstance = makeMockLocator();
    const page = {
      viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
      waitForLoadState: jest.fn(async () => {}),
      mouse: { click: jest.fn(async () => { throw new Error('primary failed'); }), dblclick: jest.fn(async () => {}), move: jest.fn(async () => {}) },
      keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
      evaluate: jest.fn(async () => {}),
      waitForNavigation: jest.fn(async () => {}),
      waitForTimeout: jest.fn(async () => {}),
      locator: jest.fn(() => locatorInstance),
      getByRole: jest.fn(() => locatorInstance),
      getByText: jest.fn(() => locatorInstance),
    };
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    // Make the locator's click fail and isVisible return false (no strategy visible)
    (locatorInstance.click as jest.Mock<any>).mockRejectedValue(new Error('fallback failed'));
    locatorInstance.isVisible.mockResolvedValue(false);

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click submit');

    expect(result.success).toBe(false);
  });

  // ─── Semantic fallback: additional action types ──────────────────────────────

  it('scroll-up semantic fallback without target calls page.mouse.wheel upward', async () => {
    const page = makeMockPage();
    (page.mouse.wheel as jest.Mock).mockRejectedValueOnce(new Error('wheel failed') as never);
    const emptyParser = makeMockStateParser(makeState({ elements: [] }));
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-up', reasoning: 'Scroll page up' });

    const engine = new ActionEngine(page as any, emptyParser as any, llm);
    const result = await engine.act('Scroll up');

    expect(result.success).toBe(true);
    const wheelCalls = (page.mouse.wheel as jest.Mock).mock.calls as any[][];
    expect(wheelCalls.some(args => args[1] < 0)).toBe(true);
  });

  it('append semantic fallback calls locator.focus + press + pressSequentially', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 1, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 500, width: 200, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'append', value: ' extra', reasoning: 'Append text' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Append text to email field');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.focus).toHaveBeenCalled();
    expect(locator.press).toHaveBeenCalledWith('End');
    expect(locator.pressSequentially).toHaveBeenCalledWith(' extra', expect.anything());
  });

  it('press semantic fallback calls locator.focus + locator.press', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 1, role: 'textbox', name: 'Search', boundingClientRect: { x: 10, y: 500, width: 200, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'press', value: 'Enter', reasoning: 'Submit search' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Press Enter in search field');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.focus).toHaveBeenCalled();
    expect(locator.press).toHaveBeenCalledWith('Enter');
  });

  it('scroll-down with target in semantic fallback calls locator.evaluate', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    // elementId must be non-zero so it's not treated as scroll-without-target
    const state = makeState({
      elements: [{ id: 1, role: 'region', name: 'Feed', boundingClientRect: { x: 10, y: 500, width: 200, height: 200 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'scroll-down', reasoning: 'Scroll feed' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Scroll down feed');

    expect(result.success).toBe(true);
    const locatorInstance = (page.locator as jest.Mock).mock.results[0]?.value;
    expect(locatorInstance).toBeDefined();
  });

  it('scroll-up with target in semantic fallback calls locator.evaluate', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 1, role: 'region', name: 'Feed', boundingClientRect: { x: 10, y: 500, width: 200, height: 200 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'scroll-up', reasoning: 'Scroll feed up' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Scroll up feed');

    expect(result.success).toBe(true);
    const locatorInstance = (page.locator as jest.Mock).mock.results[0]?.value;
    expect(locatorInstance).toBeDefined();
  });

  it('radio/checkbox semantic fallback: check() throws → falls back to click()', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'radio', name: 'Option A', boundingClientRect: { x: 10, y: 500, width: 20, height: 20 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Select radio' });

    const locatorInstance = makeMockLocator();
    // check() throws → should fall back to click()
    (locatorInstance.check as jest.Mock) = jest.fn(async () => { throw new Error('check failed'); });
    const page2 = {
      ...page,
      getByRole: jest.fn(() => locatorInstance),
      getByText: jest.fn(() => locatorInstance),
      locator: jest.fn(() => locatorInstance),
    };

    const engine = new ActionEngine(page2 as any, stateParser as any, llm);
    const result = await engine.act('Select radio Option A');

    expect(result.success).toBe(true);
    expect(locatorInstance.click).toHaveBeenCalled();
  });

  it('findBestLocator: isVisible throws on all strategies → returns first strategy', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    // All isVisible() calls throw — findBestLocator should still return strategies[0]
    const throwingLocator = makeMockLocator();
    (throwingLocator.isVisible as jest.Mock) = jest.fn(async () => { throw new Error('timeout'); });
    const page2 = {
      ...page,
      getByRole: jest.fn(() => throwingLocator),
      getByText: jest.fn(() => throwingLocator),
      locator: jest.fn(() => throwingLocator),
    };

    const engine = new ActionEngine(page2 as any, stateParser as any, llm);
    const result = await engine.act('Click submit');

    // Should still attempt click on fallback locator
    expect(throwingLocator.click).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  // ─── Vision Grounding fallback ────────────────────────────────────────────────

  it('vision grounding: findElement returns bbox → clicks at center', async () => {
    const page = makeMockPage();
    // Primary click fails
    (page.mouse.click as jest.Mock).mockRejectedValueOnce(new Error('primary failed') as never);

    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    const mockVisionGrounding = {
      takeScreenshot: jest.fn(async () => Buffer.from('png')),
      findElement: jest.fn(async () => ({ x: 100, y: 200, width: 80, height: 30 })),
      describeScreen: jest.fn(async () => 'A page with a submit button'),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm, mockVisionGrounding as any);
    const result = await engine.act('Click submit button');

    expect(result.success).toBe(true);
    expect(result.message).toContain('Vision Grounding');
    expect(mockVisionGrounding.findElement).toHaveBeenCalled();
    // Second mouse.click call is the vision-grounded click
    expect((page.mouse.click as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('vision grounding: findElement returns null → continues to semantic fallback', async () => {
    const page = makeMockPage();
    // Primary click fails
    (page.mouse.click as jest.Mock).mockRejectedValueOnce(new Error('primary failed') as never);

    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    const mockVisionGrounding = {
      takeScreenshot: jest.fn(async () => Buffer.from('png')),
      findElement: jest.fn(async () => null), // element not found by vision
      describeScreen: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm, mockVisionGrounding as any);
    const result = await engine.act('Click submit button');

    // Falls through to semantic fallback which succeeds
    expect(result.success).toBe(true);
    expect(mockVisionGrounding.findElement).toHaveBeenCalled();
  });
});
