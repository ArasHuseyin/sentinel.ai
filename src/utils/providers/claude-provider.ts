import type { LLMProvider, SchemaInput } from '../llm-provider.js';

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
    this.model = options.model ?? 'claude-3-5-sonnet-20241022';
  }

  async generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
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
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      ...(systemInstruction ? { system: systemInstruction } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((c: any) => c.type === 'text');
    return textBlock?.text ?? '';
  }
}
