import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  buildCacheKey,
  InMemoryLocatorCache,
  FileLocatorCache,
  createLocatorCache,
} from '../core/locator-cache.js';
import type { CachedLocator } from '../core/locator-cache.js';
import * as fs from 'node:fs';

// ─── buildCacheKey ────────────────────────────────────────────────────────────

describe('buildCacheKey', () => {
  it('strips known tracking params (utm_source, fbclid, etc.)', () => {
    const a = buildCacheKey('https://example.com/shop?utm_source=google&q=foo', 'click login');
    const b = buildCacheKey('https://example.com/shop?q=foo', 'click login');
    expect(a).toBe(b);
  });

  it('preserves meaningful query params', () => {
    const a = buildCacheKey('https://example.com/shop?q=foo', 'click login');
    const b = buildCacheKey('https://example.com/shop?q=bar', 'click login');
    expect(a).not.toBe(b);
  });

  it('preserves hash for hash-based routing', () => {
    const a = buildCacheKey('https://app.com/#/login', 'click submit');
    const b = buildCacheKey('https://app.com/#/dashboard', 'click submit');
    expect(a).not.toBe(b);
  });

  it('produces the same key for the same hash route', () => {
    const a = buildCacheKey('https://app.com/#/login', 'click submit');
    const b = buildCacheKey('https://app.com/#/login', 'click submit');
    expect(a).toBe(b);
  });

  it('lowercases the url', () => {
    const a = buildCacheKey('https://Example.COM/Path', 'click login');
    const b = buildCacheKey('https://example.com/path', 'click login');
    expect(a).toBe(b);
  });

  it('lowercases and trims the instruction', () => {
    const a = buildCacheKey('https://example.com', '  Click Login  ');
    const b = buildCacheKey('https://example.com', 'click login');
    expect(a).toBe(b);
  });

  it('produces different keys for different instructions', () => {
    const a = buildCacheKey('https://example.com', 'click login');
    const b = buildCacheKey('https://example.com', 'click register');
    expect(a).not.toBe(b);
  });

  it('handles malformed URLs gracefully', () => {
    expect(() => buildCacheKey('not-a-url', 'click')).not.toThrow();
    const key = buildCacheKey('not-a-url', 'click');
    expect(typeof key).toBe('string');
  });
});

// ─── InMemoryLocatorCache ─────────────────────────────────────────────────────

describe('InMemoryLocatorCache', () => {
  let cache: InMemoryLocatorCache;
  const entry: CachedLocator = { action: 'click', role: 'button', name: 'Login' };

  beforeEach(() => { cache = new InMemoryLocatorCache(); });

  it('returns undefined for an unknown key', () => {
    expect(cache.get('https://example.com', 'click login')).toBeUndefined();
  });

  it('stores and retrieves a CachedLocator', () => {
    cache.set('https://example.com', 'click login', entry);
    expect(cache.get('https://example.com', 'click login')).toEqual(entry);
  });

  it('strips only tracking params on get(), preserves meaningful ones', () => {
    cache.set('https://example.com/shop?utm_source=google', 'click add', entry);
    expect(cache.get('https://example.com/shop', 'click add')).toEqual(entry);
  });

  it('normalises instruction case on get()', () => {
    cache.set('https://example.com', 'click login', entry);
    expect(cache.get('https://example.com', 'Click Login')).toEqual(entry);
  });

  it('invalidates a stored entry', () => {
    cache.set('https://example.com', 'click login', entry);
    cache.invalidate('https://example.com', 'click login');
    expect(cache.get('https://example.com', 'click login')).toBeUndefined();
  });

  it('does not throw when invalidating a non-existent key', () => {
    expect(() => cache.invalidate('https://example.com', 'click login')).not.toThrow();
  });

  it('evicts the oldest entry when maxEntries is exceeded', () => {
    const small = new InMemoryLocatorCache(2);
    small.set('https://a.com', 'act 1', entry);
    small.set('https://b.com', 'act 2', entry);
    small.set('https://c.com', 'act 3', entry); // should evict 'act 1'
    expect(small.get('https://a.com', 'act 1')).toBeUndefined();
    expect(small.get('https://b.com', 'act 2')).toEqual(entry);
    expect(small.get('https://c.com', 'act 3')).toEqual(entry);
  });

  it('stores value field when present', () => {
    const withValue: CachedLocator = { action: 'fill', role: 'textbox', name: 'Email', value: 'user@test.com' };
    cache.set('https://example.com', 'fill email', withValue);
    expect(cache.get('https://example.com', 'fill email')).toEqual(withValue);
  });
});

