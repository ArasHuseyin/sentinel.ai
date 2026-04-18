import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActionType } from '../api/act.js';
import type { PatternFingerprint } from './pattern-signature.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A canonical interaction sequence that worked for a widget fingerprint.
 * Matches the shape of the existing `CachedLocator` so the two caches
 * can interoperate without conversion.
 */
export interface PatternSequence {
  action: ActionType;
  role: string;
  name: string;
  value?: string;
}

/**
 * Stored pattern + confidence metadata. Confidence = successes / (successes +
 * failures). Entries with confidence below `MIN_CONFIDENCE` are not returned
 * on lookup but kept on disk so they can recover if future runs succeed.
 */
export interface StoredPattern {
  sequence: PatternSequence;
  successCount: number;
  failureCount: number;
  firstSeenMs: number;
  lastUsedMs: number;
}

/** Priority order used for lookup — library is cheapest & most specific. */
export type FingerprintLayer = 'library' | 'aria' | 'topology';

export interface PatternCacheStats {
  totalHits: number;
  totalMisses: number;
  hitsByLayer: Record<FingerprintLayer, number>;
}

export interface IPatternCache {
  /**
   * Looks up a pattern for the given fingerprint + instruction. Layers
   * are tried in order of specificity: library → aria → topology. The
   * first hit wins. Returns `undefined` on miss.
   */
  get(fingerprint: PatternFingerprint, instruction: string): StoredPattern | undefined;

  /**
   * Records a successful interaction. Writes to every layer in the
   * fingerprint simultaneously so future lookups can hit via any of
   * them. Increments `successCount` on existing entries.
   */
  recordSuccess(
    fingerprint: PatternFingerprint,
    instruction: string,
    sequence: PatternSequence
  ): void;

  /** Records a failure for all matching layers — decays confidence. */
  recordFailure(fingerprint: PatternFingerprint, instruction: string): void;

  /** Hit-rate stats. Zero-initialized; monotonically increasing. */
  getStats(): PatternCacheStats;

  /** Testing / admin use. */
  clear(): void;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

/** Compose a stable store key from a layer, its value, and the instruction. */
export function buildPatternKey(
  layer: FingerprintLayer,
  fingerprintValue: string,
  instruction: string
): string {
  return `${layer}::${fingerprintValue}::${instruction.trim().toLowerCase()}`;
}

/**
 * Minimum confidence below which a stored pattern is considered unreliable
 * and NOT returned on lookup. Two failures in a row against one success
 * already drop below 0.5, triggering the automatic LLM fallback.
 */
const MIN_CONFIDENCE = 0.5;

function confidence(p: StoredPattern): number {
  const total = p.successCount + p.failureCount;
  if (total === 0) return 0;
  return p.successCount / total;
}

const DEFAULT_MAX_ENTRIES = 2000;

// ─── Core implementation (shared by memory + file variants) ─────────────────

abstract class BasePatternCache implements IPatternCache {
  protected store = new Map<string, StoredPattern>();
  protected stats: PatternCacheStats = {
    totalHits: 0,
    totalMisses: 0,
    hitsByLayer: { library: 0, aria: 0, topology: 0 },
  };
  protected readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  protected abstract persist(): void;

  /** Layers tried in order of specificity — fastest / most-specific first. */
  private lookupOrder(fp: PatternFingerprint): Array<[FingerprintLayer, string]> {
    const out: Array<[FingerprintLayer, string]> = [];
    if (fp.library) out.push(['library', fp.library]);
    if (fp.aria) out.push(['aria', fp.aria]);
    if (fp.topology) out.push(['topology', fp.topology]);
    return out;
  }

  get(fingerprint: PatternFingerprint, instruction: string): StoredPattern | undefined {
    for (const [layer, value] of this.lookupOrder(fingerprint)) {
      const key = buildPatternKey(layer, value, instruction);
      const entry = this.store.get(key);
      if (!entry) continue;
      if (confidence(entry) < MIN_CONFIDENCE) continue;
      entry.lastUsedMs = Date.now();
      // Re-insert to move to the end of Map iteration order. JS Map
      // iterates in insertion order, so this gives us a clean LRU queue
      // that doesn't depend on wall-clock precision (Date.now() collides
      // at sub-millisecond call rates).
      this.store.delete(key);
      this.store.set(key, entry);
      this.stats.totalHits++;
      this.stats.hitsByLayer[layer]++;
      // Persist the lastUsed bump so disk ordering stays fresh across restarts
      this.persist();
      return entry;
    }
    this.stats.totalMisses++;
    return undefined;
  }

