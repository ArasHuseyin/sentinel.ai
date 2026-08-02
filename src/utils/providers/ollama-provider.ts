import { z } from 'zod';
import type { GenerateOptions, LLMProvider, SchemaInput, TokenUsage } from '../llm-provider.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, RETRY_MAX_OUTPUT_TOKENS } from '../llm-provider.js';
import { LLMError } from '../../types/errors.js';
import { withRetry } from '../with-retry.js';
import { createLogger, type Logger } from '../logger.js';

function isZodSchema(schema: unknown): schema is z.ZodType {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '_def' in schema &&
    typeof (schema as any).parse === 'function'
  );
}

export interface OllamaProviderOptions {
  /** Sink for provider diagnostics (truncation retries). */
  logger?: Logger;
  model: string;
  baseURL?: string;
}

/**
 * Ollama provider for local LLMs (llama3, mistral, qwen2.5, etc.)
 * Requires a running Ollama instance: https://ollama.com
 * No additional npm packages needed – uses the native fetch API.
 */
export class OllamaProvider implements LLMProvider {
  readonly modelName: string;
  private baseURL: string;
  onTokenUsage?: (usage: TokenUsage) => void;
  private readonly logger: Logger;

  constructor(options: OllamaProviderOptions) {
    this.modelName = options.model;
    this.baseURL = options.baseURL ?? 'http://localhost:11434';
    this.logger = (options.logger ?? createLogger(false, 1)).child('Ollama');
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
    const requestedCap = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    // Ollama has no prompt-caching; we merge systemInstruction into the system
    // message so the model still sees the agent rules alongside the JSON-format
    // guidance. Token cost is unchanged — this keeps API parity with other providers.
    const jsonGuide = `You are a JSON API. Always respond with valid JSON that matches this schema: ${JSON.stringify(schema)}. No markdown, no explanation, only raw JSON.`;
    const systemPrompt = options?.systemInstruction
      ? `${options.systemInstruction}\n\n${jsonGuide}`
      : jsonGuide;

    // Ollama exposes the output cap as options.num_predict. On recent server
    // versions, done_reason='length' signals truncation — we mirror the
    // adaptive-retry pattern from the cloud providers. Older Ollama builds
    // omit done_reason; the retry simply never fires there, which is safe.
    const callOnce = async (cap: number): Promise<{ content: string; truncated: boolean }> => {
      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelName,
          stream: false,
          format: 'json',
          options: { num_predict: cap },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!response.ok) {
        throw new LLMError(`HTTP ${response.status}: ${await response.text()}`);
      }
      const data = await response.json();
      this.reportUsage(data);
      const content = data?.message?.content ?? '{}';
      const truncated = data?.done_reason === 'length';
      return { content, truncated };
    };

    return withRetry(async () => {
      let { content, truncated } = await callOnce(requestedCap);
      if (truncated && requestedCap < RETRY_MAX_OUTPUT_TOKENS) {
        this.logger.warn(
          `Output truncated at ${requestedCap} tokens — retrying once at ${RETRY_MAX_OUTPUT_TOKENS}.`
        );
        ({ content, truncated } = await callOnce(RETRY_MAX_OUTPUT_TOKENS));
      }
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
          model: this.modelName,
          stream: false,
          messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
        }),
      });
      if (!response.ok) {
        throw new LLMError(`HTTP ${response.status}: ${await response.text()}`);
      }
      const data = await response.json();
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
          model: this.modelName,
          stream: false,
          messages,
        }),
      });

      if (!response.ok) {
        throw new LLMError(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      this.reportUsage(data);
      return data?.message?.content ?? '';
    }, 'Ollama');
  }
}
