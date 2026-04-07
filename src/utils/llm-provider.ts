import { z } from 'zod';

/**
 * Schema input: Zod schema (with runtime validation) or raw JSON Schema object.
 * When using Zod, the return type T is inferred and validated at runtime.
 * When using raw JSON Schema, T is unchecked — the caller is responsible for correctness.
 */
export type SchemaInput<T> = z.ZodType<T> | Record<string, any>;

/**
 * Unified interface for all LLM providers.
 * Implement this to add support for any LLM backend.
 */
export interface LLMProvider {
  /**
   * Generate structured JSON data conforming to the given schema.
   */
  generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T>;

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
