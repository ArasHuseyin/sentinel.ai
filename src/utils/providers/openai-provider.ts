import { z } from 'zod';
import type { GenerateOptions, LLMProvider, SchemaInput, TokenUsage } from '../llm-provider.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, RETRY_MAX_OUTPUT_TOKENS } from '../llm-provider.js';
import { LLMError } from '../../types/errors.js';
import { withRetry } from '../with-retry.js';

function isZodSchema(schema: unknown): schema is z.ZodType {
  return typeof schema === 'object' && schema !== null && '_def' in schema && typeof (schema as any).parse === 'function';
}

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

/**
 * OpenAI provider (GPT-4o, GPT-4o-mini, etc.)
 * Requires: npm install openai
 */
export class OpenAIProvider implements LLMProvider {
  private client: any;
  private model: string;
  onTokenUsage?: (usage: TokenUsage) => void;

  constructor(options: OpenAIProviderOptions) {
    try {
      // Dynamic import to keep openai as optional peer dependency
      const { OpenAI } = require('openai');
      this.client = new OpenAI({
        apiKey: options.apiKey,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
    } catch {
      throw new LLMError(
        '"openai" package not found. Install it with: npm install openai'
      );
    }
    this.model = options.model ?? 'gpt-4o';
  }

  private reportUsage(response: any): void {
    const usage = response?.usage;
    if (usage) {
      this.onTokenUsage?.({
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      });
    }
  }

  async generateStructuredData<T>(
    prompt: string,
    schema: SchemaInput<T>,
    options?: GenerateOptions
  ): Promise<T> {
    const requestedCap = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    // One-shot adaptive retry on truncation: OpenAI signals via
    // finish_reason='length'. Mirrors the Gemini path so behavior is
    // consistent across providers.
    const callOnce = async (cap: number): Promise<{ content: string; truncated: boolean }> => {
      const messages: Array<{ role: string; content: string }> = [];
      if (options?.systemInstruction) {
        messages.push({ role: 'system', content: options.systemInstruction });
      }
      messages.push({ role: 'user', content: prompt });
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: cap,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            schema: schema,
          },
        },
      });
      this.reportUsage(response);
      const choice = response.choices[0];
      const content = choice?.message?.content ?? '{}';
      const truncated = choice?.finish_reason === 'length';
      return { content, truncated };
    };

    return withRetry(async () => {
      let { content, truncated } = await callOnce(requestedCap);
      if (truncated && requestedCap < RETRY_MAX_OUTPUT_TOKENS) {
        console.warn(
          `[OpenAI] Output truncated at ${requestedCap} tokens — retrying once at ${RETRY_MAX_OUTPUT_TOKENS}.`
        );
        ({ content, truncated } = await callOnce(RETRY_MAX_OUTPUT_TOKENS));
      }
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new LLMError(`Failed to parse JSON response: ${content}`);
      }
      if (isZodSchema(schema)) return (schema as z.ZodType<T>).parse(parsed);
      return parsed as T;
    }, 'OpenAI');
  }

  async analyzeImage(prompt: string, imageBase64: string, mimeType = 'image/png'): Promise<string> {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });
      this.reportUsage(response);
      return response.choices[0]?.message?.content ?? '';
    }, 'OpenAI');
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return withRetry(async () => {
      const messages: any[] = [];
      if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
      });
      this.reportUsage(response);
      return response.choices[0]?.message?.content ?? '';
    }, 'OpenAI');
  }
}
