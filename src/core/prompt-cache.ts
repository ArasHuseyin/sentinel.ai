import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenerateOptions, LLMProvider, SchemaInput } from '../utils/llm-provider.js';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IPromptCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  clear(): void;
  readonly size: number;
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * djb2 hash of one or more values.
 * Fast, non-cryptographic, good enough for cache keys on strings up to ~100 KB.
 */
function hash(...parts: unknown[]): string {
  const input = parts
    .map(p => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join('\x00');
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h >>>= 0; // unsigned 32-bit
  }
  return h.toString(16);
}

export function buildPromptCacheKey(prompt: string, schema?: unknown): string {
  return hash(prompt, schema ?? '');
}

// ─── In-memory implementation ─────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 200;

export class InMemoryPromptCache implements IPromptCache {
  private store = new Map<string, unknown>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(key: string): unknown | undefined {
    return this.store.get(key);
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
    // Evict oldest when limit exceeded (Map preserves insertion order)
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ─── File-persisted implementation ───────────────────────────────────────────

export class FilePromptCache implements IPromptCache {
  private store = new Map<string, unknown>();
  private readonly filePath: string;
  private readonly maxEntries: number;

  constructor(filePath: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.filePath = path.resolve(filePath);
    this.maxEntries = maxEntries;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        this.store.set(k, v);
      }
    } catch {
      // File absent or malformed — start with empty cache
    }
  }

  private flush(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(Object.fromEntries(this.store), null, 2),
      'utf-8'
    );
  }

  get(key: string): unknown | undefined {
    return this.store.get(key);
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
    // Evict oldest entry when limit exceeded (Map preserves insertion order)
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.flush();
  }

  clear(): void {
    this.store.clear();
    this.flush();
  }

  get size(): number {
    return this.store.size;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPromptCache(option: false | true | string): IPromptCache | null {
  if (option === false) return null;
  if (option === true) return new InMemoryPromptCache();
  return new FilePromptCache(option);
}

// ─── Caching provider wrapper ─────────────────────────────────────────────────

/**
 * Wraps an `LLMProvider` with transparent prompt-response caching.
 * Cache hits skip the LLM call entirely (no tokens consumed, no cost).
 * `onTokenUsage` is forwarded to the original provider so token tracking
 * continues to work on cache misses.
 *
 * Only `generateStructuredData` and `generateText` are cached.
 * `analyzeImage` (vision) is always passed through — screenshots change.
 */
export function createCachingProvider(
  provider: LLMProvider,
  cache: IPromptCache
): LLMProvider {
  const caching = {
    // analyzeImage is vision — always live, never cached
    ...(provider.analyzeImage
      ? { analyzeImage: provider.analyzeImage.bind(provider) }
      : {}),

    async generateStructuredData<T>(
      prompt: string,
      schema: SchemaInput<T>,
      options?: GenerateOptions
    ): Promise<T> {
      // Include systemInstruction in the cache key so two callers that share
      // the same user prompt but different system prefixes don't collide.
      const key = buildPromptCacheKey(prompt, { schema, sys: options?.systemInstruction ?? '' });
      const cached = cache.get(key);
      if (cached !== undefined) return cached as T;
      const result = await provider.generateStructuredData<T>(prompt, schema, options);
      cache.set(key, result);
      return result;
    },

    async generateText(prompt: string, systemInstruction?: string): Promise<string> {
      const key = buildPromptCacheKey(prompt, systemInstruction ?? '');
      const cached = cache.get(key) as string | undefined;
      if (cached !== undefined) return cached;
      const result = await provider.generateText(prompt, systemInstruction);
      cache.set(key, result);
      return result;
    },
  } as LLMProvider;

  // Forward onTokenUsage get/set to the original provider so the Sentinel
  // token tracker keeps working after the wrapping. Use Object.defineProperty
  // to avoid exactOptionalPropertyTypes conflicts with the getter/setter.
  Object.defineProperty(caching, 'onTokenUsage', {
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

  return caching;
}