// ─── FileLocatorCache ─────────────────────────────────────────────────────────

describe('FileLocatorCache', () => {
  const filePath = '/tmp/sentinel-locator-cache-test.json';
  const entry: CachedLocator = { action: 'click', role: 'button', name: 'Submit' };

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    jest.restoreAllMocks();
  });

  it('starts empty when file does not exist', () => {
    const cache = new FileLocatorCache(filePath);
    expect(cache.get('https://example.com', 'click submit')).toBeUndefined();
  });

  it('starts empty when file contains invalid JSON', () => {
    fs.writeFileSync(filePath, 'not-valid-json', 'utf-8');
    const cache = new FileLocatorCache(filePath);
    expect(cache.get('https://example.com', 'click submit')).toBeUndefined();
  });

  it('loads existing entries from file on construction', () => {
    const key = buildCacheKey('https://example.com', 'click submit');
    fs.writeFileSync(filePath, JSON.stringify({ [key]: entry }), 'utf-8');
    const cache = new FileLocatorCache(filePath);
    expect(cache.get('https://example.com', 'click submit')).toEqual(entry);
  });

  it('writes to file on set()', () => {
    const cache = new FileLocatorCache(filePath);
    cache.set('https://example.com', 'click submit', entry);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const key = buildCacheKey('https://example.com', 'click submit');
    expect(saved[key]).toEqual(entry);
  });

  it('writes to file on invalidate()', () => {
    const cache = new FileLocatorCache(filePath);
    cache.set('https://example.com', 'click submit', entry);
    cache.invalidate('https://example.com', 'click submit');
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const key = buildCacheKey('https://example.com', 'click submit');
    expect(saved[key]).toBeUndefined();
  });

  it('round-trips a CachedLocator with value through JSON', () => {
    const withValue: CachedLocator = { action: 'fill', role: 'textbox', name: 'Email', value: 'a@b.com' };
    const cache = new FileLocatorCache(filePath);
    cache.set('https://example.com', 'fill email', withValue);
    const reloaded = new FileLocatorCache(filePath);
    expect(reloaded.get('https://example.com', 'fill email')).toEqual(withValue);
  });
});

// ─── createLocatorCache ───────────────────────────────────────────────────────

describe('createLocatorCache', () => {
  it('returns null when option is false', () => {
    expect(createLocatorCache(false)).toBeNull();
  });

  it('returns InMemoryLocatorCache when option is true', () => {
    const cache = createLocatorCache(true);
    expect(cache).toBeInstanceOf(InMemoryLocatorCache);
  });

  it('returns FileLocatorCache when option is a string', () => {
    const cache = createLocatorCache('/tmp/sentinel-test-factory.json');
    expect(cache).toBeInstanceOf(FileLocatorCache);
    try { fs.unlinkSync('/tmp/sentinel-test-factory.json'); } catch { /* ok */ }
  });
});

// ─── ActionEngine integration ─────────────────────────────────────────────────

import { ActionEngine } from '../api/act.js';
import type { ILocatorCache } from '../core/locator-cache.js';

function makeMockPage() {
  return {
    evaluate: jest.fn<any>().mockResolvedValue(undefined),
    waitForNavigation: jest.fn<any>().mockResolvedValue(undefined),
    waitForLoadState: jest.fn<any>().mockResolvedValue(undefined),
    mouse: { click: jest.fn<any>().mockResolvedValue(undefined), wheel: jest.fn<any>().mockResolvedValue(undefined) },
    keyboard: { press: jest.fn<any>().mockResolvedValue(undefined), type: jest.fn<any>().mockResolvedValue(undefined) },
    viewportSize: jest.fn<any>().mockReturnValue({ width: 1280, height: 720 }),
    url: jest.fn<any>().mockReturnValue('https://example.com/page'),
  } as any;
}

function makeMockStateParser(elements: any[] = []) {
  return {
    parse: jest.fn<any>().mockResolvedValue({
      url: 'https://example.com/page',
      title: 'Test',
      elements,
    }),
    invalidateCache: jest.fn<any>(),
  } as any;
}

function makeMockLLM(decision: any) {
  return {
    generateStructuredData: jest.fn<any>().mockResolvedValue(decision),
  } as any;
}

function makeMockCache(): jest.Mocked<ILocatorCache> {
  return {
    get: jest.fn<any>().mockReturnValue(undefined),
    set: jest.fn<any>(),
    invalidate: jest.fn<any>(),
  };
}

