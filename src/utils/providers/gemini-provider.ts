import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
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
        err?.message?.includes('rate limit');
      if (!isRetryable || attempt === retries - 1) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[Gemini] Retryable error (attempt ${attempt + 1}/${retries}). Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

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

  constructor(options: GeminiProviderOptions) {
    this.genAI = new GoogleGenerativeAI(options.apiKey);
    const modelName = options.model ?? process.env.GEMINI_VERSION;
    if (!modelName) throw new Error('Gemini model name must be provided or GEMINI_VERSION must be set in .env');
    this.structuredModel = this.genAI.getGenerativeModel({ model: modelName });
    this.textModel = this.genAI.getGenerativeModel({ model: modelName });
  }

  async generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
    const jsonSchema = resolveJsonSchema(schema);
    return withRetry(async () => {
      const result = await this.structuredModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: jsonSchema,
        },
      });
      const text = result.response.text();
      const parsed = JSON.parse(text);
      if (isZodSchema(schema)) return schema.parse(parsed) as T;
      return parsed as T;
    });
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
      return result.response.text();
    });
  }

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    return withRetry(async () => {
      const params: any = { model: process.env.GEMINI_VERSION || 'gemini-3-flash-preview' };
      if (systemInstruction) {
        params.systemInstruction = { role: 'system', parts: [{ text: systemInstruction }] };
      }
      const model = systemInstruction ? this.genAI.getGenerativeModel(params) : this.textModel;
      const result = await model.generateContent(prompt);
      return result.response.text();
    });
  }
}
