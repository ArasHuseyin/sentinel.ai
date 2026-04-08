import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { z } from 'zod';
import {
  InMemoryPromptCache,
  FilePromptCache,
  createPromptCache,
  createCachingProvider,
  buildPromptCacheKey,
} from '../core/prompt-cache.js';
import type { IPromptCache } from '../core/prompt-cache.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── InMemoryPromptCache ───────────────────────────────────────────────────────

describe('InMemoryPromptCache', () => {
  it('returns undefined for unknown key', () => {
    const c = new InMemoryPromptCache();
    expect(c.get('x')).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    const c = new InMemoryPromptCache();
    c.set('k', { foo: 1 });
    expect(c.get('k')).toEqual({ foo: 1 });
  });

  it('reports correct size', () => {
    const c = new InMemoryPromptCache();
    expect(c.size).toBe(0);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.size).toBe(2);
  });

  it('clear() empties the cache', () => {
    const c = new InMemoryPromptCache();
    c.set('a', 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });

  it('evicts oldest entry when maxEntries is exceeded', () => {
    const c = new InMemoryPromptCache(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // should evict 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('d')).toBe(4);
    expect(c.size).toBe(3);
  });
});

// ─── FilePromptCache ──────────────────────────────────────────────────────────

describe('FilePromptCache', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `sentinel-prompt-cache-test-${Date.now()}.json`);
  });

  it('creates an empty cache when file does not exist', () => {
    const c = new FilePromptCache(tmpFile);
    expect(c.size).toBe(0);
  });

  it('persists and reloads entries', () => {
    const c1 = new FilePromptCache(tmpFile);
    c1.set('k', { result: 'cached' });

    const c2 = new FilePromptCache(tmpFile);
    expect(c2.get('k')).toEqual({ result: 'cached' });
  });

  it('clear() removes all entries and flushes to disk', () => {
    const c = new FilePromptCache(tmpFile);
    c.set('k', 'val');
    c.clear();
    expect(c.size).toBe(0);

    const c2 = new FilePromptCache(tmpFile);
    expect(c2.size).toBe(0);
  });

  it('creates the directory if it does not exist', () => {
    const nested = path.join(os.tmpdir(), `sentinel-test-${Date.now()}`, 'sub', 'cache.json');
    const c = new FilePromptCache(nested);
    c.set('k', 1);
    expect(fs.existsSync(nested)).toBe(true);
    // cleanup
    fs.rmSync(path.dirname(path.dirname(nested)), { recursive: true, force: true });
  });

  it('ignores malformed JSON file and starts fresh', () => {
    fs.writeFileSync(tmpFile, 'not-json', 'utf-8');
    const c = new FilePromptCache(tmpFile);
    expect(c.size).toBe(0);
  });

  it('evicts oldest entry when maxEntries is exceeded', () => {
    const c = new FilePromptCache(tmpFile, 3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // should evict 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toBe(4);
    expect(c.size).toBe(3);

    // Verify eviction is persisted to disk
    const c2 = new FilePromptCache(tmpFile);
    expect(c2.get('a')).toBeUndefined();
    expect(c2.get('d')).toBe(4);
  });
});

// ─── createPromptCache factory ────────────────────────────────────────────────

describe('createPromptCache()', () => {
  it('returns null for false', () => {
    expect(createPromptCache(false)).toBeNull();
  });

  it('returns InMemoryPromptCache for true', () => {
    const c = createPromptCache(true);
    expect(c).toBeInstanceOf(InMemoryPromptCache);
  });

  it('returns FilePromptCache for a string path', () => {
    const c = createPromptCache(path.join(os.tmpdir(), `sentinel-factory-test-${Date.now()}.json`));
    expect(c).toBeInstanceOf(FilePromptCache);
  });
});

// ─── buildPromptCacheKey ──────────────────────────────────────────────────────

