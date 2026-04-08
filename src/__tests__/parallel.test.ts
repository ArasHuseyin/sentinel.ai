import { jest, describe, it, expect } from '@jest/globals';
import { Sentinel } from '../index.js';
import type { ParallelTask, ParallelResult, SentinelOptions } from '../index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a mock Sentinel instance whose goto/run/close can be controlled.
 * `runResult` determines what `sentinel.run()` resolves to.
 */
function makeMockSentinel(runResult: {
  goalAchieved: boolean;
  success: boolean;
  totalSteps: number;
  message: string;
  data?: unknown;
}) {
  return {
    goto: jest.fn(async () => {}),
    run: jest.fn(async () => runResult),
    close: jest.fn(async () => {}),
  };
}

/** Factory that returns a fresh mock sentinel for each task. */
function makeFactory(
  runResults: Array<{
    goalAchieved: boolean;
    success: boolean;
    totalSteps: number;
    message: string;
    data?: unknown;
  }>
) {
  let callIndex = 0;
  const instances: ReturnType<typeof makeMockSentinel>[] = [];

  const factory = jest.fn(async (_opts: SentinelOptions) => {
    const result = runResults[callIndex % runResults.length]!;
    callIndex++;
    const instance = makeMockSentinel(result);
    instances.push(instance);
    return instance as unknown as Sentinel;
  });

  return { factory, instances: () => instances };
}

