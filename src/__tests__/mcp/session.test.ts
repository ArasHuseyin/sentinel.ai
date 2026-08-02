import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// The session manager constructs a real Sentinel, which would launch Chromium.
// Mock the module so the manager's own logic — the init latch and the execution
// queue — is what these tests exercise.

const initSpy = jest.fn<() => Promise<void>>();
const closeSpy = jest.fn<() => Promise<void>>();
let constructed = 0;

jest.unstable_mockModule('../../index.js', () => ({
  Sentinel: class {
    constructor() {
      constructed++;
    }
    init = initSpy;
    close = closeSpy;
  },
}));

const { createSessionManager } = await import('../../mcp/session.js');

const options = () => ({ apiKey: 'test-key' }) as never;
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(() => resolve(), ms));

beforeEach(() => {
  constructed = 0;
  initSpy.mockReset();
  closeSpy.mockReset();
  initSpy.mockImplementation(async () => {});
  closeSpy.mockImplementation(async () => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createSessionManager – initialisation', () => {
  it('constructs exactly one session for concurrent callers', async () => {
    // The bug: `if (session) return session` followed by `await init()` is not
    // atomic. Two requests arriving before the first init resolved each saw
    // null, each launched a browser, and the loser leaked.
    initSpy.mockImplementation(() => tick(10));
    const mgr = createSessionManager(options);

    const [a, b, c] = await Promise.all([mgr.getOrInit(), mgr.getOrInit(), mgr.getOrInit()]);

    expect(constructed).toBe(1);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns the same session on later calls without re-initialising', async () => {
    const mgr = createSessionManager(options);
    const first = await mgr.getOrInit();
    const second = await mgr.getOrInit();
    expect(second).toBe(first);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after a failed init instead of latching the failure', async () => {
    initSpy.mockImplementationOnce(async () => {
      throw new Error('browser launch failed');
    });
    const mgr = createSessionManager(options);

    await expect(mgr.getOrInit()).rejects.toThrow('browser launch failed');
    // Without clearing the in-flight latch, one transient failure would make
    // the server permanently unusable.
    await expect(mgr.getOrInit()).resolves.toBeDefined();
    expect(initSpy).toHaveBeenCalledTimes(2);
  });

  it('propagates a failure from the options builder', async () => {
    const mgr = createSessionManager(() => {
      throw new Error('GEMINI_API_KEY is not set');
    });
    await expect(mgr.getOrInit()).rejects.toThrow('GEMINI_API_KEY is not set');
  });
});

describe('createSessionManager – cleanup', () => {
  it('closes an open session', async () => {
    const mgr = createSessionManager(options);
    await mgr.getOrInit();
    await mgr.cleanup();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is open', async () => {
    const mgr = createSessionManager(options);
    await mgr.cleanup();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('re-initialises after cleanup', async () => {
    const mgr = createSessionManager(options);
    await mgr.getOrInit();
    await mgr.cleanup();
    await mgr.getOrInit();
    expect(constructed).toBe(2);
  });

  it('does not reject when close() fails', async () => {
    closeSpy.mockImplementation(async () => {
      throw new Error('already gone');
    });
    const mgr = createSessionManager(options);
    await mgr.getOrInit();
    await expect(mgr.cleanup()).resolves.toBeUndefined();
  });
});

describe('createSessionManager – runExclusive', () => {
  it('serialises tasks so they never overlap', async () => {
    // All requests drive one browser: a goto from client B landing between
    // client A's act and extract is the failure this prevents.
    const mgr = createSessionManager(options);
    const events: string[] = [];

    const task = (name: string, ms: number) => async () => {
      events.push(`${name}:start`);
      await tick(ms);
      events.push(`${name}:end`);
      return name;
    };

    const results = await Promise.all([
      mgr.runExclusive(task('a', 20)),
      mgr.runExclusive(task('b', 1)),
      mgr.runExclusive(task('c', 1)),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('runs queued tasks even after one rejects', async () => {
    // The queue is a lock, not a dependency chain — a failing tool call must
    // not wedge every request behind it.
    const mgr = createSessionManager(options);
    const failing = mgr.runExclusive(async () => {
      throw new Error('tool blew up');
    });
    const following = mgr.runExclusive(async () => 'still ran');

    await expect(failing).rejects.toThrow('tool blew up');
    await expect(following).resolves.toBe('still ran');
  });

  it('preserves arrival order under load', async () => {
    const mgr = createSessionManager(options);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mgr.runExclusive(async () => {
          await tick(i % 3);
          order.push(i);
        })
      )
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