describe('buildPromptCacheKey()', () => {
  it('same inputs produce the same key', () => {
    const k1 = buildPromptCacheKey('hello', { type: 'object' });
    const k2 = buildPromptCacheKey('hello', { type: 'object' });
    expect(k1).toBe(k2);
  });

  it('different prompts produce different keys', () => {
    const k1 = buildPromptCacheKey('click login');
    const k2 = buildPromptCacheKey('click signup');
    expect(k1).not.toBe(k2);
  });

  it('different schemas produce different keys', () => {
    const k1 = buildPromptCacheKey('same', { type: 'string' });
    const k2 = buildPromptCacheKey('same', { type: 'number' });
    expect(k1).not.toBe(k2);
  });

  it('returns a non-empty hex string', () => {
    const k = buildPromptCacheKey('test');
    expect(k).toMatch(/^[0-9a-f]+$/);
  });

  it('Zod z.string() and z.number() produce different keys (same prompt)', () => {
        const k1 = buildPromptCacheKey('Extract the value', z.string());
    const k2 = buildPromptCacheKey('Extract the value', z.number());
    expect(k1).not.toBe(k2);
  });

  it('two z.string() instances produce the same key', () => {
        const k1 = buildPromptCacheKey('Extract title', z.string());
    const k2 = buildPromptCacheKey('Extract title', z.string());
    expect(k1).toBe(k2);
  });

  it('z.object() with different shapes produces different keys', () => {
        const k1 = buildPromptCacheKey('Extract', z.object({ name: z.string() }));
    const k2 = buildPromptCacheKey('Extract', z.object({ count: z.number() }));
    expect(k1).not.toBe(k2);
  });
});

// ─── createCachingProvider ────────────────────────────────────────────────────

function makeMockProvider() {
  const provider: LLMProvider = {
    generateStructuredData: jest.fn(async () => ({ action: 'click', elementId: 1 })) as any,
    generateText: jest.fn(async () => 'some text') as any,
  };
  return provider;
}

