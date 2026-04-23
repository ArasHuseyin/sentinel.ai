import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import type { GenerateOptions, LLMProvider, SchemaInput, TokenUsage } from '../llm-provider.js';
import { LLMError } from '../../types/errors.js';
import { withRetry } from '../with-retry.js';

function isZodSchema(schema: unknown): schema is z.ZodType {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '_def' in schema &&
    typeof (schema as any).parse === 'function'
  );
}

function cleanSchemaForGemini(schema: any): any {
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);
  if (schema !== null && typeof schema === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === '$schema' || key === 'additionalProperties') continue;
      cleaned[key] = cleanSchemaForGemini(value);
    }
    return cleaned;
  }
  return schema;
}

function resolveJsonSchema<T>(schema: SchemaInput<T>): Record<string, any> {
  if (isZodSchema(schema)) {
    const jsonSchema = (z as any).toJSONSchema(schema);
    return cleanSchemaForGemini(jsonSchema);
  }
  return cleanSchemaForGemini(schema);
}

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
}

export class GeminiProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;
  private structuredModel: any;
  private textModel: any;
  /**
   * Cache of GenerativeModel instances keyed by systemInstruction text. Keeping a
   * stable model instance per system text means Gemini's implicit caching sees
   * identical request prefixes across calls and returns its cache hit discount.
   */
  private readonly systemModelCache = new Map<string, any>();
  private readonly modelName: string;
  onTokenUsage?: (usage: TokenUsage) => void;

  constructor(options: GeminiProviderOptions) {
    this.genAI = new GoogleGenerativeAI(options.apiKey);
    const modelName = options.model ?? process.env.GEMINI_VERSION;
    if (!modelName) throw new LLMError('Gemini model name must be provided or GEMINI_VERSION must be set in .env');
    this.modelName = modelName;
    this.structuredModel = this.genAI.getGenerativeModel({ model: modelName });
    this.textModel = this.genAI.getGenerativeModel({ model: modelName });
  }

  private getModelFor(systemInstruction?: string): any {
    if (!systemInstruction) return this.structuredModel;
    const cached = this.systemModelCache.get(systemInstruction);
    if (cached) return cached;
    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    });
    this.systemModelCache.set(systemInstruction, model);
    return model;
  }

  async generateStructuredData<T>(
    prompt: string,
    schema: SchemaInput<T>,
    options?: GenerateOptions
  ): Promise<T> {
    const jsonSchema = resolveJsonSchema(schema);
    const model = this.getModelFor(options?.systemInstruction);
    return withRetry(async () => {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: jsonSchema,
        },
      });
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      if (meta) {
        this.onTokenUsage?.({
          inputTokens: meta.promptTokenCount ?? 0,
          outputTokens: meta.candidatesTokenCount ?? 0,
          totalTokens: (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
        });
      }
      const parsed = JSON.parse(text);
      if (isZodSchema(schema)) return schema.parse(parsed) as T;
      return parsed as T;
    }, 'Gemini');
  }

  async analyzeImage(prompt: string, imageBase64: string, mimeType = 'image/png'): Promise<string> {
    return withRetry(async () => {
      const result = await this.textModel.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: imageBase64 } },
            ],
          },
        ],
      });
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      if (meta) {
        this.onTokenUsage?.({
          inputTokens: meta.promptTokenCount ?? 0,
          outputTokens: meta.candidatesTokenCount ?? 0,
          totalTokens: (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
        });
      }
      return text;
    }, 'Gemini');
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return withRetry(async () => {
      const model = systemInstruction
        ? this.genAI.getGenerativeModel({
            model: this.modelName,
            systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
          })
        : this.textModel;
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      if (meta) {
        this.onTokenUsage?.({
          inputTokens: meta.promptTokenCount ?? 0,
          outputTokens: meta.candidatesTokenCount ?? 0,
          totalTokens: (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
        });
      }
      return text;
    }, 'Gemini');
  }
}
