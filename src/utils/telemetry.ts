import { trace, metrics, context, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Attributes } from '@opentelemetry/api';
import type { LLMProvider, SchemaInput, TokenUsage } from './llm-provider.js';

const TRACER_NAME = '@isoldex/sentinel';
const VERSION = '3.9.0';

// ─── Span helper ──────────────────────────────────────────────────────────────

/**
 * Creates a span, runs `fn` inside it, then ends the span.
 * Automatically marks the span as ERROR and records the exception on throw.
 * Uses `context.with()` so nested spans (e.g. LLM calls) become children.
 * No-op when no OTel SDK is configured.
 */
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const span = trace.getTracer(TRACER_NAME, VERSION).startSpan(name, { attributes: attrs });
  const ctx = trace.setSpan(context.active(), span);
  try {
    const result = await context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err) });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

const _m = metrics.getMeter(TRACER_NAME, VERSION);

/** act() call count — label: `success` ('true' | 'false') */
export const actCounter   = _m.createCounter('sentinel.act.requests',       { description: 'Number of act() calls' });
/** act() duration in ms */
export const actDuration  = _m.createHistogram('sentinel.act.duration_ms',  { description: 'act() call duration', unit: 'ms' });
/** LLM API call count — labels: `llm.model`, `success` */
export const llmCounter   = _m.createCounter('sentinel.llm.requests',       { description: 'Number of LLM API calls' });
/** LLM token count — labels: `llm.model`, `direction` ('input' | 'output') */
export const llmTokens    = _m.createCounter('sentinel.llm.tokens',         { description: 'LLM token usage' });
/** LLM call duration in ms — label: `llm.model` */
export const llmDuration  = _m.createHistogram('sentinel.llm.duration_ms',  { description: 'LLM API call duration', unit: 'ms' });
/** Steps per agent run — label: `goal_achieved` ('true' | 'false') */
export const agentSteps   = _m.createHistogram('sentinel.agent.steps',      { description: 'Steps per agent run' });

// ─── Tracing LLM provider wrapper ────────────────────────────────────────────

/**
 * Wraps an `LLMProvider` with OpenTelemetry traces and metrics.
 *
 * Each call to `generateStructuredData`, `generateText`, or `analyzeImage`
 * produces a `sentinel.llm` child span with:
 *   - `llm.system`         — model name
 *   - `gen_ai.operation.name` — method name
 *   - `llm.tokens.input/output/total` — populated from `onTokenUsage`
 *   - `llm.cost_usd`       — if the provider reports it
 *
 * Metrics recorded:
 *   - `sentinel.llm.requests` (counter)
 *   - `sentinel.llm.tokens`   (counter, split by direction)
 *   - `sentinel.llm.duration_ms` (histogram)
 *
 * Fully transparent: `onTokenUsage` forwarding is preserved so the Sentinel
 * token tracker keeps working. No-op when no OTel SDK is configured.
 */
export function createTracingProvider(provider: LLMProvider, modelName: string): LLMProvider {

  async function wrap<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    // NOTE: We intentionally do NOT intercept provider.onTokenUsage here.
    // Modifying a shared property would cause a race condition when multiple
    // LLM calls run concurrently (e.g. via sentinel.extend()).
    // Token metrics are instead recorded by Sentinel.init() which extends
    // _tokenUsageCallback to emit to llmTokens. This wrapper only records
    // call count, duration, and per-span latency.
    const t0 = Date.now();
    return withSpan(
      'sentinel.llm',
      { 'llm.system': modelName, 'gen_ai.operation.name': operation },
      async (_span) => {
        try {
          const result = await fn();
          llmCounter.add(1,  { 'llm.model': modelName, success: 'true' });
          llmDuration.record(Date.now() - t0, { 'llm.model': modelName });
          return result;
        } catch (err) {
          llmCounter.add(1, { 'llm.model': modelName, success: 'false' });
          throw err;
        }
      }
    );
  }

  // Build the traced wrapper. Use Object.defineProperty for onTokenUsage so the
  // get/set types don't run into exactOptionalPropertyTypes conflicts.
  const traced = {
    generateStructuredData<T>(prompt: string, schema: SchemaInput<T>): Promise<T> {
      return wrap('generateStructuredData', () => provider.generateStructuredData<T>(prompt, schema));
    },
    generateText(prompt: string, systemInstruction?: string): Promise<string> {
      return wrap('generateText', () => provider.generateText(prompt, systemInstruction));
    },
  } as LLMProvider;

  // Delegate onTokenUsage get/set to the inner provider to keep token tracking intact.
  Object.defineProperty(traced, 'onTokenUsage', {
    get: () => provider.onTokenUsage,
    set: (cb: LLMProvider['onTokenUsage']) => {
      if (cb !== undefined) {
        provider.onTokenUsage = cb;
      } else {
        delete (provider as any).onTokenUsage;
      }
    },
    enumerable: true,
    configurable: true,
  });

  if (provider.analyzeImage) {
    traced.analyzeImage = (prompt: string, imageBase64: string, mimeType?: string) =>
      wrap('analyzeImage', () => provider.analyzeImage!(prompt, imageBase64, mimeType));
  }

  return traced;
}
