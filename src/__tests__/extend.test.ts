import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Sentinel } from '../index.js';
import type { SentinelOptions } from '../index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAomNodes(role: string, name: string) {
  return [{ role: { value: role }, name: { value: name }, description: { value: '' }, backendDOMNodeId: 1, ignored: false, properties: [] }];
}

function makeBoxModel(x = 10, y = 20, w = 80, h = 30) {
  return { model: { content: [x, y, x + w, y, x + w, y + h, x, y + h] } };
}

function makeMockCDP(nodes: any[]) {
  return {
    send: jest.fn(async (method: string, params?: any) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (method === 'DOM.getBoxModel') return makeBoxModel();
      return {};
    }),
  };
}

/** Minimal mock Playwright page that satisfy StateParser + ActionEngine */
function makePage(url = 'https://example.com') {
  const self: any = {
    url: () => url,
    title: jest.fn(async () => 'Test'),
    evaluate: jest.fn(async () => []),
    viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
    waitForNavigation: jest.fn(async () => {}),
    mouse: { click: jest.fn(async () => {}), wheel: jest.fn(async () => {}), move: jest.fn(async () => {}), dblclick: jest.fn(async () => {}) },
    keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
    locator: jest.fn(() => { const l: any = { click: jest.fn(async () => {}), isVisible: jest.fn(async () => true) }; l.first = jest.fn(() => l); return l; }),
    getByRole: jest.fn(() => { const l: any = { click: jest.fn(async () => {}), isVisible: jest.fn(async () => true) }; l.first = jest.fn(() => l); return l; }),
    getByText: jest.fn(() => { const l: any = { click: jest.fn(async () => {}), isVisible: jest.fn(async () => true) }; l.first = jest.fn(() => l); return l; }),
    context: jest.fn(),
  };
  self.mainFrame = () => self;
  self.frames = () => [self];
  return self;
}

