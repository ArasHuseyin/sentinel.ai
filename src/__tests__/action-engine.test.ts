import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ActionEngine, filterRelevantElements } from '../api/act.js';
import type { SimplifiedState, UIElement } from '../core/state-parser.js';
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

/**
 * Creates a state parser that returns `state` for the first three calls and a
 * slightly modified state (different URL) on all subsequent calls.  This is
 * necessary for tests that exercise the semantic fallback path: act.ts now
 * compares the state before and after the fallback action and returns
 * `success: false` when nothing changed.  The mock must therefore report a
 * different state on the post-fallback parse (the 4th call).
 */
function makeSemanticFallbackStateParser(state: SimplifiedState) {
  const changedState: SimplifiedState = { ...state, url: state.url + '/result' };
  return {
    parse: jest.fn<() => Promise<SimplifiedState>>()
      .mockResolvedValueOnce(state)          // call 1: initial parse
      .mockResolvedValueOnce(state)          // call 2: auto-recovery parse
      .mockResolvedValueOnce(state)          // call 3: state before fallback
      .mockResolvedValue(changedState),      // call 4+: state after fallback (changed)
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
    setInputFiles: jest.fn(async () => {}),
    dragTo: jest.fn(async () => {}),
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
    evaluate: jest.fn(async (_fn: any, args?: any) => {
      // Scroll offset query has no second argument; return {x:0,y:0} so
      // the viewport-relative coordinate calculation does not throw.
      if (args === undefined) return { x: 0, y: 0 };
      // validateTarget / generateSelector both pass {x, y} args — return null
      // (falsy = element valid / no selector found).
      return null;
    }),
    waitForNavigation: jest.fn(async () => {}),
    waitForTimeout: jest.fn(async () => {}),
    locator: jest.fn(() => locatorInstance),
    getByRole: jest.fn(() => locatorInstance),
    getByText: jest.fn(() => locatorInstance),
    getByLabel: jest.fn(() => locatorInstance),
    _locatorInstance: locatorInstance,
  };
}