const sharedOptions: SentinelOptions = { apiKey: 'test', verbose: 0, provider: { generateStructuredData: jest.fn() as any, generateText: jest.fn() as any } };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Sentinel.parallel()', () => {
  it('returns empty array for empty task list', async () => {
    const results = await Sentinel.parallel([], sharedOptions);
    expect(results).toEqual([]);
  });

  it('runs a single task and returns its result', async () => {
    const { factory } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 3, message: 'Done' },
    ]);
    const tasks: ParallelTask[] = [{ url: 'https://example.com', goal: 'Click login' }];

    const results = await Sentinel.parallel(tasks, sharedOptions, factory);

    expect(results).toHaveLength(1);
    expect(results[0]!.goalAchieved).toBe(true);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.totalSteps).toBe(3);
    expect(results[0]!.url).toBe('https://example.com');
    expect(results[0]!.goal).toBe('Click login');
    expect(results[0]!.index).toBe(0);
  });

  it('runs multiple tasks and returns results in input order', async () => {
    const { factory } = makeFactory([
      { goalAchieved: true,  success: true,  totalSteps: 2, message: 'Task A done' },
      { goalAchieved: false, success: false, totalSteps: 5, message: 'Task B failed' },
      { goalAchieved: true,  success: true,  totalSteps: 1, message: 'Task C done' },
    ]);

    const tasks: ParallelTask[] = [
      { url: 'https://a.com', goal: 'Goal A' },
      { url: 'https://b.com', goal: 'Goal B' },
      { url: 'https://c.com', goal: 'Goal C' },
    ];

    const results = await Sentinel.parallel(tasks, { ...sharedOptions, concurrency: 3 }, factory);

    expect(results).toHaveLength(3);
    expect(results[0]!.goal).toBe('Goal A');
    expect(results[1]!.goal).toBe('Goal B');
    expect(results[2]!.goal).toBe('Goal C');
    expect(results[0]!.index).toBe(0);
    expect(results[1]!.index).toBe(1);
    expect(results[2]!.index).toBe(2);
  });

  it('passes the url to sentinel.goto() and goal to sentinel.run()', async () => {
    const { factory, instances } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
    ]);
    const tasks: ParallelTask[] = [{ url: 'https://shop.com', goal: 'Buy laptop', maxSteps: 20 }];

    await Sentinel.parallel(tasks, sharedOptions, factory);

    const inst = instances()[0]!;
    expect(inst.goto as jest.Mock).toHaveBeenCalledWith('https://shop.com');
    expect(inst.run as jest.Mock).toHaveBeenCalledWith('Buy laptop', { maxSteps: 20 });
  });

  it('uses default maxSteps of 15 when not specified', async () => {
    const { factory, instances } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
    ]);

    await Sentinel.parallel([{ url: 'https://x.com', goal: 'Do something' }], sharedOptions, factory);

    expect(instances()[0]!.run as jest.Mock).toHaveBeenCalledWith('Do something', { maxSteps: 15 });
  });

  it('always calls sentinel.close() even on success', async () => {
    const { factory, instances } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
    ]);

    await Sentinel.parallel([{ url: 'https://x.com', goal: 'Go' }], sharedOptions, factory);

    expect(instances()[0]!.close).toHaveBeenCalled();
  });

  it('calls sentinel.close() even when run() throws', async () => {
    const closeSpy = jest.fn(async () => {});
    const factory = jest.fn(async () => ({
      goto: jest.fn(async () => {}),
      run: jest.fn(async () => { throw new Error('Browser crashed'); }),
      close: closeSpy,
    } as unknown as Sentinel));

    const results = await Sentinel.parallel(
      [{ url: 'https://x.com', goal: 'Crash' }],
      sharedOptions,
      factory
    );

    expect(closeSpy).toHaveBeenCalled();
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toBe('Browser crashed');
    expect(results[0]!.goalAchieved).toBe(false);
  });

  it('isolates factory errors — factory() throwing does not affect other tasks', async () => {
    let callIndex = 0;
    const factory = jest.fn(async () => {
      const i = callIndex++;
      if (i === 1) throw new Error('Factory failed');
      return {
        goto: jest.fn(async () => {}),
        run: jest.fn(async () => ({ goalAchieved: true, success: true, totalSteps: 1, message: 'ok' })),
        close: jest.fn(async () => {}),
      } as unknown as Sentinel;
    });

    const tasks: ParallelTask[] = [
      { url: 'https://a.com', goal: 'A' },
      { url: 'https://b.com', goal: 'B' },
      { url: 'https://c.com', goal: 'C' },
    ];

    const results = await Sentinel.parallel(tasks, { ...sharedOptions, concurrency: 3 }, factory);

    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toBe('Factory failed');
    expect(results[2]!.success).toBe(true);
  });

  it('isolates failures — one failing task does not affect others', async () => {
    let callIndex = 0;
    const factory = jest.fn(async () => {
      const i = callIndex++;
      return {
        goto: jest.fn(async () => {}),
        run: jest.fn(async () => {
          if (i === 1) throw new Error('Task 1 crashed');
          return { goalAchieved: true, success: true, totalSteps: 2, message: 'ok' };
        }),
        close: jest.fn(async () => {}),
      } as unknown as Sentinel;
    });

    const tasks: ParallelTask[] = [
      { url: 'https://a.com', goal: 'A' },
      { url: 'https://b.com', goal: 'B' },
      { url: 'https://c.com', goal: 'C' },
    ];

    const results = await Sentinel.parallel(tasks, { ...sharedOptions, concurrency: 3 }, factory);

    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toBe('Task 1 crashed');
    expect(results[2]!.success).toBe(true);
  });

  it('respects concurrency — at most N instances run simultaneously', async () => {
    const activeCount = { current: 0, peak: 0 };

    const factory = jest.fn(async () => ({
      goto: jest.fn(async () => {}),
      run: jest.fn(async () => {
        activeCount.current++;
        activeCount.peak = Math.max(activeCount.peak, activeCount.current);
        // Simulate async work so multiple tasks overlap
        await new Promise(r => setTimeout(r, 10));
        activeCount.current--;
        return { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' };
      }),
      close: jest.fn(async () => {}),
    } as unknown as Sentinel));

    const tasks = Array.from({ length: 6 }, (_, i) => ({
      url: `https://task${i}.com`,
      goal: `Goal ${i}`,
    }));

    await Sentinel.parallel(tasks, { ...sharedOptions, concurrency: 2 }, factory);

    expect(activeCount.peak).toBeLessThanOrEqual(2);
    expect(factory).toHaveBeenCalledTimes(6);
  });

  it('creates one factory instance per task', async () => {
    const { factory } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
    ]);
    const tasks = Array.from({ length: 4 }, (_, i) => ({ url: `https://t${i}.com`, goal: `G${i}` }));

    await Sentinel.parallel(tasks, { ...sharedOptions, concurrency: 4 }, factory);

    expect(factory).toHaveBeenCalledTimes(4);
  });

  it('includes result.data when run() returns data', async () => {
    const data = { products: ['Laptop A', 'Laptop B'] };
    const { factory } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 4, message: 'Extracted', data },
    ]);

    const results = await Sentinel.parallel(
      [{ url: 'https://shop.com', goal: 'Extract products' }],
      sharedOptions,
      factory
    );

    expect(results[0]!.data).toEqual(data);
  });

  it('omits result.data when run() returns no data', async () => {
    const { factory } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
    ]);

    const results = await Sentinel.parallel(
      [{ url: 'https://x.com', goal: 'Click' }],
      sharedOptions,
      factory
    );

    expect('data' in results[0]!).toBe(false);
  });

  it('calls onProgress after each completed task', async () => {
    const { factory } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
      { goalAchieved: true, success: true, totalSteps: 2, message: 'ok' },
    ]);
    const onProgress = jest.fn();

    const tasks: ParallelTask[] = [
      { url: 'https://a.com', goal: 'A' },
      { url: 'https://b.com', goal: 'B' },
    ];

    await Sentinel.parallel(tasks, { ...sharedOptions, concurrency: 1, onProgress }, factory);

    expect(onProgress).toHaveBeenCalledTimes(2);
    // First call: completed=1, total=2
    expect((onProgress.mock.calls[0] as any[])[0]).toBe(1);
    expect((onProgress.mock.calls[0] as any[])[1]).toBe(2);
    // Second call: completed=2, total=2
    expect((onProgress.mock.calls[1] as any[])[0]).toBe(2);
    expect((onProgress.mock.calls[1] as any[])[1]).toBe(2);
  });

  it('onProgress receives the ParallelResult of the completed task', async () => {
    const { factory } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 3, message: 'Goal achieved' },
    ]);
    const onProgress = jest.fn();

    await Sentinel.parallel(
      [{ url: 'https://x.com', goal: 'Do it' }],
      { ...sharedOptions, onProgress },
      factory
    );

    const resultArg = (onProgress.mock.calls[0] as any[])[2] as ParallelResult;
    expect(resultArg.goalAchieved).toBe(true);
    expect(resultArg.totalSteps).toBe(3);
  });

  it('concurrency defaults to 3 when not specified', async () => {
    const activeCount = { current: 0, peak: 0 };

    const factory = jest.fn(async () => ({
      goto: jest.fn(async () => {}),
      run: jest.fn(async () => {
        activeCount.current++;
        activeCount.peak = Math.max(activeCount.peak, activeCount.current);
        await new Promise(r => setTimeout(r, 5));
        activeCount.current--;
        return { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' };
      }),
      close: jest.fn(async () => {}),
    } as unknown as Sentinel));

    const tasks = Array.from({ length: 9 }, (_, i) => ({ url: `https://t${i}.com`, goal: `G${i}` }));

    // No concurrency specified — should default to 3
    await Sentinel.parallel(tasks, sharedOptions, factory);

    expect(activeCount.peak).toBeLessThanOrEqual(3);
  });

  it('concurrency clamped to task count when fewer tasks than limit', async () => {
    const { factory } = makeFactory([
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
      { goalAchieved: true, success: true, totalSteps: 1, message: 'ok' },
    ]);

    const results = await Sentinel.parallel(
      [{ url: 'https://a.com', goal: 'A' }, { url: 'https://b.com', goal: 'B' }],
      { ...sharedOptions, concurrency: 100 }, // more than 2 tasks
      factory
    );

    expect(results).toHaveLength(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
