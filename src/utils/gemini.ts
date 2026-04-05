/**
 * GeminiService – thin wrapper kept for backward compatibility.
 * Internally delegates to GeminiProvider.
 */
import { GeminiProvider } from './providers/gemini-provider.js';
import type { SchemaInput } from './llm-provider.js';

export type { SchemaInput };

export class GeminiService {
  private provider: GeminiProvider;

  constructor(apiKey: string) {
    this.provider = new GeminiProvider({ apiKey });
  }

  async generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
    return this.provider.generateStructuredData<T>(prompt, schema);
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return this.provider.generateText(prompt, systemInstruction);
  }
}
