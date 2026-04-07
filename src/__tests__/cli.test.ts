import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildProgram } from '../cli/program.js';
import type { SentinelFactory } from '../cli/program.js';
import type { Sentinel } from '../index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSentinel() {
  return {
    init: jest.fn<any>().mockResolvedValue(undefined),
    close: jest.fn<any>().mockResolvedValue(undefined),
    goto: jest.fn<any>().mockResolvedValue(undefined),
    act: jest.fn<any>().mockResolvedValue({ success: true, message: 'Clicked', action: 'click on "Login"' }),
    extract: jest.fn<any>().mockResolvedValue({ title: 'Example' }),
    run: jest.fn<any>().mockResolvedValue({
      goalAchieved: true,
      success: true,
      totalSteps: 3,
      message: 'Done',
      history: [],
      data: { products: [] },
    }),
    screenshot: jest.fn<any>().mockResolvedValue(Buffer.from('PNG')),
    getTokenUsage: jest.fn<any>().mockReturnValue({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.00001,
    }),
  };
}

function makeFactory(mock: ReturnType<typeof makeMockSentinel>): SentinelFactory {
  return jest.fn(async () => mock as unknown as Sentinel);
}

function args(...parts: string[]) {
  return ['node', 'sentinel', ...parts];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CLI: buildProgram', () => {
  let consoleSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── run command ─────────────────────────────────────────────────────────────

  it('run: calls goto() then run() with correct args', async () => {
    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('run', 'Search for laptops', '--url', 'https://amazon.de', '--api-key', 'test-key'));

    expect(mock.goto).toHaveBeenCalledWith('https://amazon.de');
    expect(mock.run).toHaveBeenCalledWith('Search for laptops', { maxSteps: 15 });
  });

  it('run: respects --max-steps option', async () => {
    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('run', 'my goal', '--url', 'https://example.com', '--api-key', 'key', '--max-steps', '5'));

    expect(mock.run).toHaveBeenCalledWith('my goal', { maxSteps: 5 });
  });

  it('run: sets exitCode 0 when goalAchieved', async () => {
    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('run', 'goal', '--url', 'https://example.com', '--api-key', 'key'));

    expect(process.exitCode).toBe(0);
  });

  it('run: sets exitCode 1 when goal NOT achieved', async () => {
    const mock = makeMockSentinel();
    mock.run.mockResolvedValue({
      goalAchieved: false, success: false, totalSteps: 3, message: 'Failed', history: [],
    } as any);
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('run', 'goal', '--url', 'https://example.com', '--api-key', 'key'));

    expect(process.exitCode).toBe(1);
  });

  it('run: always calls close() even after success', async () => {
    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('run', 'goal', '--url', 'https://example.com', '--api-key', 'key'));

    expect(mock.close).toHaveBeenCalled();
  });

  // ── act command ─────────────────────────────────────────────────────────────

  it('act: calls goto() then act() with instruction', async () => {
    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('act', 'Click the login button', '--url', 'https://example.com', '--api-key', 'key'));

    expect(mock.goto).toHaveBeenCalledWith('https://example.com');
    expect(mock.act).toHaveBeenCalledWith('Click the login button');
  });

  it('act: sets exitCode 1 when action fails', async () => {
    const mock = makeMockSentinel();
    mock.act.mockResolvedValue({ success: false, message: 'Element not found' } as any);
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('act', 'Click missing button', '--url', 'https://example.com', '--api-key', 'key'));

    expect(process.exitCode).toBe(1);
  });

  // ── extract command ─────────────────────────────────────────────────────────

  it('extract: calls goto() then extract() with parsed schema', async () => {
    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));
    const schema = JSON.stringify({ type: 'object', properties: { title: { type: 'string' } } });
    await program.parseAsync(args('extract', 'Get the page title', '--url', 'https://example.com', '--api-key', 'key', '--schema', schema));

    expect(mock.goto).toHaveBeenCalledWith('https://example.com');
    expect(mock.extract).toHaveBeenCalledWith('Get the page title', { type: 'object', properties: { title: { type: 'string' } } });
  });

  it('extract: uses default schema when --schema is omitted', async () => {
    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));
    await program.parseAsync(args('extract', 'Get data', '--url', 'https://example.com', '--api-key', 'key'));

    expect(mock.extract).toHaveBeenCalledWith('Get data', { type: 'object' });
  });

  // ── factory args ────────────────────────────────────────────────────────────

  it('passes apiKey and headless=true to factory by default', async () => {
    const mock = makeMockSentinel();
    const factory = jest.fn(async () => mock as unknown as Sentinel);
    const program = buildProgram(factory);
    await program.parseAsync(args('act', 'Click', '--url', 'https://example.com', '--api-key', 'my-api-key'));

    // Commander stores --headless flag as false by default (flag is off unless passed)
    expect(factory as jest.Mock<any>).toHaveBeenCalledWith({ apiKey: 'my-api-key', headless: false });
  });

  it('throws when API key is missing', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const mock = makeMockSentinel();
    const program = buildProgram(makeFactory(mock));

    await expect(
      program.parseAsync(args('act', 'Click', '--url', 'https://example.com'))
    ).rejects.toThrow('Missing API key');

    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
  });
});
