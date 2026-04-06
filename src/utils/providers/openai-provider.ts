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
        err?.message?.includes('timeout');
      if (!isRetryable || attempt === retries - 1) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[OpenAI] Retryable error (attempt ${attempt + 1}/${retries}). Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
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

  constructor(options: OpenAIProviderOptions) {
    try {
      // Dynamic import to keep openai as optional peer dependency
      const { OpenAI } = require('openai');
      this.client = new OpenAI({
        apiKey: options.apiKey,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
    } catch {
      throw new Error(
        '[OpenAIProvider] "openai" package not found. Install it with: npm install openai'
      );
    }
    this.model = options.model ?? 'gpt-4o';
  }

  async generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            schema: schema,
          },
        },
      });
      const content = response.choices[0]?.message?.content ?? '{}';
      return JSON.parse(content) as T;
    });
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
      return response.choices[0]?.message?.content ?? '';
    });
  }
}
