import { z } from 'zod';
import type { LLMProvider, SchemaInput, TokenUsage } from '../llm-provider.js';
import { LLMError } from '../../types/errors.js';
import { withRetry } from '../with-retry.js';

function isZodSchema(schema: unknown): schema is z.ZodType {
  return typeof schema === 'object' && schema !== null && '_def' in schema && typeof (schema as any).parse === 'function';
}

export interface ClaudeProviderOptions {
  apiKey: string;
  model?: string;
}

/**
 * Anthropic Claude provider (claude-3-5-sonnet, claude-3-haiku, etc.)
 * Requires: npm install @anthropic-ai/sdk
 */
export class ClaudeProvider implements LLMProvider {
  private client: any;
  private model: string;
  onTokenUsage?: (usage: TokenUsage) => void;

  constructor(options: ClaudeProviderOptions) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      this.client = new Anthropic.default({ apiKey: options.apiKey });
    } catch {
      throw new LLMError(
        '"@anthropic-ai/sdk" package not found. Install it with: npm install @anthropic-ai/sdk'
      );
    }
    this.model = options.model ?? 'claude-sonnet-4-6';
  }

  private reportUsage(response: any): void {
    const usage = response?.usage;
    if (usage) {
      this.onTokenUsage?.({
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      });
    }
  }

  async generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
    return withRetry(async () => {
      // Claude uses tool_use for structured output
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        tools: [
          {
            name: 'structured_output',
            description: 'Return structured data matching the schema',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'tool', name: 'structured_output' },
        messages: [{ role: 'user', content: prompt }],
      });

      this.reportUsage(response);
      const toolUse = (response.content as any[])?.find((c: any) => c.type === 'tool_use');
      if (!toolUse) throw new LLMError('No tool_use block in response');
      if (isZodSchema(schema)) return (schema as z.ZodType<T>).parse(toolUse.input);
      return toolUse.input as T;
    }, 'Claude');
  }

  async analyzeImage(prompt: string, imageBase64: string, mimeType = 'image/png'): Promise<string> {
    return withRetry(async () => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });
      this.reportUsage(response);
      const textBlock = (response.content as any[])?.find((c: any) => c.type === 'text');
      return textBlock?.text ?? '';
    }, 'Claude');
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return withRetry(async () => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        ...(systemInstruction ? { system: systemInstruction } : {}),
        messages: [{ role: 'user', content: prompt }],
      });

      this.reportUsage(response);
      const textBlock = (response.content as any[])?.find((c: any) => c.type === 'text');
      return textBlock?.text ?? '';
    }, 'Claude');
  }
}
