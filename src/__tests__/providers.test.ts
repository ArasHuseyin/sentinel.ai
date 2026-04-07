import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ClaudeProvider } from '../utils/providers/claude-provider.js';
import { OpenAIProvider } from '../utils/providers/openai-provider.js';
import { LLMError } from '../types/errors.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// ClaudeProvider and OpenAIProvider use require() to load optional SDKs.
// Since the SDKs are not installed, we bypass the constructor entirely using
// Object.create and inject mock clients directly.

function makeClaudeProvider(model = 'claude-sonnet-4-6') {
  const mockCreate = jest.fn<() => Promise<any>>();
  const mockClient = { messages: { create: mockCreate } };

  const provider = Object.create(ClaudeProvider.prototype) as ClaudeProvider;
  (provider as any).client = mockClient;
  (provider as any).model = model;

  return { provider, mockCreate };
}

function makeOpenAIProvider(model = 'gpt-4o') {
  const mockCreate = jest.fn<() => Promise<any>>();
  const mockClient = { chat: { completions: { create: mockCreate } } };

  const provider = Object.create(OpenAIProvider.prototype) as OpenAIProvider;
  (provider as any).client = mockClient;
  (provider as any).model = model;

  return { provider, mockCreate };
}

// ─── ClaudeProvider ───────────────────────────────────────────────────────────

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;
  let mockCreate: jest.Mock<() => Promise<any>>;

  beforeEach(() => {
    ({ provider, mockCreate } = makeClaudeProvider());
  });

  describe('generateStructuredData', () => {
    it('extracts input from tool_use block', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', input: { name: 'Alice', age: 30 } }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const result = await provider.generateStructuredData('test prompt', {
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'number' } },
      });

      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    it('calls onTokenUsage with input/output tokens', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', input: { value: 1 } }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const usageSpy = jest.fn();
      provider.onTokenUsage = usageSpy;

      await provider.generateStructuredData('test prompt', {
        type: 'object',
        properties: { value: { type: 'number' } },
      });

      expect(usageSpy).toHaveBeenCalledWith({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('throws LLMError when no tool_use block in response', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'some text' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await expect(
        provider.generateStructuredData('test prompt', { type: 'object' })
      ).rejects.toThrow(LLMError);
    });

    it('throws LLMError with correct message when response is empty', async () => {
      mockCreate.mockResolvedValue({
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await expect(
        provider.generateStructuredData('test prompt', { type: 'object' })
      ).rejects.toThrow('No tool_use block in response');
    });
  });

  describe('generateText', () => {
    it('returns text from first text block', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello world' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      });

      const result = await provider.generateText('say hello');

      expect(result).toBe('Hello world');
    });

    it('returns empty string when no text block in response', async () => {
      mockCreate.mockResolvedValue({
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      });

      const result = await provider.generateText('say hello');

      expect(result).toBe('');
    });

    it('passes system instruction when provided', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        usage: { input_tokens: 30, output_tokens: 10 },
      });

      await provider.generateText('user prompt', 'You are a helpful assistant');

      const callArgs = (mockCreate.mock.calls as any[][])[0]![0];
      expect(callArgs.system).toBe('You are a helpful assistant');
    });
  });

  describe('analyzeImage', () => {
    it('sends image content correctly in messages array', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'A cat' }],
        usage: { input_tokens: 200, output_tokens: 20 },
      });

      await provider.analyzeImage!('What is in this image?', 'base64encodeddata', 'image/jpeg');

      const callArgs = (mockCreate.mock.calls as any[][])[0]![0];
      const userContent = callArgs.messages[0].content;

      expect(userContent).toContainEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'base64encodeddata' },
      });
      expect(userContent).toContainEqual({
        type: 'text',
        text: 'What is in this image?',
      });
    });

    it('returns text from response', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'A fluffy cat' }],
        usage: { input_tokens: 200, output_tokens: 20 },
      });

      const result = await provider.analyzeImage!('Describe this image', 'base64data');

      expect(result).toBe('A fluffy cat');
    });
  });
});

// ─── OpenAIProvider ───────────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;
  let mockCreate: jest.Mock<() => Promise<any>>;

  beforeEach(() => {
    ({ provider, mockCreate } = makeOpenAIProvider());
  });

  describe('generateStructuredData', () => {
    it('parses JSON from choices[0].message.content', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"city":"Berlin","population":3700000}' } }],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      });

      const result = await provider.generateStructuredData<{ city: string; population: number }>(
        'test prompt',
        { type: 'object', properties: { city: { type: 'string' }, population: { type: 'number' } } }
      );

      expect(result).toEqual({ city: 'Berlin', population: 3700000 });
    });

    it('calls onTokenUsage with prompt_tokens and completion_tokens', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"value":42}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });

      const usageSpy = jest.fn();
      provider.onTokenUsage = usageSpy;

      await provider.generateStructuredData('test prompt', {
        type: 'object',
        properties: { value: { type: 'number' } },
      });

      expect(usageSpy).toHaveBeenCalledWith({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });
  });

  describe('generateText', () => {
    it('returns content from choices[0].message.content', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'Paris is the capital of France.' } }],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
      });

      const result = await provider.generateText('What is the capital of France?');

      expect(result).toBe('Paris is the capital of France.');
    });

    it('returns empty string when content is null', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      });

      const result = await provider.generateText('test');

      expect(result).toBe('');
    });

    it('prepends system message when systemInstruction is provided', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'Response' } }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      });

      await provider.generateText('user prompt', 'You are a helpful assistant');

      const callArgs = (mockCreate.mock.calls as any[][])[0]![0];
      expect(callArgs.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
      expect(callArgs.messages[1]).toEqual({ role: 'user', content: 'user prompt' });
    });
  });

  describe('analyzeImage', () => {
    it('sends base64 image as image_url in messages array', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'A dog running in a field.' } }],
        usage: { prompt_tokens: 300, completion_tokens: 15, total_tokens: 315 },
      });

      await provider.analyzeImage!('Describe the scene', 'base64imagedata', 'image/png');

      const callArgs = (mockCreate.mock.calls as any[][])[0]![0];
      const userContent = callArgs.messages[0].content;

      expect(userContent).toContainEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,base64imagedata' },
      });
      expect(userContent).toContainEqual({
        type: 'text',
        text: 'Describe the scene',
      });
    });

    it('returns text from response', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'A sunset over the ocean.' } }],
        usage: { prompt_tokens: 300, completion_tokens: 12, total_tokens: 312 },
      });

      const result = await provider.analyzeImage!('What do you see?', 'base64data');

      expect(result).toBe('A sunset over the ocean.');
    });
  });
});
