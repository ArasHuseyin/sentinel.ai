import { z } from 'zod';

/** Accepts either a Zod schema or a raw JSON Schema object */
export type SchemaInput<T> = z.ZodType | Record<string, any>;

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
