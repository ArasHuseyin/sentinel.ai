import type { LLMProvider, SchemaInput } from '../llm-provider.js';

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
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
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
  }
}
