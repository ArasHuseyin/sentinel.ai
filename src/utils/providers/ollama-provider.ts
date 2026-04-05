import type { LLMProvider, SchemaInput } from '../llm-provider.js';

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

  constructor(options: OllamaProviderOptions) {
    this.model = options.model;
    this.baseURL = options.baseURL ?? 'http://localhost:11434';
  }

  async generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
    const systemPrompt = `You are a JSON API. Always respond with valid JSON that matches this schema: ${JSON.stringify(schema)}. No markdown, no explanation, only raw JSON.`;

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
      throw new Error(`[OllamaProvider] HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as any;
    const content = data?.message?.content ?? '{}';

    try {
      return JSON.parse(content) as T;
    } catch {
      throw new Error(`[OllamaProvider] Failed to parse JSON response: ${content}`);
    }
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
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
      throw new Error(`[OllamaProvider] HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as any;
    return data?.message?.content ?? '';
  }
}
