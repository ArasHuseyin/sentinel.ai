import { describe, it, expect } from '@jest/globals';
import { withTimeout } from '../../utils/with-timeout.js';

describe('withTimeout', () => {
  it('resolves with the inner promise value', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test');
    expect(result).toBe(42);
  });

  it('rejects with a timeout error when the promise is too slow', async () => {
    const neverResolves = new Promise<never>(() => {});
    await expect(withTimeout(neverResolves, 50, 'slow op')).rejects.toThrow(
      'Timeout after 50ms: slow op'
    );
  });

  it('re-throws the original error when the promise rejects before the timeout', async () => {
    const fails = Promise.reject(new Error('original error'));
    await expect(withTimeout(fails, 1000, 'test')).rejects.toThrow('original error');
  });

  it('uses "operation" as default label when none is provided', async () => {
    const neverResolves = new Promise<never>(() => {});
    await expect(withTimeout(neverResolves, 30)).rejects.toThrow(
      'Timeout after 30ms: operation'
    );
  });

  it('resolves immediately when the promise is already settled', async () => {
    const start = Date.now();
    await withTimeout(Promise.resolve('done'), 5000, 'instant');
    expect(Date.now() - start).toBeLessThan(100);
  });
});