  recordSuccess(
    fingerprint: PatternFingerprint,
    instruction: string,
    sequence: PatternSequence
  ): void {
    const now = Date.now();
    for (const [layer, value] of this.lookupOrder(fingerprint)) {
      const key = buildPatternKey(layer, value, instruction);
      const existing = this.store.get(key);
      if (existing) {
        existing.successCount++;
        existing.lastUsedMs = now;
        // Update sequence to the latest successful one — later interactions
        // may have used a better locator path than earlier attempts.
        existing.sequence = sequence;
      } else {
        this.store.set(key, {
          sequence,
          successCount: 1,
          failureCount: 0,
          firstSeenMs: now,
          lastUsedMs: now,
        });
      }
    }
    this.evictIfOversized();
    this.persist();
  }

  recordFailure(fingerprint: PatternFingerprint, instruction: string): void {
    for (const [layer, value] of this.lookupOrder(fingerprint)) {
      const key = buildPatternKey(layer, value, instruction);
      const existing = this.store.get(key);
      if (existing) {
        existing.failureCount++;
        existing.lastUsedMs = Date.now();
      }
    }
    this.persist();
  }

  getStats(): PatternCacheStats {
    return {
      totalHits: this.stats.totalHits,
      totalMisses: this.stats.totalMisses,
      hitsByLayer: { ...this.stats.hitsByLayer },
    };
  }

  clear(): void {
    this.store.clear();
    this.stats = {
      totalHits: 0,
      totalMisses: 0,
      hitsByLayer: { library: 0, aria: 0, topology: 0 },
    };
    this.persist();
  }

  /**
   * LRU eviction via Map iteration order. Each `get()` re-inserts the hit
   * entry at the end, so the first entry returned by `keys().next()` is
   * the least-recently-touched one. Deterministic and independent of the
   * clock — no sub-millisecond collisions.
   */
  private evictIfOversized(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}

// ─── In-memory variant ──────────────────────────────────────────────────────

export class InMemoryPatternCache extends BasePatternCache {
  protected persist(): void { /* no-op */ }
}

// ─── File-persisted variant ─────────────────────────────────────────────────

interface PatternCacheFile {
  version: 1;
  entries: Array<[string, StoredPattern]>;
  stats: PatternCacheStats;
}

export class FilePatternCache extends BasePatternCache {
  private readonly filePath: string;

  constructor(filePath: string, maxEntries?: number) {
    super(maxEntries);
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PatternCacheFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return;
      for (const [key, value] of parsed.entries) {
        // Shallow validation — tolerate forward-compat additions
        if (typeof key === 'string' && value && typeof value === 'object' &&
            typeof value.successCount === 'number') {
          this.store.set(key, value);
        }
      }
      if (parsed.stats) {
        this.stats = {
          totalHits: parsed.stats.totalHits ?? 0,
          totalMisses: parsed.stats.totalMisses ?? 0,
          hitsByLayer: {
            library: parsed.stats.hitsByLayer?.library ?? 0,
            aria: parsed.stats.hitsByLayer?.aria ?? 0,
            topology: parsed.stats.hitsByLayer?.topology ?? 0,
          },
        };
      }
    } catch {
      // Missing or malformed file — start fresh. Persisted data reappears
      // on the next successful write, so a single bad file doesn't brick
      // the cache.
    }
  }

  protected persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const snapshot: PatternCacheFile = {
        version: 1,
        entries: Array.from(this.store.entries()),
        stats: this.stats,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch {
      // Persistence failures must not abort the action — in-memory store
      // remains authoritative for the duration of the run.
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createPatternCache(option: false | true | string): IPatternCache | null {
  if (option === false) return null;
  if (option === true) return new InMemoryPatternCache();
  return new FilePatternCache(option);
}
