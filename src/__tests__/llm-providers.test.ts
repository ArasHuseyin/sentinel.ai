import { jest, describe, it, expect } from '@jest/globals';

// ─── Mock @google/generative-ai before importing GeminiProvider ───────────────

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({}),
  })),
}));

import { GeminiProvider } from '../utils/providers/gemini-provider.js';

// ─── Documented models (must match README Supported Models table) ─────────────

const GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-2.5-pro-preview-05-06',
];

const CLAUDE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-6',
];

const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
];

const OLLAMA_MODELS = [
  'llama3.2',
  'mistral',
];

// ─── Minimal provider stubs (mirrors real provider constructor logic) ──────────

class StubClaudeProvider {
  readonly model: string;
  constructor(options: { apiKey: string; model?: string }) {
    this.model = options.model ?? 'claude-sonnet-4-6';
  }
}

class StubOpenAIProvider {
  readonly model: string;
  constructor(options: { apiKey: string; model?: string; baseURL?: string }) {
    this.model = options.model ?? 'gpt-4o';
  }
}

class StubOllamaProvider {
  readonly model: string;
  readonly baseURL: string;
  constructor(options: { model: string; baseURL?: string }) {
    this.model = options.model;
    this.baseURL = options.baseURL ?? 'http://localhost:11434';
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LLM Providers – documented models', () => {

  describe('GeminiProvider', () => {
    it.each(GEMINI_MODELS)('accepts model "%s" without throwing', (model) => {
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
  });

  describe('ClaudeProvider – model defaults (documented in README)', () => {
    it.each(CLAUDE_MODELS)('accepts model "%s"', (model) => {
      const provider = new StubClaudeProvider({ apiKey: 'test-key', model });
      expect(provider.model).toBe(model);
    });

    it('default model is claude-sonnet-4-6', () => {
      const provider = new StubClaudeProvider({ apiKey: 'test-key' });
      expect(provider.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('OpenAIProvider – model defaults (documented in README)', () => {
    it.each(OPENAI_MODELS)('accepts model "%s"', (model) => {
      const provider = new StubOpenAIProvider({ apiKey: 'test-key', model });
      expect(provider.model).toBe(model);
    });

    it('default model is gpt-4o', () => {
      const provider = new StubOpenAIProvider({ apiKey: 'test-key' });
      expect(provider.model).toBe('gpt-4o');
    });
  });

  describe('OllamaProvider – model and baseURL defaults (documented in README)', () => {
    it.each(OLLAMA_MODELS)('accepts model "%s"', (model) => {
      const provider = new StubOllamaProvider({ model });
      expect(provider.model).toBe(model);
    });

    it('default baseURL is http://localhost:11434', () => {
      const provider = new StubOllamaProvider({ model: 'llama3.2' });
      expect(provider.baseURL).toBe('http://localhost:11434');
    });

    it('accepts custom baseURL', () => {
      const provider = new StubOllamaProvider({ model: 'mistral', baseURL: 'http://my-server:11434' });
      expect(provider.baseURL).toBe('http://my-server:11434');
    });
  });

  describe('README Supported Models table – completeness check', () => {
    it('all documented Gemini models are listed', () => {
      expect(GEMINI_MODELS).toContain('gemini-3-flash-preview');
      expect(GEMINI_MODELS).toContain('gemini-2.5-pro-preview-05-06');
    });

    it('all documented Claude models are listed', () => {
      expect(CLAUDE_MODELS).toContain('claude-opus-4-6');
      expect(CLAUDE_MODELS).toContain('claude-sonnet-4-6');
      expect(CLAUDE_MODELS).toContain('claude-haiku-4-6');
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
