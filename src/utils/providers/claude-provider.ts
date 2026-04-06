import type { LLMProvider, SchemaInput } from '../llm-provider.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isRetryable =
        err?.status === 429 ||
        err?.status === 503 ||
        err?.message?.includes('fetch failed') ||
        err?.message?.includes('ECONNRESET') ||
        err?.message?.includes('rate limit') ||
        err?.message?.includes('overloaded') ||
        err?.message?.includes('timeout');
      if (!isRetryable || attempt === retries - 1) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[Claude] Retryable error (attempt ${attempt + 1}/${retries}). Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
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

  constructor(options: ClaudeProviderOptions) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      this.client = new Anthropic.default({ apiKey: options.apiKey });
    } catch {
      throw new Error(
        '[ClaudeProvider] "@anthropic-ai/sdk" package not found. Install it with: npm install @anthropic-ai/sdk'
      );
    }
    this.model = options.model ?? 'claude-sonnet-4-6';
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

      const toolUse = response.content.find((c: any) => c.type === 'tool_use');
      if (!toolUse) throw new Error('[ClaudeProvider] No tool_use block in response');
      return toolUse.input as T;
    });
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return withRetry(async () => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        ...(systemInstruction ? { system: systemInstruction } : {}),
        messages: [{ role: 'user', content: prompt }],
      });

      const textBlock = response.content.find((c: any) => c.type === 'text');
      return textBlock?.text ?? '';
    });
  }
}