describe('ActionEngine with LocatorCache', () => {
  it('calls LLM on first invocation', async () => {
    const elements = [{ id: 0, role: 'button', name: 'Login', boundingClientRect: { x: 10, y: 10, width: 100, height: 40 } }];
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'test' });
    const cache = makeMockCache();
    const engine = new ActionEngine(makeMockPage(), makeMockStateParser(elements), llm, undefined, 100, cache);

    await engine.act('click login button');

    expect(llm.generateStructuredData).toHaveBeenCalledTimes(1);
  });

  it('skips LLM on second call when cache returns a hit', async () => {
    const elements = [{ id: 0, role: 'button', name: 'Login', boundingClientRect: { x: 10, y: 10, width: 100, height: 40 } }];
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'test' });
    const cache = makeMockCache();
    // Pre-populate cache with a hit for the second call
    cache.get.mockReturnValue({ action: 'click', role: 'button', name: 'Login' });

    const engine = new ActionEngine(makeMockPage(), makeMockStateParser(elements), llm, undefined, 100, cache);
    const result = await engine.act('click login button');

    expect(llm.generateStructuredData).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain('cached');
  });

  it('populates cache after successful LLM call', async () => {
    const elements = [{ id: 0, role: 'button', name: 'Login', boundingClientRect: { x: 10, y: 10, width: 100, height: 40 } }];
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'test' });
    const cache = makeMockCache();
    const engine = new ActionEngine(makeMockPage(), makeMockStateParser(elements), llm, undefined, 100, cache);

    await engine.act('click login button');

    expect(cache.set).toHaveBeenCalledWith(
      'https://example.com/page',
      'click login button',
      { action: 'click', role: 'button', name: 'Login' }
    );
  });

  it('invalidates entry when cached element is gone from state', async () => {
    // State has no matching element
    const elements = [{ id: 0, role: 'link', name: 'Home', boundingClientRect: { x: 0, y: 0, width: 50, height: 20 } }];
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'fallback' });
    const cache = makeMockCache();
    cache.get.mockReturnValue({ action: 'click', role: 'button', name: 'Login' }); // stale entry

    const engine = new ActionEngine(makeMockPage(), makeMockStateParser(elements), llm, undefined, 100, cache);
    await engine.act('click login button');

    expect(cache.invalidate).toHaveBeenCalledWith('https://example.com/page', 'click login button');
    // LLM was called because cache was invalidated
    expect(llm.generateStructuredData).toHaveBeenCalledTimes(1);
  });

  it('invalidates entry and falls back to LLM when cached action throws', async () => {
    const page = makeMockPage();
    page.mouse.click.mockRejectedValue(new Error('element detached') as never);

    const elements = [{ id: 0, role: 'button', name: 'Login', boundingClientRect: { x: 10, y: 10, width: 100, height: 40 } }];
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'test' });
    const cache = makeMockCache();
    cache.get.mockReturnValue({ action: 'click', role: 'button', name: 'Login' });

    const engine = new ActionEngine(page, makeMockStateParser(elements), llm, undefined, 100, cache);
    await engine.act('click login button');

    expect(cache.invalidate).toHaveBeenCalled();
    expect(llm.generateStructuredData).toHaveBeenCalledTimes(1);
  });

  it('does not use cache when locatorCache is null', async () => {
    const elements = [{ id: 0, role: 'button', name: 'Login', boundingClientRect: { x: 10, y: 10, width: 100, height: 40 } }];
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'test' });
    const engine = new ActionEngine(makeMockPage(), makeMockStateParser(elements), llm, undefined, 100, null);

    await engine.act('click login button');
    await engine.act('click login button');

    expect(llm.generateStructuredData).toHaveBeenCalledTimes(2);
  });

  it('does not cache scroll-without-target actions', async () => {
    const llm = makeMockLLM({ elementId: 0, action: 'scroll-down', reasoning: 'scroll' });
    const cache = makeMockCache();
    const engine = new ActionEngine(makeMockPage(), makeMockStateParser([]), llm, undefined, 100, cache);

    await engine.act('scroll down');

    expect(cache.set).not.toHaveBeenCalled();
  });

  it('preserves value in cached entry for fill actions', async () => {
    const elements = [{ id: 0, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 10, width: 200, height: 40 } }];
    const llm = makeMockLLM({ elementId: 0, action: 'fill', value: 'user@test.com', reasoning: 'fill' });
    const cache = makeMockCache();
    const engine = new ActionEngine(makeMockPage(), makeMockStateParser(elements), llm, undefined, 100, cache);

    await engine.act('fill email field');

    expect(cache.set).toHaveBeenCalledWith(
      'https://example.com/page',
      'fill email field',
      { action: 'fill', role: 'textbox', name: 'Email', value: 'user@test.com' }
    );
  });
});
