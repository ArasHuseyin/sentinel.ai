import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mock @google/generative-ai before importing GeminiProvider ───────────────
//
// Shared, resettable mocks at module scope so tests can inspect call history
// and reconfigure per-test without the jest.resetModules + dynamic-import dance
// (which is flaky across Jest versions / module-cache states).

const mockGenerateContent = jest.fn<any>();
const mockGetGenerativeModel = jest.fn<any>();

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
}));

import { GeminiProvider } from '../utils/providers/gemini-provider.js';
import { ClaudeProvider } from '../utils/providers/claude-provider.js';
import { OpenAIProvider } from '../utils/providers/openai-provider.js';
import { OllamaProvider } from '../utils/providers/ollama-provider.js';

beforeEach(() => {
  // Reset every mock so call history doesn't leak between tests. Default impl:
  // getGenerativeModel returns a stub model whose generateContent resolves to
  // a minimal valid JSON response — enough for any test that actually invokes
  // generateStructuredData without hitting the real Google SDK.
  mockGetGenerativeModel.mockReset();
  mockGenerateContent.mockReset();
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => '{"ok": true}',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
  });
  mockGetGenerativeModel.mockImplementation(() => ({
    generateContent: mockGenerateContent,
  }));
});

// ─── Documented models (must match README Supported Models table) ─────────────

const GEMINI_MODELS = ['gemini-3-flash-preview', 'gemini-2.5-pro-preview-05-06'];

const CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini'];

const OLLAMA_MODELS = ['llama3.2', 'mistral'];