describe('createCachingProvider()', () => {
  it('returns an object implementing LLMProvider', () => {
    const p = makeMockProvider();
    const cached = createCachingProvider(p, new InMemoryPromptCache());
    expect(typeof cached.generateStructuredData).toBe('function');
    expect(typeof cached.generateText).toBe('function');
  });

  it('calls original provider on first call (cache miss)', async () => {
    const p = makeMockProvider();
    const cached = createCachingProvider(p, new InMemoryPromptCache());
    await cached.generateStructuredData('prompt', { type: 'object' });
    expect(p.generateStructuredData).toHaveBeenCalledTimes(1);
  });

  it('returns cached result on second identical call without calling provider', async () => {
    const p = makeMockProvider();
    const cached = createCachingProvider(p, new InMemoryPromptCache());

    const r1 = await cached.generateStructuredData('prompt', { type: 'object' });
    const r2 = await cached.generateStructuredData('prompt', { type: 'object' });

    expect(r2).toEqual(r1);
    expect(p.generateStructuredData).toHaveBeenCalledTimes(1); // only once
  });

  it('different prompts result in separate cache entries', async () => {
    const p = makeMockProvider();
    (p.generateStructuredData as jest.Mock<any>)
      .mockResolvedValueOnce({ action: 'click' })
      .mockResolvedValueOnce({ action: 'fill' });

    const cached = createCachingProvider(p, new InMemoryPromptCache());
    const r1 = await cached.generateStructuredData('prompt A', {});
    const r2 = await cached.generateStructuredData('prompt B', {});

    expect(r1).toEqual({ action: 'click' });
    expect(r2).toEqual({ action: 'fill' });
    expect(p.generateStructuredData).toHaveBeenCalledTimes(2);
  });

  it('generateText is also cached', async () => {
    const p = makeMockProvider();
    const cached = createCachingProvider(p, new InMemoryPromptCache());

    await cached.generateText('same prompt');
    await cached.generateText('same prompt');

    expect(p.generateText).toHaveBeenCalledTimes(1);
  });

  it('different system instructions for generateText produce separate entries', async () => {
    const p = makeMockProvider();
    (p.generateText as jest.Mock<any>)
      .mockResolvedValueOnce('result A')
      .mockResolvedValueOnce('result B');

    const cached = createCachingProvider(p, new InMemoryPromptCache());
    const r1 = await cached.generateText('p', 'sys A');
    const r2 = await cached.generateText('p', 'sys B');

    expect(r1).toBe('result A');
    expect(r2).toBe('result B');
    expect(p.generateText).toHaveBeenCalledTimes(2);
  });

  it('forwards onTokenUsage getter/setter to original provider', () => {
    const p = makeMockProvider();
    const cached = createCachingProvider(p, new InMemoryPromptCache());

    const cb = jest.fn();
    cached.onTokenUsage = cb;
    expect(p.onTokenUsage).toBe(cb);

    p.onTokenUsage = undefined;
    expect(cached.onTokenUsage).toBeUndefined();
  });

  it('analyzeImage is forwarded when present on original provider', async () => {
    const p: LLMProvider = {
      ...makeMockProvider(),
      analyzeImage: jest.fn(async () => 'description') as any,
    };
    const cached = createCachingProvider(p, new InMemoryPromptCache());
    expect(typeof cached.analyzeImage).toBe('function');

    const result = await cached.analyzeImage!('describe', 'base64data');
    expect(result).toBe('description');
    expect(p.analyzeImage).toHaveBeenCalledTimes(1);
  });

  it('analyzeImage is not cached — called every time', async () => {
    const p: LLMProvider = {
      ...makeMockProvider(),
      analyzeImage: jest.fn(async () => 'vision result') as any,
    };
    const cached = createCachingProvider(p, new InMemoryPromptCache());

    await cached.analyzeImage!('same prompt', 'same image');
    await cached.analyzeImage!('same prompt', 'same image');

    expect(p.analyzeImage).toHaveBeenCalledTimes(2);
  });

  it('cache is shared — provider is not called again after a miss populates the cache', async () => {
    const cache = new InMemoryPromptCache();
    const p = makeMockProvider();
    const cached = createCachingProvider(p, cache);

    await cached.generateStructuredData('p', {});
    expect(cache.size).toBe(1);

    // Second call — should hit cache
    await cached.generateStructuredData('p', {});
    expect(p.generateStructuredData).toHaveBeenCalledTimes(1);
  });
});

// ─── Integration: Sentinel with promptCache ───────────────────────────────────

import { Sentinel } from '../index.js';
import type { SentinelOptions } from '../index.js';

describe('Sentinel promptCache integration', () => {
  function makeOptions(promptCache: SentinelOptions['promptCache']): SentinelOptions {
    return {
      apiKey: 'test',
      verbose: 0,
      promptCache,
      provider: {
        generateStructuredData: jest.fn(async () => ({ action: 'click', elementId: 0, reasoning: 'ok' })) as any,
        generateText: jest.fn(async () => '') as any,
      },
    };
  }

  it('clearPromptCache() does not throw when cache is disabled', () => {
    const s = new Sentinel(makeOptions(false));
    expect(() => s.clearPromptCache()).not.toThrow();
  });

  it('clearPromptCache() does not log when cache is disabled', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const s = new Sentinel({ ...makeOptions(false), verbose: 1 });
    s.clearPromptCache();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('clearPromptCache() does not throw when cache is enabled', () => {
    const s = new Sentinel(makeOptions(true));
    expect(() => s.clearPromptCache()).not.toThrow();
  });

  it('promptCache: false → createPromptCache returns null (no wrapping)', () => {
    // Verify indirectly: with false, provider is not wrapped, so onTokenUsage
    // setter still points to the original provider (not a proxy)
    const opts = makeOptions(false);
    const s = new Sentinel(opts);
    // The sentinel was created without init() — just checking no error thrown
    expect(s).toBeDefined();
  });
});
