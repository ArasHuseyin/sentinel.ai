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
  /** Forces any pending writes to disk and waits for completion. No-op for in-memory caches. */
  flush?(): Promise<void>;
  /** Releases resources (timers, exit handlers) and performs a final sync flush. */
  close?(): void;
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

export interface FileLocatorCacheOptions {
  /** Debounce window in ms for coalescing rapid set/invalidate into a single disk write. Default 150. */
  debounceMs?: number;
}

/**
 * Disk-backed cache with debounced, atomic writes.
 *
 * `set()` / `invalidate()` return immediately and schedule a write `debounceMs` later
 * (150ms default). Writes go to `<filePath>.<pid>.tmp` and are then `rename`d into
 * place — the rename is atomic on POSIX and NTFS, so readers never see a partial file.
 * A `beforeExit` handler performs a final sync flush so debounced writes aren't lost
 * when the process terminates normally. Call `flush()` to wait for pending writes,
 * or `close()` to perform a final sync flush and detach the exit handler.
 */
export class FileLocatorCache implements ILocatorCache {
  private store = new Map<string, CachedLocator>();
  private readonly filePath: string;
  private readonly debounceMs: number;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush: Promise<void> = Promise.resolve();
  private closed = false;
  private exitHandler: (() => void) | null = null;

  constructor(filePath: string, options: FileLocatorCacheOptions = {}) {
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 150;
    this.load();
    this.exitHandler = () => { this.flushSync(); };
    process.once('beforeExit', this.exitHandler);
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

  private schedule(): void {
    if (this.closed) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.pendingFlush = this.pendingFlush
        .catch(() => { /* reset chain; next write starts fresh */ })
        .then(() => this.writeAtomic());
    }, this.debounceMs);
    // Don't keep the event loop alive just to flush the cache — the exit hook handles it.
    this.writeTimer.unref?.();
  }

  private async writeAtomic(): Promise<void> {
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(Object.fromEntries(this.store), null, 2);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tmpPath, payload, 'utf-8');
      await fs.promises.rename(tmpPath, this.filePath);
    } catch (err) {
      try { await fs.promises.unlink(tmpPath); } catch { /* stale tmp already gone */ }
      throw err;
    }
  }

  private flushSync(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.sync.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(this.store), null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Best-effort; final-flush errors are swallowed to avoid blocking process exit
    }
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pendingFlush = this.pendingFlush
      .catch(() => { /* reset */ })
      .then(() => this.writeAtomic());
    return this.pendingFlush;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.exitHandler) {
      process.removeListener('beforeExit', this.exitHandler);
      this.exitHandler = null;
    }
    this.flushSync();
  }

  get(url: string, instruction: string): CachedLocator | undefined {
    return this.store.get(buildCacheKey(url, instruction));
  }

  set(url: string, instruction: string, entry: CachedLocator): void {
    this.store.set(buildCacheKey(url, instruction), entry);
    this.schedule();
  }

  invalidate(url: string, instruction: string): void {
    this.store.delete(buildCacheKey(url, instruction));
    this.schedule();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLocatorCache(option: false | true | string): ILocatorCache | null {
  if (option === false) return null;
  if (option === true) return new InMemoryLocatorCache();
  return new FileLocatorCache(option);
}
