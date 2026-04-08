import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActionType } from '../api/act.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CachedLocator {
  action: ActionType;
  role: string;
  name: string;
  value?: string;
}

export interface ILocatorCache {
  get(url: string, instruction: string): CachedLocator | undefined;
  set(url: string, instruction: string, entry: CachedLocator): void;
  invalidate(url: string, instruction: string): void;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

// UTM and other analytics params that don't affect page identity
const IGNORED_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'ref', 'source',
]);

function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Remove tracking-only query params; keep all others (they may affect page content)
    for (const key of [...u.searchParams.keys()]) {
      if (IGNORED_PARAMS.has(key)) u.searchParams.delete(key);
    }
    // Preserve hash — hash-based routers (e.g. /#/login vs /#/dashboard) use it for routing
    const query = u.searchParams.toString();
    const base = (u.origin + u.pathname).toLowerCase();
    const suffix = [query ? `?${query}` : '', u.hash ? u.hash.toLowerCase() : ''].join('');
    return base + suffix;
  } catch {
    return raw.toLowerCase();
  }
}

export function buildCacheKey(url: string, instruction: string): string {
  return `${normaliseUrl(url)}::${instruction.toLowerCase().trim()}`;
}

// ─── In-memory implementation ─────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 500;

export class InMemoryLocatorCache implements ILocatorCache {
  private store = new Map<string, CachedLocator>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(url: string, instruction: string): CachedLocator | undefined {
    return this.store.get(buildCacheKey(url, instruction));
  }

  set(url: string, instruction: string, entry: CachedLocator): void {
    const key = buildCacheKey(url, instruction);
    this.store.set(key, entry);
    // Evict oldest entry when limit is exceeded (Map preserves insertion order)
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  invalidate(url: string, instruction: string): void {
    this.store.delete(buildCacheKey(url, instruction));
  }
}

// ─── File-persisted implementation ───────────────────────────────────────────

export class FileLocatorCache implements ILocatorCache {
  private store = new Map<string, CachedLocator>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, CachedLocator>;
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
    fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.store), null, 2), 'utf-8');
  }

  get(url: string, instruction: string): CachedLocator | undefined {
    return this.store.get(buildCacheKey(url, instruction));
  }

  set(url: string, instruction: string, entry: CachedLocator): void {
    this.store.set(buildCacheKey(url, instruction), entry);
    this.flush();
  }

  invalidate(url: string, instruction: string): void {
    this.store.delete(buildCacheKey(url, instruction));
    this.flush();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLocatorCache(option: false | true | string): ILocatorCache | null {
  if (option === false) return null;
  if (option === true) return new InMemoryLocatorCache();
  return new FileLocatorCache(option);
}
