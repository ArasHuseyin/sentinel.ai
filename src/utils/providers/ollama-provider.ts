import { z } from 'zod';
import type { GenerateOptions, LLMProvider, SchemaInput, TokenUsage } from '../llm-provider.js';
import { LLMError } from '../../types/errors.js';
import { withRetry } from '../with-retry.js';

function isZodSchema(schema: unknown): schema is z.ZodType {
  return typeof schema === 'object' && schema !== null && '_def' in schema && typeof (schema as any).parse === 'function';
}

export interface OllamaProviderOptions {
  model: string;
  baseURL?: string;
}

/**
 * Ollama provider for local LLMs (llama3, mistral, qwen2.5, etc.)
 * Requires a running Ollama instance: https://ollama.com
 * No additional npm packages needed – uses the native fetch API.
 */
export class OllamaProvider implements LLMProvider {
  private model: string;
  private baseURL: string;
  onTokenUsage?: (usage: TokenUsage) => void;

  constructor(options: OllamaProviderOptions) {
    this.model = options.model;
    this.baseURL = options.baseURL ?? 'http://localhost:11434';
  }

  private reportUsage(data: any): void {
    const promptTokens = data?.prompt_eval_count ?? 0;
    const outputTokens = data?.eval_count ?? 0;
    if (promptTokens || outputTokens) {
      this.onTokenUsage?.({
        inputTokens: promptTokens,
        outputTokens,
        totalTokens: promptTokens + outputTokens,
      });
    }
  }

  async generateStructuredData<T>(
    prompt: string,
    schema: SchemaInput<T>,
    options?: GenerateOptions
  ): Promise<T> {
    return withRetry(async () => {
      // Ollama has no prompt-caching; we merge systemInstruction into the system
      // message so the model still sees the agent rules alongside the JSON-format
      // guidance. Token cost is unchanged — this keeps API parity with other providers.
      const jsonGuide = `You are a JSON API. Always respond with valid JSON that matches this schema: ${JSON.stringify(schema)}. No markdown, no explanation, only raw JSON.`;
      const systemPrompt = options?.systemInstruction
        ? `${options.systemInstruction}\n\n${jsonGuide}`
        : jsonGuide;

      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        throw new LLMError(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as any;
      this.reportUsage(data);
      const content = data?.message?.content ?? '{}';

      try {
        const parsed = JSON.parse(content);
        if (isZodSchema(schema)) return (schema as z.ZodType<T>).parse(parsed);
        return parsed as T;
      } catch {
        throw new LLMError(`Failed to parse JSON response: ${content}`);
      }
    }, 'Ollama');
  }

  async analyzeImage(prompt: string, imageBase64: string, _mimeType?: string): Promise<string> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'user', content: prompt, images: [imageBase64] },
          ],
        }),
      });
      if (!response.ok) {
        throw new LLMError(`HTTP ${response.status}: ${await response.text()}`);
      }
      const data = await response.json() as any;
      this.reportUsage(data);
      return data?.message?.content ?? '';
    }, 'Ollama');
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return withRetry(async () => {
      const messages: any[] = [];
      if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages,
        }),
      });

      if (!response.ok) {
        throw new LLMError(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as any;
      this.reportUsage(data);
      return data?.message?.content ?? '';
    }, 'Ollama');
  }
}