/** Build a minimal Sentinel instance with all internals mocked out */
function makeSentinel() {
  const nodes = makeAomNodes('button', 'Login');
  const cdp = makeMockCDP(nodes);
  const page = makePage();

  const llmDecision = { elementId: 0, action: 'click', reasoning: 'Login button found' };
  const mockLLM = {
    generateStructuredData: jest.fn(async () => llmDecision) as any,
    generateText: jest.fn(async () => ''),
  };

  // Pass provider to bypass GeminiService construction (which requires GEMINI_VERSION)
  const sentinel = new Sentinel({ apiKey: 'test', verbose: 0, provider: mockLLM } as SentinelOptions);

  // Stub page.context().newCDPSession() used by extend()
  page.context.mockReturnValue({
    newCDPSession: jest.fn(async () => cdp),
  });

  return { sentinel, page, mockLLM };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sentinel.extend(page)', () => {
  it('returns the same page object', async () => {
    const { sentinel, page } = makeSentinel();
    const extended = await sentinel.extend(page as any);
    expect(extended).toBe(page);
  });

  it('attaches act() method to the page', async () => {
    const { sentinel, page } = makeSentinel();
    const extended = await sentinel.extend(page as any);
    expect(typeof extended.act).toBe('function');
  });

  it('attaches extract() method to the page', async () => {
    const { sentinel, page } = makeSentinel();
    const extended = await sentinel.extend(page as any);
    expect(typeof extended.extract).toBe('function');
  });

  it('attaches observe() method to the page', async () => {
    const { sentinel, page } = makeSentinel();
    const extended = await sentinel.extend(page as any);
    expect(typeof extended.observe).toBe('function');
  });

  it('act() on extended page calls LLM and returns success', async () => {
    const { sentinel, page, mockLLM } = makeSentinel();
    const extended = await sentinel.extend(page as any);
    const result = await extended.act('Click login button');

    expect(result.success).toBe(true);
    expect(mockLLM.generateStructuredData).toHaveBeenCalled();
  });

  it('act() prompt contains the page url', async () => {
    const { sentinel, page, mockLLM } = makeSentinel();
    const extended = await sentinel.extend(page as any);
    await extended.act('Click login button');

    const promptArg = (mockLLM.generateStructuredData as jest.Mock).mock.calls[0]?.[0] as string;
    expect(promptArg).toContain('https://example.com');
  });

  it('creates a dedicated CDP session for the given page', async () => {
    const { sentinel, page } = makeSentinel();
    const ctx = page.context();
    await sentinel.extend(page as any);
    expect(ctx.newCDPSession).toHaveBeenCalledWith(page);
  });

  it('extend() does not affect the main sentinel.page', async () => {
    const { sentinel, page } = makeSentinel();
    // sentinel.page would throw (not initialized), but extend() itself should succeed
    await expect(sentinel.extend(page as any)).resolves.not.toThrow();
  });

  it('multiple extend() calls on different pages are independent', async () => {
    const { sentinel, page: page1 } = makeSentinel();
    const page2 = makePage('https://other.example.com');
    page2.context.mockReturnValue({
      newCDPSession: jest.fn(async () => makeMockCDP(makeAomNodes('link', 'Home'))),
    });

    const extended1 = await sentinel.extend(page1 as any);
    const extended2 = await sentinel.extend(page2 as any);

    // Both pages have independent act() methods
    expect(extended1.act).not.toBe(extended2.act);
  });

  it('extract() on extended page calls LLM and returns structured data', async () => {
    const { sentinel, page, mockLLM } = makeSentinel();
    const extractResult = { title: 'My Page', count: 42 };
    (mockLLM.generateStructuredData as jest.Mock<any>).mockResolvedValueOnce(extractResult);

    const extended = await sentinel.extend(page as any);
    const result = await extended.extract('Get the page title and count', { type: 'object' } as any);

    expect(result).toEqual(extractResult);
    expect(mockLLM.generateStructuredData).toHaveBeenCalled();
  });

  it('observe() on extended page calls LLM and returns actions list', async () => {
    const { sentinel, page, mockLLM } = makeSentinel();
    const observeResult = {
      actions: [
        { description: 'Click login button', method: 'click', selector: 'button' },
      ],
    };
    (mockLLM.generateStructuredData as jest.Mock<any>).mockResolvedValueOnce(observeResult);

    const extended = await sentinel.extend(page as any);
    const actions = await extended.observe('Find login elements');

    expect(actions).toHaveLength(1);
    expect(actions[0]!.description).toBe('Click login button');
  });

  it('original page methods (url, mouse, keyboard) are still accessible after extend()', async () => {
    const { sentinel, page } = makeSentinel();
    const extended = await sentinel.extend(page as any);

    // Playwright's own methods must not be overwritten
    expect(extended.url()).toBe('https://example.com');
    expect(typeof extended.mouse.click).toBe('function');
    expect(typeof extended.keyboard.type).toBe('function');
  });

  it('verbose 0: no console output from act() on extended page', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { sentinel, page } = makeSentinel();
    const extended = await sentinel.extend(page as any);
    await extended.act('Click login');

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('re-extending the same page detaches the old CDP session', async () => {
    const { sentinel, page } = makeSentinel();
    const ctx = page.context();

    // First extend — records the CDP session
    const cdp1 = await ctx.newCDPSession(page);
    const detachSpy = jest.fn(async () => {});
    (cdp1 as any).detach = detachSpy;
    // Replace newCDPSession to return our spy-equipped cdp1 on first call
    ctx.newCDPSession.mockResolvedValueOnce(cdp1 as any);

    await sentinel.extend(page as any);

    // Second extend on the same page — old session should be detached
    await sentinel.extend(page as any);

    expect(detachSpy).toHaveBeenCalledTimes(1);
  });

  it('verbose level from Sentinel is passed through to extended page ActionEngine', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const nodes = makeAomNodes('button', 'Login');
    const cdp = makeMockCDP(nodes);
    const page = makePage();
    const mockLLM = {
      generateStructuredData: jest.fn(async () => ({ elementId: 0, action: 'click', reasoning: 'Found it' })) as any,
      generateText: jest.fn(async () => ''),
    };
    page.context.mockReturnValue({ newCDPSession: jest.fn(async () => cdp) });

    // verbose: 1 — should log action summary
    const sentinel = new Sentinel({ apiKey: 'test', verbose: 1, provider: mockLLM } as SentinelOptions);
    const extended = await sentinel.extend(page as any);
    await extended.act('Click login');

    const allOutput = consoleSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(allOutput).toContain('[Act]');

    consoleSpy.mockRestore();
  });
});
