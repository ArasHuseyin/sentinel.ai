import { z } from 'zod';
import type { GenerateOptions, LLMProvider, SchemaInput, TokenUsage } from '../llm-provider.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, RETRY_MAX_OUTPUT_TOKENS } from '../llm-provider.js';
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

  async generateStructuredData<T>(
    prompt: string,
    schema: SchemaInput<T>,
    options?: GenerateOptions
  ): Promise<T> {
    const requestedCap = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    // One-shot adaptive retry on truncation: Claude signals via
    // stop_reason='max_tokens'. The tool_use block is usually still present
    // but with incomplete input, so we surface the truncation explicitly
    // before retrying.
    const callOnce = async (cap: number): Promise<{ response: any; truncated: boolean }> => {
      const request: any = {
        model: this.model,
        max_tokens: cap,
        tools: [
          {
            name: 'structured_output',
            description: 'Return structured data matching the schema',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'tool', name: 'structured_output' },
        messages: [{ role: 'user', content: prompt }],
      };
      if (options?.systemInstruction) {
        request.system = [{
          type: 'text',
          text: options.systemInstruction,
          cache_control: { type: 'ephemeral' },
        }];
      }
      const response = await this.client.messages.create(request);
      this.reportUsage(response);
      const truncated = response?.stop_reason === 'max_tokens';
      return { response, truncated };
    };

    return withRetry(async () => {
      let { response, truncated } = await callOnce(requestedCap);
      if (truncated && requestedCap < RETRY_MAX_OUTPUT_TOKENS) {
        console.warn(
          `[Claude] Output truncated at ${requestedCap} tokens — retrying once at ${RETRY_MAX_OUTPUT_TOKENS}.`
        );
        ({ response, truncated } = await callOnce(RETRY_MAX_OUTPUT_TOKENS));
      }
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
