import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { OllamaProvider } from '../../../utils/providers/ollama-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOkResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ message: { content: JSON.stringify(body) } }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OllamaProvider retry logic', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns data on first successful attempt (no retries needed)', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ key: 'value' }));

    const provider = new OllamaProvider({ model: 'llama3' });
    const promise = provider.generateStructuredData('test prompt', {});
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ key: 'value' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on ECONNRESET and succeeds on second attempt', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET: connection reset'))
      .mockResolvedValueOnce(makeOkResponse({ retried: true }));

    const provider = new OllamaProvider({ model: 'llama3' });
    const promise = provider.generateStructuredData('test prompt', {});
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ retried: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on ECONNREFUSED (Ollama not running) and succeeds on third attempt', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeOkResponse({ done: true }));

    const provider = new OllamaProvider({ model: 'llama3' });
    const promise = provider.generateStructuredData('test prompt', {});
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after all 3 retries exhausted on persistent network error', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed: ECONNRESET'));

    const provider = new OllamaProvider({ model: 'llama3' });
    const promise = provider.generateStructuredData('test prompt', {});
    // Attach rejection handler BEFORE advancing timers to prevent unhandled rejection
    const assertion = expect(promise).rejects.toThrow('fetch failed');
    await jest.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_RETRIES = 3
  });

  it('does not retry on non-retryable JSON parse errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: 'invalid{{json' } }),
      text: async () => '',
    } as unknown as Response);

    const provider = new OllamaProvider({ model: 'llama3' });
    // No timer advancement needed — JSON parse error is thrown synchronously (no delay)
    await expect(provider.generateStructuredData('test prompt', {})).rejects.toThrow(
      'Failed to parse JSON'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries
  });

  it('retries generateText on timeout error', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('timeout: request took too long'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: { content: 'Hello world' } }),
        text: async () => '',
      } as unknown as Response);

    const provider = new OllamaProvider({ model: 'llama3' });
    const promise = provider.generateText('Say hello');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('Hello world');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
