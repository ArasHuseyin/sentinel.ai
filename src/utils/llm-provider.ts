import { z } from 'zod';

/**
 * Schema input: Zod schema (with runtime validation) or raw JSON Schema object.
 * When using Zod, the return type T is inferred and validated at runtime.
 * When using raw JSON Schema, T is unchecked — the caller is responsible for correctness.
 */
export type SchemaInput<T> = z.ZodType<T> | Record<string, any>;

/**
 * Optional per-call options accepted by `generateStructuredData`.
 *
 * `systemInstruction`: static guidance (agent rules, response format, action catalog)
 * that's identical across calls within a session. Keeping this stable enables
 * provider-side prompt caching: Gemini's implicit caching, OpenAI's automatic
 * prompt caching (prompts >= 1024 tokens, 50% discount on hits), and Anthropic's
 * `cache_control`. Callers should put everything that *doesn't* change with the
 * current page state here.
 *
 * `maxOutputTokens`: per-call output cap. Defaults to `DEFAULT_MAX_OUTPUT_TOKENS`
 * (16000) when unset. Providers that detect truncation (Gemini MAX_TOKENS,
 * OpenAI finish_reason='length', Anthropic stop_reason='max_tokens') retry once
 * with double the cap before surfacing a parse error. Override for known-large
 * extracts (e.g. 50-row tables) or known-tiny calls (reflect → 1000).
 */
export interface GenerateOptions {
  systemInstruction?: string;
  maxOutputTokens?: number;
}

/**
 * Global default output cap. Sized to comfortably cover legitimate browser-
 * automation outputs (Amazon Top-50 ≈ 8k tokens, Wikipedia tables ≈ 10k,
 * Reddit threads ≈ 12k) while bounding pathological runaway calls — we
 * observed a single Gemini call emit 64k output tokens on Amazon search,
 * driving cost and latency 8× normal. With this cap that worst case is
 * capped at ~$0.05 instead of ~$0.40.
 *
 * The matching `RETRY_MAX_OUTPUT_TOKENS` (32000) is used by providers'
 * adaptive-retry path on detected truncation: if a legitimate large extract
 * gets cut, one retry at double the budget recovers it. Anything still
 * truncating at 32k is almost certainly a runaway loop, surface the error.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const RETRY_MAX_OUTPUT_TOKENS = 32000;

/**
 * Unified interface for all LLM providers.
 * Implement this to add support for any LLM backend.
 */
export interface LLMProvider {
  /**
   * Generate structured JSON data conforming to the given schema.
   */
  generateStructuredData<T>(
    prompt: string,
    schema: SchemaInput<T>,
    options?: GenerateOptions
  ): Promise<T>;

  /**
   * Generate a plain text response.
   */
  generateText(prompt: string, systemInstruction?: string): Promise<string>;

  /**
   * Analyze an image with a text prompt.
   * Optional — implement only for vision-capable models.
   * Returns a plain text response (JSON parsing is handled by the caller).
   */
  analyzeImage?(prompt: string, imageBase64: string, mimeType?: string): Promise<string>;

  /** Optional callback invoked after each LLM call with token usage data */
  onTokenUsage?: (usage: TokenUsage) => void;
}

/**
 * Token usage tracking returned by providers that support it.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated cost in USD, if calculable */
  estimatedCostUsd?: number;
}
