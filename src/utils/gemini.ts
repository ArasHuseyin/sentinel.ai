/**
 * GeminiService – thin wrapper kept for backward compatibility.
 * Internally delegates to GeminiProvider.
 */
import { GeminiProvider } from './providers/gemini-provider.js';
import type { GenerateOptions, SchemaInput, TokenUsage } from './llm-provider.js';

export type { SchemaInput };

export class GeminiService {
  private provider: GeminiProvider;
  onTokenUsage?: (usage: TokenUsage) => void;

  constructor(apiKey: string) {
    this.provider = new GeminiProvider({ apiKey });
  }

  private syncTokenUsage(): void {
    if (this.onTokenUsage) {
      this.provider.onTokenUsage = this.onTokenUsage;
    } else {
      delete (this.provider as any).onTokenUsage;
    }
  }

  async generateStructuredData<T>(
    prompt: string,
    schema: SchemaInput<T>,
    options?: GenerateOptions
  ): Promise<T> {
    this.syncTokenUsage();
    return this.provider.generateStructuredData<T>(prompt, schema, options);
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    this.syncTokenUsage();
    return this.provider.generateText(prompt, systemInstruction);
  }
}
