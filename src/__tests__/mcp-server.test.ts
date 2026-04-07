import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { registerTools } from '../mcp/server.js';
import type { SessionFactory, CleanupFn } from '../mcp/server.js';
import type { Sentinel } from '../index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSentinel() {
  return {
    goto: jest.fn<any>().mockResolvedValue(undefined),
    act: jest.fn<any>().mockResolvedValue({ success: true, message: 'Clicked button', action: 'click' }),
    extract: jest.fn<any>().mockResolvedValue({ items: ['Widget A', 'Widget B'] }),
    observe: jest.fn<any>().mockResolvedValue([{ id: 0, role: 'button', name: 'Login', description: '' }]),
    run: jest.fn<any>().mockResolvedValue({
      goalAchieved: true,
      success: true,
      totalSteps: 2,
      message: 'Goal achieved',
      history: [],
      data: { result: 42 },
    }),
    screenshot: jest.fn<any>().mockResolvedValue(Buffer.from('PNG_DATA')),
    getTokenUsage: jest.fn<any>().mockReturnValue({
      totalInputTokens: 200,
      totalOutputTokens: 100,
      totalTokens: 300,
      estimatedCostUsd: 0.00005,
    }),
  };
}

type ToolHandler = (args: any) => Promise<any>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    tool: jest.fn((name: string, ...rest: any[]) => {
      // last argument is always the handler callback
      tools.set(name, rest[rest.length - 1] as ToolHandler);
    }),
    connect: jest.fn(async () => {}),
    getHandler: (name: string) => {
      const h = tools.get(name);
      if (!h) throw new Error(`Tool "${name}" not registered`);
      return h;
    },
    registeredNames: () => [...tools.keys()],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP Server: registerTools', () => {
  let mock: ReturnType<typeof makeMockSentinel>;
  let server: ReturnType<typeof makeMockServer>;
  let sessionFactory: SessionFactory;
  let cleanupFn: CleanupFn;

  beforeEach(() => {
    mock = makeMockSentinel();
    server = makeMockServer();
    sessionFactory = jest.fn(async () => mock as unknown as Sentinel);
    cleanupFn = jest.fn(async () => {});
    registerTools(server as any, sessionFactory, cleanupFn);
  });

  // ── Tool registration ───────────────────────────────────────────────────────

  it('registers all 8 expected tools', () => {
    const expected = [
      'sentinel_goto', 'sentinel_act', 'sentinel_extract', 'sentinel_observe',
      'sentinel_run', 'sentinel_screenshot', 'sentinel_close', 'sentinel_token_usage',
    ];
    for (const name of expected) {
      expect(server.registeredNames()).toContain(name);
    }
  });

  // ── sentinel_goto ───────────────────────────────────────────────────────────

  it('sentinel_goto calls sentinel.goto() with url', async () => {
    const handler = server.getHandler('sentinel_goto');
    const result = await handler({ url: 'https://example.com' });

    expect(mock.goto).toHaveBeenCalledWith('https://example.com');
    expect(result.content[0].text).toContain('https://example.com');
  });

  // ── sentinel_act ────────────────────────────────────────────────────────────

  it('sentinel_act calls sentinel.act() and returns success message', async () => {
    const handler = server.getHandler('sentinel_act');
    const result = await handler({ instruction: 'Click the login button' });

    expect(mock.act).toHaveBeenCalledWith('Click the login button', undefined);
    expect(result.content[0].text).toContain('✅');
  });

  it('sentinel_act passes variables when provided', async () => {
    const handler = server.getHandler('sentinel_act');
    await handler({ instruction: 'Fill %email%', variables: { email: 'user@test.com' } });

    expect(mock.act).toHaveBeenCalledWith('Fill %email%', { variables: { email: 'user@test.com' } });
  });

  it('sentinel_act shows ❌ when action fails', async () => {
    mock.act.mockResolvedValue({ success: false, message: 'Element not found' } as any);
    const handler = server.getHandler('sentinel_act');
    const result = await handler({ instruction: 'Click missing element' });

    expect(result.content[0].text).toContain('❌');
  });

  // ── sentinel_extract ────────────────────────────────────────────────────────

  it('sentinel_extract calls sentinel.extract() and returns JSON', async () => {
    const handler = server.getHandler('sentinel_extract');
    const result = await handler({ instruction: 'Get product list' });

    expect(mock.extract).toHaveBeenCalledWith('Get product list', { type: 'object' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ items: ['Widget A', 'Widget B'] });
  });

  it('sentinel_extract passes schema when provided', async () => {
    const handler = server.getHandler('sentinel_extract');
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    await handler({ instruction: 'Get name', schema });

    expect(mock.extract).toHaveBeenCalledWith('Get name', schema);
  });

  // ── sentinel_observe ────────────────────────────────────────────────────────

  it('sentinel_observe calls sentinel.observe() and returns JSON', async () => {
    const handler = server.getHandler('sentinel_observe');
    const result = await handler({ instruction: 'Find login elements' });

    expect(mock.observe).toHaveBeenCalledWith('Find login elements');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].name).toBe('Login');
  });

  it('sentinel_observe passes undefined when no instruction', async () => {
    const handler = server.getHandler('sentinel_observe');
    await handler({});

    expect(mock.observe).toHaveBeenCalledWith(undefined);
  });

  // ── sentinel_run ────────────────────────────────────────────────────────────

  it('sentinel_run calls sentinel.run() and returns structured result', async () => {
    const handler = server.getHandler('sentinel_run');
    const result = await handler({ goal: 'Search for laptops' });

    expect(mock.run).toHaveBeenCalledWith('Search for laptops', { maxSteps: 15 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.goalAchieved).toBe(true);
    expect(parsed.data).toEqual({ result: 42 });
    expect(parsed.tokens).toBeDefined();
  });

  it('sentinel_run respects maxSteps argument', async () => {
    const handler = server.getHandler('sentinel_run');
    await handler({ goal: 'Do something', maxSteps: 5 });

    expect(mock.run).toHaveBeenCalledWith('Do something', { maxSteps: 5 });
  });

  // ── sentinel_screenshot ─────────────────────────────────────────────────────

  it('sentinel_screenshot returns base64 image content', async () => {
    const handler = server.getHandler('sentinel_screenshot');
    const result = await handler({});

    expect(mock.screenshot).toHaveBeenCalled();
    expect(result.content[0].type).toBe('image');
    expect(result.content[0].data).toBe(Buffer.from('PNG_DATA').toString('base64'));
    expect(result.content[0].mimeType).toBe('image/png');
  });

  // ── sentinel_close ──────────────────────────────────────────────────────────

  it('sentinel_close calls cleanupFn and returns confirmation', async () => {
    const handler = server.getHandler('sentinel_close');
    const result = await handler({});

    expect(cleanupFn).toHaveBeenCalled();
    expect(result.content[0].text).toContain('closed');
  });

  // ── sentinel_token_usage ────────────────────────────────────────────────────

  it('sentinel_token_usage returns JSON with token counts and cost', async () => {
    const handler = server.getHandler('sentinel_token_usage');
    const result = await handler({});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalTokens).toBe(300);
    expect(parsed.estimatedCostUsd).toBeDefined();
  });
});
