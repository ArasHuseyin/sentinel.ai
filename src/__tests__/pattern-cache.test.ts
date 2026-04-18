import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemoryPatternCache,
  FilePatternCache,
  createPatternCache,
  buildPatternKey,
  type PatternSequence,
} from '../core/pattern-cache.js';
import type { PatternFingerprint } from '../core/pattern-signature.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seq(action: PatternSequence['action'] = 'click', name = 'Submit'): PatternSequence {
  return { action, role: 'button', name };
}

function tempFile(label: string): string {
  return path.join(os.tmpdir(), `sentinel-pattern-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

describe('buildPatternKey', () => {
  it('normalises instruction (trim + lowercase)', () => {
    expect(buildPatternKey('aria', 'button|', '  Click ME  ')).toBe('aria::button|::click me');
  });

  it('preserves fingerprint value verbatim', () => {
    const fp = 'combobox|aria-expanded|listbox,option';
    expect(buildPatternKey('aria', fp, 'select x')).toBe(`aria::${fp}::select x`);
  });
});

// ─── In-memory cache semantics ──────────────────────────────────────────────

describe('InMemoryPatternCache', () => {
  it('miss returns undefined and increments totalMisses', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    expect(cache.get(fp, 'click submit')).toBeUndefined();
    expect(cache.getStats().totalMisses).toBe(1);
    expect(cache.getStats().totalHits).toBe(0);
  });

  it('recordSuccess + get hits via aria layer', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    cache.recordSuccess(fp, 'click submit', seq());
    const entry = cache.get(fp, 'click submit');
    expect(entry).toBeDefined();
    expect(entry!.sequence.action).toBe('click');
    expect(cache.getStats().totalHits).toBe(1);
    expect(cache.getStats().hitsByLayer.aria).toBe(1);
  });

  it('lookup prefers library over aria over topology', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = {
      library: 'mui:button',
      aria: 'button||',
      topology: '0:button',
    };
    cache.recordSuccess(fp, 'click x', seq('click', 'X'));
    cache.get(fp, 'click x');
    // First layer to contain the key wins — library is checked first
    expect(cache.getStats().hitsByLayer.library).toBe(1);
    expect(cache.getStats().hitsByLayer.aria).toBe(0);
    expect(cache.getStats().hitsByLayer.topology).toBe(0);
  });

  it('falls through to aria when library is absent', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||', topology: '0:button' };
    cache.recordSuccess(fp, 'click', seq());
    cache.get(fp, 'click');
    expect(cache.getStats().hitsByLayer.aria).toBe(1);
  });

  it('falls through to topology when library + aria absent', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { topology: '0:div>1:input[text]' };
    cache.recordSuccess(fp, 'fill email', seq('fill', 'Email'));
    cache.get(fp, 'fill email');
    expect(cache.getStats().hitsByLayer.topology).toBe(1);
  });

  it('recordSuccess on existing entry increments successCount', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    cache.recordSuccess(fp, 'click', seq());
    cache.recordSuccess(fp, 'click', seq());
    cache.recordSuccess(fp, 'click', seq());
    const entry = cache.get(fp, 'click')!;
    expect(entry.successCount).toBe(3);
    expect(entry.failureCount).toBe(0);
  });

  it('recordFailure drops confidence below threshold and suppresses hits', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    cache.recordSuccess(fp, 'click', seq());       // 1 success
    cache.recordFailure(fp, 'click');              // 1/2 = 0.5 (exactly at threshold)
    cache.recordFailure(fp, 'click');              // 1/3 ≈ 0.33 (below)
    expect(cache.get(fp, 'click')).toBeUndefined();
    expect(cache.getStats().totalMisses).toBe(1);
  });

  it('entry at exactly 0.5 confidence is still considered a hit', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    cache.recordSuccess(fp, 'click', seq());
    cache.recordFailure(fp, 'click');              // 1 success, 1 failure = 0.5
    expect(cache.get(fp, 'click')).toBeDefined();
  });

  it('different instructions yield independent entries under the same fingerprint', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'textbox||' };
    cache.recordSuccess(fp, 'fill email', seq('fill', 'Email'));
    cache.recordSuccess(fp, 'fill password', seq('fill', 'Password'));
    expect(cache.get(fp, 'fill email')!.sequence.name).toBe('Email');
    expect(cache.get(fp, 'fill password')!.sequence.name).toBe('Password');
  });

  it('recordSuccess updates sequence to the latest (learning behaviour)', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    cache.recordSuccess(fp, 'click', seq('click', 'Old'));
    cache.recordSuccess(fp, 'click', seq('click', 'New'));
    expect(cache.get(fp, 'click')!.sequence.name).toBe('New');
  });

  it('clear() wipes store AND stats', () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    cache.recordSuccess(fp, 'click', seq());
    cache.get(fp, 'click');
    cache.clear();
    expect(cache.getStats().totalHits).toBe(0);
    expect(cache.get(fp, 'click')).toBeUndefined();
    expect(cache.getStats().totalHits).toBe(0); // miss shouldn't register after the immediate reset
    expect(cache.getStats().totalMisses).toBe(1);
  });

  it('LRU eviction triggers when maxEntries exceeded', () => {
    const cache = new InMemoryPatternCache(3);
    cache.recordSuccess({ aria: 'a||' }, 'op a', seq());
    cache.recordSuccess({ aria: 'b||' }, 'op b', seq());
    cache.recordSuccess({ aria: 'c||' }, 'op c', seq());
    // Touch 'a' so 'b' becomes oldest
    cache.get({ aria: 'a||' }, 'op a');
    cache.recordSuccess({ aria: 'd||' }, 'op d', seq());
    // 'b' should be evicted (oldest)
    expect(cache.get({ aria: 'a||' }, 'op a')).toBeDefined();
    expect(cache.get({ aria: 'b||' }, 'op b')).toBeUndefined();
    expect(cache.get({ aria: 'c||' }, 'op c')).toBeDefined();
    expect(cache.get({ aria: 'd||' }, 'op d')).toBeDefined();
  });
});

// ─── File persistence ───────────────────────────────────────────────────────

describe('FilePatternCache', () => {
  it('persists entries and stats across instantiations', () => {
    const file = tempFile('persist');
    try {
      const first = new FilePatternCache(file);
      first.recordSuccess({ aria: 'button||' }, 'click', seq());
      first.get({ aria: 'button||' }, 'click'); // triggers a hit

      const second = new FilePatternCache(file);
      const entry = second.get({ aria: 'button||' }, 'click');
      expect(entry).toBeDefined();
      expect(entry!.successCount).toBe(1);
      // Stats should carry over too — though the second get() adds its own
      expect(second.getStats().totalHits).toBeGreaterThanOrEqual(2);
    } finally {
      try { fs.unlinkSync(file); } catch { /* ok */ }
    }
  });

  it('creates parent directories on first persist', () => {
    const dir = path.join(os.tmpdir(), `sentinel-pc-${Date.now()}`, 'nested');
    const file = path.join(dir, 'patterns.json');
    try {
      const cache = new FilePatternCache(file);
      cache.recordSuccess({ aria: 'button||' }, 'click', seq());
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('tolerates missing file gracefully (empty cache)', () => {
    const file = tempFile('absent');
    try {
      const cache = new FilePatternCache(file);
      expect(cache.get({ aria: 'button||' }, 'click')).toBeUndefined();
    } finally {
      try { fs.unlinkSync(file); } catch { /* ok */ }
    }
  });

  it('tolerates malformed file gracefully', () => {
    const file = tempFile('malformed');
    try {
      fs.writeFileSync(file, '{not-valid-json');
      const cache = new FilePatternCache(file);
      expect(cache.get({ aria: 'button||' }, 'click')).toBeUndefined();
      // And writes fresh data on next success
      cache.recordSuccess({ aria: 'button||' }, 'click', seq());
      const raw = fs.readFileSync(file, 'utf-8');
      expect(JSON.parse(raw).version).toBe(1);
    } finally {
      try { fs.unlinkSync(file); } catch { /* ok */ }
    }
  });

  it('rejects files with unexpected version', () => {
    const file = tempFile('wrongver');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [] }));
      const cache = new FilePatternCache(file);
      expect(cache.get({ aria: 'button||' }, 'click')).toBeUndefined();
    } finally {
      try { fs.unlinkSync(file); } catch { /* ok */ }
    }
  });
});

// ─── Factory ────────────────────────────────────────────────────────────────

describe('createPatternCache factory', () => {
  it('returns null for false', () => {
    expect(createPatternCache(false)).toBeNull();
  });

  it('returns InMemoryPatternCache for true', () => {
    expect(createPatternCache(true)).toBeInstanceOf(InMemoryPatternCache);
  });

  it('returns FilePatternCache for string path', () => {
    const file = tempFile('factory');
    try {
      expect(createPatternCache(file)).toBeInstanceOf(FilePatternCache);
    } finally {
      try { fs.unlinkSync(file); } catch { /* ok */ }
    }
  });
});
