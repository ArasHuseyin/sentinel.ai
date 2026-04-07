import { jest, describe, it, expect } from '@jest/globals';
import { runAiFixture, test, expect as sentinelExpect } from '../test/index.js';
import type { SentinelConstructor } from '../test/index.js';
import type { SentinelOptions } from '../index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSentinel() {
  const mock: any = {
    init: jest.fn<any>().mockResolvedValue(undefined),
    close: jest.fn<any>().mockResolvedValue(undefined),
    goto: jest.fn<any>().mockResolvedValue(undefined),
    act: jest.fn<any>().mockResolvedValue({ success: true, message: 'Done', action: 'click' }),
    extract: jest.fn<any>().mockResolvedValue({ value: 42 }),
    observe: jest.fn<any>().mockResolvedValue([]),
    run: jest.fn<any>().mockResolvedValue({ goalAchieved: true, success: true, totalSteps: 1, message: 'ok', history: [] }),
    screenshot: jest.fn<any>().mockResolvedValue(Buffer.from('PNG')),
    describeScreen: jest.fn<any>().mockResolvedValue('A page with a form'),
    getTokenUsage: jest.fn<any>().mockReturnValue({ totalTokens: 50, estimatedCostUsd: 0.000005, totalInputTokens: 30, totalOutputTokens: 20 }),
    get page() { return { url: () => 'https://example.com' }; },
  };
  return mock;
}

function makeMockSentinelClass(mock: ReturnType<typeof makeMockSentinel>): SentinelConstructor {
  return jest.fn((_opts: SentinelOptions) => mock) as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Playwright Test Fixture: runAiFixture', () => {

  it('calls sentinel.init() before use() and sentinel.close() after', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);
    const callOrder: string[] = [];

    mock.init.mockImplementation(async () => { callOrder.push('init'); });
    mock.close.mockImplementation(async () => { callOrder.push('close'); });

    await runAiFixture(
      { apiKey: 'test-key' } as any,
      async (_ai) => { callOrder.push('use'); },
      SentinelClass
    );

    expect(callOrder).toEqual(['init', 'use', 'close']);
  });

  it('calls sentinel.close() even when use() throws', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);

    await expect(
      runAiFixture(
        { apiKey: 'test-key' } as any,
        async () => { throw new Error('test error'); },
        SentinelClass
      )
    ).rejects.toThrow('test error');

    expect(mock.close).toHaveBeenCalled();
  });

  it('throws descriptive error when apiKey is missing', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    await expect(
      runAiFixture({}, async () => {})
    ).rejects.toThrow('apiKey is required');

    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
  });

  it('ai.goto() delegates to sentinel.goto()', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);

    await runAiFixture(
      { apiKey: 'test-key' } as any,
      async (ai) => {
        await ai.goto('https://example.com');
        expect(mock.goto).toHaveBeenCalledWith('https://example.com');
      },
      SentinelClass
    );
  });

  it('ai.act() delegates to sentinel.act() and returns result', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);

    await runAiFixture(
      { apiKey: 'test-key' } as any,
      async (ai) => {
        const result = await ai.act('Click the login button');
        expect(mock.act).toHaveBeenCalledWith('Click the login button', undefined);
        expect(result.success).toBe(true);
      },
      SentinelClass
    );
  });

  it('ai.extract() delegates to sentinel.extract() with schema', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);
    const schema = { type: 'object', properties: { value: { type: 'number' } } };

    await runAiFixture(
      { apiKey: 'test-key' } as any,
      async (ai) => {
        const data = await ai.extract('Get the value', schema);
        expect(mock.extract).toHaveBeenCalledWith('Get the value', schema);
        expect(data).toEqual({ value: 42 });
      },
      SentinelClass
    );
  });

  it('ai.run() delegates to sentinel.run()', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);

    await runAiFixture(
      { apiKey: 'test-key' } as any,
      async (ai) => {
        const result = await ai.run('Achieve the goal', { maxSteps: 5 });
        expect(mock.run).toHaveBeenCalledWith('Achieve the goal', { maxSteps: 5 });
        expect(result.goalAchieved).toBe(true);
      },
      SentinelClass
    );
  });

  it('ai.getTokenUsage() returns sentinel token usage', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);

    await runAiFixture(
      { apiKey: 'test-key' } as any,
      async (ai) => {
        const usage = ai.getTokenUsage();
        expect(usage.totalTokens).toBe(50);
      },
      SentinelClass
    );
  });

  it('merges sentinelOptions over defaults (headless: false, verbose: 1)', async () => {
    const mock = makeMockSentinel();
    const SentinelClass = makeMockSentinelClass(mock);

    await runAiFixture(
      { apiKey: 'test-key', headless: false, verbose: 1 } as any,
      async () => {},
      SentinelClass
    );

    const ctorCall = (SentinelClass as jest.Mock).mock.calls[0]![0] as SentinelOptions;
    expect(ctorCall.headless).toBe(false);
    expect(ctorCall.verbose).toBe(1);
    expect(ctorCall.apiKey).toBe('test-key');
  });
});

// ─── Exports ──────────────────────────────────────────────────────────────────

describe('Playwright Test Fixture: exports', () => {
  it('exports test object from playwright/test', () => {
    expect(test).toBeDefined();
    expect(typeof test).toBe('function');
  });

  it('exports expect from playwright/test', () => {
    expect(sentinelExpect).toBeDefined();
    expect(typeof sentinelExpect).toBe('function');
  });
});