function makeMockLLM(decision: {
  elementId: number;
  action: string;
  value?: string;
  targetElementId?: number;
  reasoning: string;
}): LLMProvider {
  // Convert old single-elementId format to new candidates format
  const normalized = {
    candidates: [{ elementId: decision.elementId, confidence: 1.0 }],
    action: decision.action,
    value: decision.value,
    targetElementId: decision.targetElementId,
    reasoning: decision.reasoning,
  };
  return {
    generateStructuredData: jest.fn(async () => normalized) as any,
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

  it('falls through to semantic fallback when coordinate click fails', async () => {
    // Element is outside the viewport so the coordinate-based primary path throws,
    // then the semantic (Playwright locator) fallback succeeds.
    const page = makeMockPage({ width: 200, height: 200 });
    const outOfViewportState = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } },
      ],
    });
    const stateParser = makeSemanticFallbackStateParser(outOfViewportState);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    // isVisible returns false so findBestLocator falls back to strategies[0], but locator.click itself succeeds
    const locatorInstance = (page.getByRole as jest.Mock)() as ReturnType<typeof makeMockLocator>;
    (locatorInstance.isVisible as jest.Mock<() => Promise<boolean>>).mockResolvedValue(false);

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click the submit button');

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

  it('fill uses page.mouse.click to focus and keyboard.type to enter value', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 1, action: 'fill', value: 'hello', reasoning: 'Fill email' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Fill hello into email field');

    // fill uses coordinate-based: mouse.click to focus, Control+a to select all, keyboard.type to enter value
    expect(page.mouse.click).toHaveBeenCalled();
    expect(page.keyboard.press as jest.Mock).toHaveBeenCalledWith('Control+a');
    expect(page.keyboard.type as jest.Mock).toHaveBeenCalledWith('hello', { delay: 90 });
  });

  it('append uses page.mouse.click to focus, keyboard.press(End) to move cursor, and keyboard.type to append', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 1, action: 'append', value: ' extra text', reasoning: 'Append to email field' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Append extra text to the email field');

    // append uses coordinate-based: mouse.click to focus, then keyboard.press End, Control+End, then keyboard.type
    expect(page.mouse.click).toHaveBeenCalled();
    const pressCalls = (page.keyboard.press as jest.Mock).mock.calls as any[][];
    expect(pressCalls.some((args: any[]) => args[0] === 'End')).toBe(true);
    expect(pressCalls.some((args: any[]) => args[0] === 'Control+End')).toBe(true);
    expect(page.keyboard.type as jest.Mock).toHaveBeenCalledWith(' extra text', { delay: 90 });
  });

  // ─── performAction: remaining action types ──────────────────────────────────

  it('double-click calls page.mouse.dblclick', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'double-click', reasoning: 'Double click submit' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Double click the submit button');

    expect(result.success).toBe(true);
    expect(page.mouse.dblclick).toHaveBeenCalled();
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
    expect(page.mouse.move).toHaveBeenCalled();
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

  it('select skips the opening click when a listbox popover is already visible', async () => {
    // When the planner already clicked the combobox in a prior step to inspect
    // options, the popover is open on entry to `select`. Clicking the trigger
    // coords again would TOGGLE the popover closed and destroy the options. The
    // fix detects the visible [role="option"] and skips the opening click.
    const page = makeMockPage();
    const openPopoverEvaluate = jest.fn(async (fn: any, args?: any) => {
      if (args === undefined) {
        // Match the isListboxPopoverVisible helper by function source signature.
        const src = String(fn);
        if (src.includes('[role="option"]')) return true;
        return { x: 0, y: 0 };
      }
      return null;
    });
    page.evaluate = openPopoverEvaluate as any;

    const state = makeState({
      elements: [
        { id: 2, role: 'combobox', name: 'Country', boundingClientRect: { x: 10, y: 60, width: 200, height: 30 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 2, action: 'select', value: 'Germany', reasoning: 'Select country' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Select Germany from country dropdown');

    // Popover was already open → opening click must be skipped. Any remaining
    // mouse.click calls come from other paths (none should fire here).
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  it('select calls page.mouse.click then page.evaluate to set value', async () => {
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
    // select uses mouse.click to open, then page.evaluate to set the option value
    expect(page.mouse.click).toHaveBeenCalled();
    const evaluateCalls = (page.evaluate as jest.Mock).mock.calls as any[][];
    // At least one evaluate call passes { x, y, val } args for the select logic
    const selectCall = evaluateCalls.find(args => args[1]?.val === 'Germany');
    expect(selectCall).toBeDefined();
  });

  it('scroll-down with target calls page.evaluate to scrollBy on element', async () => {
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
    // scroll-down with target uses page.evaluate to call el.scrollBy(0, 300)
    const evaluateCalls = (page.evaluate as jest.Mock).mock.calls as any[][];
    const scrollCall = evaluateCalls.find(args => args[1] && typeof args[1].x === 'number' && typeof args[1].y === 'number' && args[1].x >= 10);
    expect(scrollCall).toBeDefined();
  });

  it('scroll-up with target calls page.evaluate to scrollBy on element', async () => {
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
    // scroll-up with target uses page.evaluate to call el.scrollBy(0, -300)
    const evaluateCalls = (page.evaluate as jest.Mock).mock.calls as any[][];
    const scrollCall = evaluateCalls.find(args => args[1] && typeof args[1].x === 'number' && typeof args[1].y === 'number' && args[1].x >= 10);
    expect(scrollCall).toBeDefined();
  });

  it('scroll-to calls page.evaluate to scrollIntoView', async () => {
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
    // scroll-to uses page.evaluate to call el.scrollIntoView()
    const evaluateCalls = (page.evaluate as jest.Mock).mock.calls as any[][];
    const scrollToCall = evaluateCalls.find(args => args[1] && typeof args[1].x === 'number' && typeof args[1].y === 'number');
    expect(scrollToCall).toBeDefined();
  });

  it('click on radio element uses page.evaluate (not mouse.click)', async () => {
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
    // radio/checkbox path uses page.evaluate (elementFromPoint + hiddenInput.click / label.click), NOT mouse.click
    expect((page.mouse.click as jest.Mock).mock.calls).toHaveLength(0);
    const evaluateCalls = (page.evaluate as jest.Mock).mock.calls as any[][];
    const radioEvalCall = evaluateCalls.find(args => args[1] && typeof args[1].x === 'number' && typeof args[1].y === 'number');
    expect(radioEvalCall).toBeDefined();
  });

  // ─── Semantic fallback: remaining action types ───────────────────────────────

  it('double-click semantic fallback calls locator.dblclick', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const emptyParser = makeSemanticFallbackStateParser(makeState({ elements: [] }));
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
      evaluate: jest.fn(async (_fn: any, args?: any) => args === undefined ? { x: 0, y: 0 } : null),
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
    const emptyParser = makeSemanticFallbackStateParser(makeState({ elements: [] }));
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-up', reasoning: 'Scroll page up' });

    const engine = new ActionEngine(page as any, emptyParser as any, llm);
    const result = await engine.act('Scroll up');

    expect(result.success).toBe(true);
    const wheelCalls = (page.mouse.wheel as jest.Mock).mock.calls as any[][];
    expect(wheelCalls.some(args => args[1] < 0)).toBe(true);
  });

  it('fill semantic fallback calls locator.fill', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 1, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 500, width: 200, height: 30 } }],
    });
    const stateParser = makeSemanticFallbackStateParser(state);
    const llm = makeMockLLM({ elementId: 1, action: 'fill', value: 'test@example.com', reasoning: 'Fill email' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Fill in email field');

    expect(result.success).toBe(true);
    const locator = (page.getByRole as jest.Mock).mock.results[0]?.value as ReturnType<typeof makeMockLocator>;
    expect(locator.fill).toHaveBeenCalledWith('test@example.com', expect.anything());
  });

  it('append semantic fallback calls locator.focus + press + pressSequentially', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 1, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 500, width: 200, height: 30 } }],
    });
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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
    const stateParser = makeSemanticFallbackStateParser(state);
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

  // ─── LLM-driven notFound scroll retry ──────────────────────────────────────────

  it('scrolls one viewport and re-asks the LLM when first call returns notFound: true', async () => {
    const page = makeMockPage();
    const noMatchState = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Unrelated', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
      ],
    });
    const matchState = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Unrelated', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
        { id: 1, role: 'link', name: 'John Chat', boundingClientRect: { x: 10, y: 60, width: 200, height: 30 } },
      ],
    });
    const stateParser = {
      parse: jest.fn<() => Promise<SimplifiedState>>()
        .mockResolvedValueOnce(noMatchState)
        .mockResolvedValue(matchState),
      invalidateCache: jest.fn(),
    };
    const llm: LLMProvider = {
      generateStructuredData: jest.fn<() => Promise<any>>()
        .mockResolvedValueOnce({ candidates: [], action: 'click', reasoning: 'not visible', notFound: true })
        .mockResolvedValueOnce({ candidates: [{ elementId: 1, confidence: 1 }], action: 'click', reasoning: 'found it' }) as any,
      generateText: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click on John Chat');

    expect(result.success).toBe(true);
    // Exactly one scroll event on the retry path.
    expect((page.mouse.wheel as jest.Mock).mock.calls).toHaveLength(1);
    // LLM asked twice: initial + one retry.
    expect((llm.generateStructuredData as jest.Mock).mock.calls).toHaveLength(2);
    // stateParser.parse called at least twice (initial + after scroll).
    expect(stateParser.parse.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('scrolls at most once even if the LLM persistently returns notFound: true', async () => {
    const page = makeMockPage();
    const irrelevantState = makeState({
      elements: [
        { id: 0, role: 'link', name: 'Sidebar Nav', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
      ],
    });
    const stateParser = {
      parse: jest.fn(async () => irrelevantState),
      invalidateCache: jest.fn(),
    };
    const llm: LLMProvider = {
      generateStructuredData: jest.fn(async () => ({
        candidates: [],
        action: 'click',
        reasoning: 'never found',
        notFound: true,
      })) as any,
      generateText: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('navigate profile settings');

    // MAX_NOT_FOUND_SCROLL_RETRIES = 1 → exactly one scroll.
    expect((page.mouse.wheel as jest.Mock).mock.calls).toHaveLength(1);
    // LLM called exactly twice (initial + one retry).
    expect((llm.generateStructuredData as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('does not scroll when the LLM returns a valid candidate without notFound', async () => {
    const page = makeMockPage();
    const relevantState = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Login', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
      ],
    });
    const stateParser = makeMockStateParser(relevantState);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Login button found' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Click the login button');

    // No scroll — LLM found the target on the first ask.
    expect((page.mouse.wheel as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('treats empty candidates without notFound as notFound (scroll retry, then clean failure)', async () => {
    const page = makeMockPage();
    const state = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Unrelated', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
      ],
    });
    const stateParser = {
      parse: jest.fn(async () => state),
      invalidateCache: jest.fn(),
    };
    // LLM persistently returns empty candidates, notFound is never set.
    const llm: LLMProvider = {
      generateStructuredData: jest.fn<() => Promise<any>>().mockResolvedValue({
        candidates: [],
        action: 'click',
        reasoning: 'confused',
      }) as any,
      generateText: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('click something specific');

    // Should NOT silently click element 0 — should trigger one scroll retry, then fail cleanly.
    expect(result.success).toBe(false);
    expect(result.message).toContain('Could not find any candidate element');
    // Exactly one scroll (the retry triggered by the synthesized notFound).
    expect((page.mouse.wheel as jest.Mock).mock.calls).toHaveLength(1);
    // No click should have happened on element 0.
    expect((page.mouse.click as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('parses state only once when the LLM returns a non-scroll action on an empty page', async () => {
    const page = makeMockPage();
    const emptyState = makeState({ elements: [] });
    const stateParser = makeMockStateParser(emptyState);
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-down', reasoning: 'Nothing here' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Click John Chat');

    // Exactly one parse: initial state. No notFound retry triggered.
    expect(stateParser.parse).toHaveBeenCalledTimes(1);
  });

  // ─── Region field in LLM prompt ───────────────────────────────────────────────

  it('includes region field in LLM prompt when elements have regions', async () => {
    const page = makeMockPage();
    const state = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 }, region: 'sidebar' },
        { id: 1, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 60, width: 200, height: 30 }, region: 'main' },
        { id: 2, role: 'link', name: 'Home', boundingClientRect: { x: 10, y: 100, width: 60, height: 20 }, region: 'header' },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Submit found' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Click the submit button');

    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    expect(promptArg).toContain('region');
  });

  // ─── Vision Grounding fallback ────────────────────────────────────────────────

  it('vision grounding: findElement returns bbox → clicks at center', async () => {
    const page = makeMockPage();
    // Make the primary coordinate-based path fail so vision grounding is triggered.
    // All candidates fail → engine falls through to vision grounding.
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
    // Vision-grounded click uses page.mouse.click (second call, after primary failed)
    expect((page.mouse.click as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Chunk-Processing: LLM receives filtered element list ─────────────────────

  it('chunk-processing: LLM prompt only contains top-N relevant elements', async () => {
    const page = makeMockPage();
    const state = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
        { id: 1, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 60, width: 200, height: 30 } },
        { id: 2, role: 'link', name: 'Home', boundingClientRect: { x: 10, y: 100, width: 60, height: 20 } },
        { id: 3, role: 'button', name: 'Cancel', boundingClientRect: { x: 10, y: 140, width: 80, height: 30 } },
        { id: 4, role: 'link', name: 'About', boundingClientRect: { x: 10, y: 180, width: 60, height: 20 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Submit button found' });

    // maxElements = 2, instruction contains "submit" → Submit button should be top-scored
    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 2);
    await engine.act('Click the submit button');

    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    // "Submit" should be in the prompt; less relevant elements may be excluded
    expect(promptArg).toContain('Submit');
    // Form fields + nearby buttons are always kept regardless of maxElements.
    // The prompt should contain Submit (keyword match) and Email (form field, always kept).
    expect(promptArg).toContain('Email');
  });

  it('chunk-processing: no filtering when element count ≤ maxElements', async () => {
    const page = makeMockPage();
    const state = makeState(); // 3 elements
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 10);
    await engine.act('Click submit');

    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    // Compact format: each element is one "id | role | name" line
    const elementLineCount = (promptArg.match(/\d+ \| \w+ \| /g) ?? []).length;
    expect(elementLineCount).toBe(3);
  });

  it('vision grounding: findElement returns null → continues to semantic fallback', async () => {
    const page = makeMockPage();
    // Make the primary coordinate path fail so vision grounding is triggered,
    // then vision grounding finds nothing, so semantic (locator) fallback runs.
    (page.mouse.click as jest.Mock).mockRejectedValueOnce(new Error('primary failed') as never);

    const stateParser = makeSemanticFallbackStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    const mockVisionGrounding = {
      takeScreenshot: jest.fn(async () => Buffer.from('png')),
      findElement: jest.fn(async () => null), // element not found by vision
      describeScreen: jest.fn(async () => ''),
    };

    const engine = new ActionEngine(page as any, stateParser as any, llm, mockVisionGrounding as any);
    const result = await engine.act('Click submit button');

    // Falls through to semantic fallback which succeeds (locator.click is not mocked to fail)
    expect(result.success).toBe(true);
    expect(mockVisionGrounding.findElement).toHaveBeenCalled();
  });

  // ─── Pre-Action Validation ────────────────────────────────────────────────────

  it('pre-action validation skips disabled elements and tries next candidate', async () => {
    const page = makeMockPage();
    // Two elements: id=0 (disabled), id=1 (valid target)
    const state = makeState({
      elements: [
        { id: 0, role: 'button', name: 'Disabled Button', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
        { id: 1, role: 'button', name: 'Active Button', boundingClientRect: { x: 10, y: 60, width: 80, height: 30 } },
      ],
    });
    const stateParser = makeMockStateParser(state);

    // LLM returns both elements as candidates
    const llm: LLMProvider = {
      generateStructuredData: jest.fn(async () => ({
        candidates: [{ elementId: 0, confidence: 0.9 }, { elementId: 1, confidence: 0.7 }],
        action: 'click',
        reasoning: 'Both candidates found',
      })) as any,
      generateText: jest.fn(async () => ''),
    };

    // page.evaluate: return 'element is disabled' for the first candidate's coords (cx=50, cy=35),
    // return null (valid) for everything else (selector generation calls, second candidate),
    // and return {x:0,y:0} for the scroll offset query (called with no second argument).
    let validateCallCount = 0;
    (page.evaluate as jest.Mock).mockImplementation(async (_fn: any, args?: any) => {
      // Scroll offset query has no second argument
      if (args === undefined) return { x: 0, y: 0 };
      // validateTarget passes { x, y } — detect by checking args shape
      if (args && typeof args.x === 'number' && typeof args.y === 'number') {
        validateCallCount++;
        if (validateCallCount === 1) return 'element is disabled'; // first candidate blocked
        return null; // second candidate is valid
      }
      return null; // selector generation
    });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click the active button');

    expect(result.success).toBe(true);
    // The first candidate was skipped; second candidate was clicked via page.mouse.click (coordinate path)
    expect((page.mouse.click as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    expect(result.message).toContain('candidate #2');
  });

  // ─── Smart Error Recovery ─────────────────────────────────────────────────────

  it('auto-recovery does NOT dismiss product links whose names contain "accepted" or "alle"', async () => {
    // Regression guard: prior version's cookie-detection matched `accept` as a
    // substring in product names like "Eczema Association Accepted" (a skincare
    // product description), and the German token "alle " matched "Alle 3 in
    // den Einkaufswagen" (add to cart). That caused the agent to add random
    // products to the cart while thinking it was dismissing a banner.
    const productLink = {
      id: 0,
      role: 'link',
      name: 'Clean Skin Club Clean Towels XL, Eczema Association Accepted, Makeup Remover',
      boundingClientRect: { x: 10, y: 20, width: 400, height: 30 },
    };
    const cartButton = {
      id: 1,
      role: 'button',
      name: 'Alle 3 in den Einkaufswagen',
      boundingClientRect: { x: 10, y: 60, width: 200, height: 30 },
    };
    const productHeading = {
      id: 2,
      role: 'heading',
      name: 'Related products for face care',
      boundingClientRect: { x: 10, y: 0, width: 400, height: 30 },
    };
    const state: SimplifiedState = {
      url: 'https://example.com/product',
      title: 'Product Page',
      elements: [productHeading, productLink, cartButton],
    };

    const page = makeMockPage();
    const stateParser = {
      parse: jest.fn(async () => state),
      invalidateCache: jest.fn(),
    };
    const llm = makeMockLLM({ elementId: 2, action: 'click', reasoning: 'ignored' });
    const engine = new ActionEngine(page as any, stateParser as any, llm);

    const recovered = await engine.tryRecoverFromBlocker(state);

    // No consent context on this page (no "cookie"/"consent"/"gdpr"/etc. in any
    // element name) AND the button names are long product descriptions that
    // don't match the anchored accept-pattern → recovery must bail out cleanly.
    expect(recovered).toBe(false);
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  it('auto-recovery dismisses cookie banner and retries action', async () => {
    const cookieBanner = { id: 0, role: 'heading', name: 'We use cookies to improve your experience', boundingClientRect: { x: 10, y: 10, width: 400, height: 40 } };
    const cookieButton = { id: 1, role: 'button', name: 'Accept all', boundingClientRect: { x: 10, y: 20, width: 100, height: 30 } };
    const targetButton = { id: 2, role: 'button', name: 'Sign in', boundingClientRect: { x: 10, y: 200, width: 80, height: 30 } };

    // Initial state: cookie banner heading (consent context), accept button, and the actual target.
    // The heading provides the consent-context signal that tryRecoverFromBlocker now requires —
    // prevents false-positive dismissals of e.g. "Accept Terms" buttons on unrelated pages.
    const initialState: SimplifiedState = {
      url: 'https://example.com',
      title: 'Example',
      elements: [cookieBanner, cookieButton, targetButton],
    };
    // State after recovery: only the target remains
    const cleanState: SimplifiedState = {
      url: 'https://example.com',
      title: 'Example',
      elements: [targetButton],
    };

    const stateParser = {
      parse: jest.fn<() => Promise<SimplifiedState>>()
        .mockResolvedValueOnce(initialState)   // initial parse
        .mockResolvedValueOnce(initialState)   // recovery state parse
        .mockResolvedValueOnce(cleanState),    // fresh state after recovery
      invalidateCache: jest.fn(),
    };

    // LLM targets the Sign In button (id=2)
    const llm: LLMProvider = {
      generateStructuredData: jest.fn(async () => ({
        candidates: [{ elementId: 2, confidence: 0.9 }],
        action: 'click',
        reasoning: 'Sign in button',
      })) as any,
      generateText: jest.fn(async () => ''),
    };

    const page2 = makeMockPage();
    // Make the primary coordinate click fail once (Sign In blocked by overlay),
    // then succeed for the cookie banner recovery click and the retry click.
    let mouseClickCount = 0;
    (page2.mouse.click as jest.Mock).mockImplementation(async () => {
      mouseClickCount++;
      if (mouseClickCount === 1) throw new Error('element blocked by overlay');
      // cookie banner click (call 2) and retry Sign In click (call 3) succeed
    });
    // page.evaluate: null for validateTarget and selector generation calls,
    // {x:0,y:0} for the scroll offset query (no second argument).
    (page2.evaluate as jest.Mock).mockImplementation(async (_fn: any, args?: any) =>
      args === undefined ? { x: 0, y: 0 } : null
    );

    const engine = new ActionEngine(page2 as any, stateParser as any, llm);
    const result = await engine.act('Click sign in');

    expect(result.success).toBe(true);
    expect(result.message).toContain('auto-recovery');
  });

  // ─── Slider fill: range, sibling-input, and keyboard strategies ───────────

  it('fills a native range slider via in-page evaluate', async () => {
    const page = makeMockPage();
    // Slider evaluate returns 'range' → native input[type=range] was set
    (page.evaluate as jest.Mock).mockImplementation(async (...args: any[]) => {
      if (args.length >= 2 && args[1] && typeof args[1] === 'object' && 'val' in (args[1] as any)) {
        return 'range';
      }
      return { x: 0, y: 0 };
    });

    const state = makeState({
      elements: [
        { id: 0, role: 'slider', name: 'Mindestpreis', boundingClientRect: { x: 200, y: 640, width: 20, height: 20 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'fill', value: '100', reasoning: 'Set min price' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Set minimum price to 100');

    expect(result.success).toBe(true);
    expect(result.action).toContain('fill');
    // Verify evaluate was called with the value
    const evalCalls = (page.evaluate as jest.Mock).mock.calls;
    const sliderCall = evalCalls.find(c => c[1] && typeof c[1] === 'object' && 'val' in (c[1] as any));
    expect(sliderCall).toBeDefined();
    expect((sliderCall![1] as any).val).toBe('100');
  });

  it('falls back to sibling text-input when no native range input exists', async () => {
    const page = makeMockPage();
    // Slider evaluate returns 'sibling' → sibling text input was filled
    (page.evaluate as jest.Mock).mockImplementation(async (...args: any[]) => {
      if (args.length >= 2 && args[1] && typeof args[1] === 'object' && 'val' in (args[1] as any)) {
        return 'sibling';
      }
      return { x: 0, y: 0 };
    });

    const state = makeState({
      elements: [
        { id: 0, role: 'slider', name: 'Mindestpreis', boundingClientRect: { x: 200, y: 640, width: 20, height: 20 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'fill', value: '100', reasoning: 'Set min price' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Set minimum price to 100');

    expect(result.success).toBe(true);
    // Keyboard fallback must NOT run when the sibling-input strategy succeeded
    expect((page.keyboard.press as jest.Mock).mock.calls.filter((c: any) => c[0] === 'ArrowRight' || c[0] === 'ArrowLeft')).toHaveLength(0);
  });

  it('uses keyboard simulation for ARIA-only sliders', async () => {
    const page = makeMockPage();
    // After slider-fill evaluate signals 'keyboard', the next evaluate with {x,y}
    // is the aria-slider-info call which must return min/max/now
    let sliderFillTriggered = false;
    (page.evaluate as jest.Mock).mockImplementation(async (...args: any[]) => {
      const arg = args[1];
      if (arg && typeof arg === 'object' && 'val' in arg) {
        sliderFillTriggered = true;
        return 'keyboard';
      }
      if (sliderFillTriggered && arg && typeof arg === 'object' && 'x' in arg && !('val' in arg)) {
        sliderFillTriggered = false;
        return { min: 0, max: 500, now: 0 };
      }
      return { x: 0, y: 0 };
    });

    const state = makeState({
      elements: [
        { id: 0, role: 'slider', name: 'Volume', boundingClientRect: { x: 200, y: 640, width: 20, height: 20 } },
      ],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'fill', value: '5', reasoning: 'Set volume' });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Set volume to 5');

    expect(result.success).toBe(true);
    // Arrow keys should have been pressed to move from now=0 → target=5
    const arrowPresses = (page.keyboard.press as jest.Mock).mock.calls.filter((c: any) => c[0] === 'ArrowRight');
    expect(arrowPresses.length).toBe(5);
  });
});

// ─── Structured Logging / verbose levels ─────────────────────────────────────

describe('ActionEngine verbose logging', () => {
  let consoleSpy: ReturnType<typeof jest.spyOn>;
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('verbose 0: no console output on success', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Submit found' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 0);
    await engine.act('Click submit');

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('verbose 1: logs action summary without reasoning', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Submit found' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 1);
    await engine.act('Click submit');

    const allOutput = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(allOutput).toContain('[Act] click on "Submit"');
    expect(allOutput).not.toContain('Submit found'); // no reasoning at level 1
  });

  it('verbose 2: logs action summary + reasoning', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Submit found' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 2);
    await engine.act('Click submit');

    const allOutput = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(allOutput).toContain('[Act] click on "Submit"');
    expect(allOutput).toContain('Submit found');
  });

  it('verbose 2: logs fallback warning on primary failure', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    // Make the primary locator fail so the fallback warning is logged
    const locatorInstance = (page.getByRole as jest.Mock)() as ReturnType<typeof makeMockLocator>;
    (locatorInstance.click as jest.Mock).mockRejectedValue(new Error('locator failed') as never);
    (locatorInstance.isVisible as jest.Mock<() => Promise<boolean>>).mockResolvedValue(false);

    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 2);
    await engine.act('Click submit');

    const warnOutput = warnSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(warnOutput).toContain('All candidates failed');
  });

  it('verbose 0: no fallback warning even on failure', async () => {
    const page = makeMockPage({ width: 200, height: 200 });
    const state = makeState({
      elements: [{ id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 500, width: 80, height: 30 } }],
    });
    const stateParser = makeMockStateParser(state);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 0);
    await engine.act('Click submit');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('verbose 3: logs chunk-processing stats when filtered', async () => {
    const manyElements = Array.from({ length: 10 }, (_, i) =>
      ({ id: i, role: 'link', name: `Link ${i}`, boundingClientRect: { x: 0, y: i * 20, width: 60, height: 20 } })
    );
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState({ elements: manyElements }));
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 3, 3);
    await engine.act('Click link');

    const allOutput = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(allOutput).toContain('chunk-processing');
    expect(allOutput).toContain('10 →');
  });

  it('verbose 3: logs full decision JSON', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Submit found' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 3);
    await engine.act('Click submit');

    const allOutput = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(allOutput).toContain('[Act] decision:');
    expect(allOutput).toContain('"candidates"');
    expect(allOutput).toContain('"action"');
  });

  it('verbose 3: no chunk-processing log when element count ≤ maxElements', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState()); // 3 elements, maxElements = 50
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 3);
    await engine.act('Click submit');

    const allOutput = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(allOutput).not.toContain('chunk-processing');
  });

  it('verbose 1: cache hit logs ⚡ action label', async () => {
    const { InMemoryLocatorCache } = await import('../core/locator-cache.js');
    const cache = new InMemoryLocatorCache();
    cache.set('https://example.com', 'Click submit', { action: 'click', role: 'button', name: 'Submit' });

    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'OK' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, cache, 50, 1);
    await engine.act('Click submit');

    const allOutput = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(allOutput).toContain('⚡');
    expect(allOutput).toContain('[cached]');
  });

  it('verbose 2: "All paths failed" warn is logged when both primary and fallback fail', async () => {
    const locatorInstance = makeMockLocator();
    (locatorInstance.click as jest.Mock<any>).mockRejectedValue(new Error('fallback failed'));
    locatorInstance.isVisible.mockResolvedValue(false);

    const page = {
      viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
      mouse: { click: jest.fn(async () => { throw new Error('primary failed'); }), dblclick: jest.fn(async () => {}), move: jest.fn(async () => {}), wheel: jest.fn(async () => {}) },
      keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
      evaluate: jest.fn(async (_fn: any, args?: any) => args === undefined ? { x: 0, y: 0 } : null),
      waitForNavigation: jest.fn(async () => {}),
      locator: jest.fn(() => locatorInstance),
      getByRole: jest.fn(() => locatorInstance),
      getByText: jest.fn(() => locatorInstance),
    };
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'Click submit' });

    const engine = new ActionEngine(page as any, stateParser as any, llm, undefined, 3000, null, 50, 2);
    const result = await engine.act('Click submit');

    expect(result.success).toBe(false);
    const warnOutput = warnSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(warnOutput).toContain('All paths failed');
  });
});

// ─── ActionResult.selector ────────────────────────────────────────────────────

describe('ActionResult.selector', () => {
  it('includes selector when page.evaluate returns a CSS selector string', async () => {
    const page = makeMockPage();
    // validateTarget is called first (returns null = valid), then generateSelector returns the selector
    (page.evaluate as any)
      .mockResolvedValueOnce(null)  // validateTarget: element is valid
      .mockResolvedValueOnce('[data-testid="submit"]'); // generateSelector
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'ok' });
    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click submit');
    expect(result.success).toBe(true);
    expect(result.selector).toBe('[data-testid="submit"]');
  });

  it('omits selector when page.evaluate returns null (no stable selector found)', async () => {
    const page = makeMockPage();
    (page.evaluate as any).mockResolvedValueOnce(null);
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'ok' });
    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click submit');
    expect(result.success).toBe(true);
    expect('selector' in result).toBe(false);
  });

  it('omits selector for page-level scroll (no target element)', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-down', reasoning: 'ok' });
    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Scroll down');
    expect(result.success).toBe(true);
    expect('selector' in result).toBe(false);
  });

  it('omits selector when page.evaluate throws', async () => {
    const page = makeMockPage();
    // validateTarget (call 1) must succeed so the action proceeds.
    // generateSelector (call 2) throws — generateSelector catches it and returns null → no selector.
    (page.evaluate as any)
      .mockResolvedValueOnce(null)                           // validateTarget: element valid
      .mockRejectedValueOnce(new Error('context lost'));     // generateSelector: throws → no selector
    const stateParser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'ok' });
    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Click submit');
    expect(result.success).toBe(true);
    expect('selector' in result).toBe(false);
  });
});

// ─── filterRelevantElements unit tests ────────────────────────────────────────

function makeEl(id: number, role: string, name: string): UIElement {
  return { id, role, name, boundingClientRect: { x: 0, y: 0, width: 10, height: 10 } };
}

describe('filterRelevantElements', () => {
  it('returns list unchanged when count ≤ maxCount', () => {
    const els = [makeEl(0, 'button', 'Submit'), makeEl(1, 'textbox', 'Email')];
    const result = filterRelevantElements(els, 'click submit button', 5);
    expect(result).toBe(els); // same reference, no copy
  });

  it('keeps top-N elements by keyword overlap, always preserving form fields and nearby buttons', () => {
    const els = [
      makeEl(0, 'button', 'Submit'),
      makeEl(1, 'textbox', 'Email'),
      makeEl(2, 'link', 'Home'),
    ];
    const result = filterRelevantElements(els, 'fill in the email field', 1);
    // Form fields (textbox) and nearby buttons are always kept
    expect(result.find(e => e.name === 'Email')).toBeDefined();
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('scores by role + name so role matches count', () => {
    const els = [
      makeEl(0, 'button', 'OK'),
      makeEl(1, 'button', 'Cancel'),
      makeEl(2, 'link', 'Home'),
    ];
    // "button" matches both id 0 and id 1 (role = "button"); id 0 and id 1 are tied
    // With maxCount=2, id 2 (link, no match) should be excluded
    const result = filterRelevantElements(els, 'click button', 2);
    expect(result.map(e => e.id).sort()).toEqual([0, 1]);
  });

  it('fills remaining slots with score-0 elements in original order', () => {
    const els = [
      makeEl(0, 'link', 'Home'),
      makeEl(1, 'link', 'About'),
      makeEl(2, 'button', 'Submit'),
    ];
    const result = filterRelevantElements(els, 'click submit', 2);
    // "Submit" should be first (score 1), then one score-0 element
    expect(result[0]!.name).toBe('Submit');
    expect(result).toHaveLength(2);
  });

  it('returns first maxCount when instruction produces no tokens', () => {
    const els = [makeEl(0, 'button', 'A'), makeEl(1, 'link', 'B'), makeEl(2, 'link', 'C')];
    const result = filterRelevantElements(els, '!@#', 2);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(0);
    expect(result[1]!.id).toBe(1);
  });

  it('duplicate tokens in instruction do not inflate score', () => {
    const els = [
      makeEl(0, 'button', 'Login'),
      makeEl(1, 'button', 'Logout'),
    ];
    // "login login login" — after dedup → tokens = ["login"]
    // Both "Login" and "Logout" partially match "log"; "Login" should win due to full "login" match
    const result = filterRelevantElements(els, 'login login login', 1);
    expect(result[0]!.name).toBe('Login');
  });

  it('stable sort: elements with equal score preserve original order', () => {
    const els = [
      makeEl(0, 'link', 'Page 1'),
      makeEl(1, 'link', 'Page 2'),
      makeEl(2, 'link', 'Page 3'),
      makeEl(3, 'button', 'Submit'),
    ];
    // All links have score 0 for "click submit"; Submit has score 1
    // After filter to 3: Submit first, then links 0 and 1 in original order
    const result = filterRelevantElements(els, 'click submit button', 3);
    expect(result[0]!.name).toBe('Submit');
    const linkIds = result.slice(1).map(e => e.id);
    expect(linkIds).toEqual([0, 1]); // original order preserved
  });

  it('token matching is case-insensitive', () => {
    const els = [
      makeEl(0, 'button', 'LOGIN'),
      makeEl(1, 'link', 'Home'),
      makeEl(2, 'link', 'About'),
    ];
    const result = filterRelevantElements(els, 'Click the login button', 1);
    expect(result[0]!.name).toBe('LOGIN');
  });

  it('tokens shorter than 2 chars are ignored', () => {
    const els = [
      makeEl(0, 'button', 'A'),
      makeEl(1, 'link', 'Go'),
    ];
    // Single-char tokens are stripped; "a" and "b" have no effect
    const result = filterRelevantElements(els, 'a b', 1);
    expect(result).toHaveLength(1);
    // Both score 0 → first element returned
    expect(result[0]!.id).toBe(0);
  });
});

// ─── upload & drag action dispatch ──────────────────────────────────────────

describe('ActionEngine — upload action', () => {
  function stateWithFileInput(): SimplifiedState {
    return {
      url: 'https://example.com',
      title: 'Upload',
      elements: [
        { id: 0, role: 'file', name: 'CV', boundingClientRect: { x: 10, y: 10, width: 200, height: 30 } },
      ],
    };
  }

  it('dispatches setInputFiles for upload with a single path', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(stateWithFileInput());
    const llm = makeMockLLM({
      elementId: 0, action: 'upload', value: '/tmp/cv.pdf', reasoning: 'upload CV',
    });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Upload my CV');

    expect(result.success).toBe(true);
    expect((page as any)._locatorInstance.setInputFiles).toHaveBeenCalledWith(
      ['/tmp/cv.pdf'],
      expect.any(Object),
    );
  });

  it('splits comma-separated paths for multi-file upload', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(stateWithFileInput());
    const llm = makeMockLLM({
      elementId: 0, action: 'upload', value: '/a.pdf, /b.pdf ,/c.pdf',
      reasoning: 'upload multiple',
    });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    await engine.act('Upload three PDFs');

    expect((page as any)._locatorInstance.setInputFiles).toHaveBeenCalledWith(
      ['/a.pdf', '/b.pdf', '/c.pdf'],
      expect.any(Object),
    );
  });

  it('returns failure when upload has no value', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(stateWithFileInput());
    const llm = makeMockLLM({
      elementId: 0, action: 'upload', reasoning: 'upload without path',
    });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Upload');

    expect(result.success).toBe(false);
  });
});

describe('ActionEngine — drag action', () => {
  function stateWithDragSourceAndTarget(): SimplifiedState {
    return {
      url: 'https://example.com/kanban',
      title: 'Kanban',
      elements: [
        { id: 0, role: 'listitem', name: 'Card A', boundingClientRect: { x: 10, y: 50, width: 200, height: 60 } },
        { id: 1, role: 'list', name: 'Done', boundingClientRect: { x: 500, y: 50, width: 300, height: 400 } },
      ],
    };
  }

  it('dispatches dragTo between source and drop target', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(stateWithDragSourceAndTarget());
    const llm = makeMockLLM({
      elementId: 0, action: 'drag', targetElementId: 1,
      reasoning: 'move Card A to Done',
    });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Drag Card A to the Done column');

    expect(result.success).toBe(true);
    expect((page as any)._locatorInstance.dragTo).toHaveBeenCalled();
  });

  it('returns failure when drag has no targetElementId', async () => {
    const page = makeMockPage();
    const stateParser = makeMockStateParser(stateWithDragSourceAndTarget());
    const llm = makeMockLLM({
      elementId: 0, action: 'drag', reasoning: 'drag without target',
    });

    const engine = new ActionEngine(page as any, stateParser as any, llm);
    const result = await engine.act('Drag Card A');

    expect(result.success).toBe(false);
  });
});