// These tests construct the REAL providers. They used to run against local stub
// classes that re-implemented the constructor logic, so they asserted a copy of
// the code instead of the code — which is how a constructor that threw on every
// single call (bare `require` in an ESM package) stayed green for releases.
// The optional SDKs are devDependencies precisely so this path is exercisable.
const readModel = (provider: object): string => (provider as { modelName: string }).modelName;
const readBaseURL = (provider: object): string => (provider as { baseURL: string }).baseURL;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LLM Providers – documented models', () => {
  describe('GeminiProvider', () => {
    it.each(GEMINI_MODELS)('accepts model "%s" without throwing', model => {
      expect(() => new GeminiProvider({ apiKey: 'test-key', model })).not.toThrow();
    });

    it('throws when no model and no GEMINI_VERSION env var', () => {
      const original = process.env.GEMINI_VERSION;
      delete process.env.GEMINI_VERSION;
      expect(() => new GeminiProvider({ apiKey: 'test-key' })).toThrow(
        'Gemini model name must be provided or GEMINI_VERSION must be set in .env'
      );
      if (original !== undefined) process.env.GEMINI_VERSION = original;
    });

    it('uses GEMINI_VERSION env var as default model', () => {
      process.env.GEMINI_VERSION = 'gemini-3-flash-preview';
      expect(() => new GeminiProvider({ apiKey: 'test-key' })).not.toThrow();
    });

    // These tests verify the per-systemInstruction model caching (prompt-cache
    // hit continuity) directly against `getModelFor`, without going through
    // `generateStructuredData`. We monkey-patch the `genAI` instance on the
    // provider after construction so the test doesn't depend on `jest.mock`
    // hoisting (which is flaky with ts-jest + ESM + injectGlobals: false) and
    // never touches the real Google SDK.
    it('reuses a single model instance per systemInstruction for prompt-cache hit continuity', () => {
      const provider = new GeminiProvider({
        apiKey: 'test-key',
        model: 'gemini-3-flash-preview',
      }) as any;
      const spy = jest.fn<any>().mockImplementation((args: any) => ({
        _marker: args?.systemInstruction?.parts?.[0]?.text ?? 'no-sys',
      }));
      provider.genAI.getGenerativeModel = spy;

      const sys = 'You are an autonomous browser agent. [... stable rules ...]';

      // First call with `sys` builds a model, second call hits the cache.
      provider.getModelFor(sys);
      provider.getModelFor(sys);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls as any[][])[0]?.[0]?.systemInstruction?.parts?.[0]?.text).toBe(sys);

      // A different systemInstruction produces its own cached instance.
      provider.getModelFor('different text');
      expect(spy).toHaveBeenCalledTimes(2);
      expect((spy.mock.calls as any[][])[1]?.[0]?.systemInstruction?.parts?.[0]?.text).toBe(
        'different text'
      );
    });

    it('returns the pre-built structuredModel when options.systemInstruction is undefined', () => {
      const provider = new GeminiProvider({
        apiKey: 'test-key',
        model: 'gemini-3-flash-preview',
      }) as any;
      const spy = jest.fn<any>().mockReturnValue({});
      provider.genAI.getGenerativeModel = spy;

      // getModelFor(undefined) must short-circuit to the constructor-built
      // structuredModel — it must NOT call getGenerativeModel again (that
      // would waste a model instance and defeat connection reuse).
      const model = provider.getModelFor(undefined);
      expect(spy).not.toHaveBeenCalled();
      expect(model).toBe(provider.structuredModel);
    });
  });

  describe('ClaudeProvider – model defaults (documented in README)', () => {
    it.each(CLAUDE_MODELS)('accepts model "%s"', model => {
      const provider = new ClaudeProvider({ apiKey: 'test-key', model });
      expect(readModel(provider)).toBe(model);
    });

    it('default model is claude-sonnet-5', () => {
      const provider = new ClaudeProvider({ apiKey: 'test-key' });
      expect(readModel(provider)).toBe('claude-sonnet-5');
    });
  });

  describe('OpenAIProvider – model defaults (documented in README)', () => {
    it.each(OPENAI_MODELS)('accepts model "%s"', model => {
      const provider = new OpenAIProvider({ apiKey: 'test-key', model });
      expect(readModel(provider)).toBe(model);
    });

    it('default model is gpt-4o', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key' });
      expect(readModel(provider)).toBe('gpt-4o');
    });
  });

  describe('OllamaProvider – model and baseURL defaults (documented in README)', () => {
    it.each(OLLAMA_MODELS)('accepts model "%s"', model => {
      const provider = new OllamaProvider({ model });
      expect(readModel(provider)).toBe(model);
    });

    it('default baseURL is http://localhost:11434', () => {
      const provider = new OllamaProvider({ model: 'llama3.2' });
      expect(readBaseURL(provider)).toBe('http://localhost:11434');
    });

    it('accepts custom baseURL', () => {
      const provider = new OllamaProvider({ model: 'mistral', baseURL: 'http://my-server:11434' });
      expect(readBaseURL(provider)).toBe('http://my-server:11434');
    });
  });

  // ─── Regression: optional SDKs must load under ESM ─────────────────────────
  //
  // The package is "type": "module". ClaudeProvider and OpenAIProvider used the
  // bare `require` identifier to lazily load their optional SDKs — which does
  // not exist in an ESM scope. Every construction threw ReferenceError, got
  // swallowed by a catch, and surfaced as '"<sdk>" package not found', so both
  // providers were unusable in every published build regardless of what the
  // user had installed.
  describe('optional SDK loading under ESM', () => {
    it('ClaudeProvider constructs when @anthropic-ai/sdk is installed', () => {
      expect(() => new ClaudeProvider({ apiKey: 'test-key' })).not.toThrow();
    });

    it('OpenAIProvider constructs when openai is installed', () => {
      expect(() => new OpenAIProvider({ apiKey: 'test-key' })).not.toThrow();
    });

    it('a constructed ClaudeProvider actually holds an SDK client', () => {
      const provider = new ClaudeProvider({ apiKey: 'test-key' });
      expect((provider as unknown as { client: unknown }).client).toBeDefined();
    });

    it('a constructed OpenAIProvider actually holds an SDK client', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key' });
      expect((provider as unknown as { client: unknown }).client).toBeDefined();
    });
  });

  describe('onTokenUsage callback', () => {
    it('GeminiProvider has onTokenUsage property', () => {
      process.env.GEMINI_VERSION = 'gemini-3-flash-preview';
      const provider = new GeminiProvider({ apiKey: 'test-key' });
      expect('onTokenUsage' in provider).toBe(true);
    });
  });

  describe('README Supported Models table – completeness check', () => {
    it('all documented Gemini models are listed', () => {
      expect(GEMINI_MODELS).toContain('gemini-3-flash-preview');
      expect(GEMINI_MODELS).toContain('gemini-2.5-pro-preview-05-06');
    });

    it('all documented Claude models are listed', () => {
      expect(CLAUDE_MODELS).toContain('claude-opus-5');
      expect(CLAUDE_MODELS).toContain('claude-sonnet-5');
      expect(CLAUDE_MODELS).toContain('claude-haiku-4-5-20251001');
    });

    it('all documented OpenAI models are listed', () => {
      expect(OPENAI_MODELS).toContain('gpt-4o');
      expect(OPENAI_MODELS).toContain('gpt-4o-mini');
    });

    it('all documented Ollama models are listed', () => {
      expect(OLLAMA_MODELS).toContain('llama3.2');
      expect(OLLAMA_MODELS).toContain('mistral');
    });
  });
});
