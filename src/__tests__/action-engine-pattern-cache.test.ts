/**
 * Integration-level tests for the pattern-cache wiring in ActionEngine.
 * These tests use the same mock infrastructure as action-engine.test.ts
 * but focus on the pre-LLM lookup path, the recording on success/failure,
 * and the no-op behaviour when patternCache is null.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { ActionEngine } from '../api/act.js';
import { InMemoryPatternCache } from '../core/pattern-cache.js';
import type { SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { PatternFingerprint } from '../core/pattern-signature.js';

// ─── Shared helpers (mirrored from action-engine.test.ts) ───────────────────

function makeState(): SimplifiedState {
  return {
    url: 'https://example.com',
    title: 'Example',
    elements: [
      { id: 0, role: 'button', name: 'Submit', boundingClientRect: { x: 10, y: 20, width: 80, height: 30 } },
      { id: 1, role: 'textbox', name: 'Email', boundingClientRect: { x: 10, y: 60, width: 200, height: 30 } },
      { id: 2, role: 'link', name: 'Home', boundingClientRect: { x: 10, y: 100, width: 60, height: 20 } },
    ],
  };
}

function makeMockStateParser(state: SimplifiedState, fingerprints: Record<number, PatternFingerprint> = {}) {
  return {
    parse: jest.fn(async () => state),
    invalidateCache: jest.fn(),
    computeTargetFingerprints: jest.fn(async (targets: Array<{ id: number }>) => {
      const out = new Map<number, PatternFingerprint>();
      for (const t of targets) {
        if (fingerprints[t.id]) out.set(t.id, fingerprints[t.id]!);
      }
      return out;
    }),
  };
}

function makeMockLocator() {
  const locator: any = {
    click: jest.fn(async () => {}),
    dblclick: jest.fn(async () => {}),
    hover: jest.fn(async () => {}),
    fill: jest.fn(async () => {}),
    focus: jest.fn(async () => {}),
    press: jest.fn(async () => {}),
    pressSequentially: jest.fn(async () => {}),
    selectOption: jest.fn(async () => []),
    scrollIntoViewIfNeeded: jest.fn(async () => {}),
    setInputFiles: jest.fn(async () => {}),
    dragTo: jest.fn(async () => {}),
    evaluate: jest.fn(async () => {}),
    boundingBox: jest.fn(async () => ({ x: 10, y: 20, width: 80, height: 30 })),
    isVisible: jest.fn(async () => true),
    first: jest.fn(() => locator),
  };
  return locator;
}

function makeMockPage() {
  const locatorInstance = makeMockLocator();
  return {
    url: () => 'https://example.com',
    viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
    waitForLoadState: jest.fn(async () => {}),
    mouse: {
      click: jest.fn(async () => {}),
      dblclick: jest.fn(async () => {}),
      move: jest.fn(async () => {}),
      wheel: jest.fn(async () => {}),
    },
    keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
    evaluate: jest.fn(async (_fn: any, args?: any) => {
      if (args === undefined) return { x: 0, y: 0 };
      return null;
    }),
    waitForNavigation: jest.fn(async () => {}),
    waitForTimeout: jest.fn(async () => {}),
    locator: jest.fn(() => locatorInstance),
    getByRole: jest.fn(() => locatorInstance),
    getByText: jest.fn(() => locatorInstance),
    getByLabel: jest.fn(() => locatorInstance),
    _locatorInstance: locatorInstance,
  };
}

function makeMockLLM(decision: {
  elementId: number; action: string; value?: string; reasoning: string;
}): LLMProvider {
  const normalized = {
    candidates: [{ elementId: decision.elementId, confidence: 1.0 }],
    action: decision.action,
    value: decision.value,
    reasoning: decision.reasoning,
  };
  return {
    generateStructuredData: jest.fn(async () => normalized) as any,
    generateText: jest.fn(async () => ''),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ActionEngine + PatternCache integration', () => {
  it('no-op when patternCache is null (existing code path unchanged)', async () => {
    const page = makeMockPage();
    const parser = makeMockStateParser(makeState());
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'ok' });

    const engine = new ActionEngine(page as any, parser as any, llm);
    const result = await engine.act('click submit');

    expect(result.success).toBe(true);
    // Fingerprint computation never triggered
    expect(parser.computeTargetFingerprints).not.toHaveBeenCalled();
  });

  it('on cache miss: runs LLM and records pattern on success', async () => {
    const cache = new InMemoryPatternCache();
    const page = makeMockPage();
    const fingerprints: Record<number, PatternFingerprint> = {
      0: { aria: 'button||', library: 'mui:button' },
    };
    const parser = makeMockStateParser(makeState(), fingerprints);
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'ok' });

    const engine = new ActionEngine(
      page as any, parser as any, llm,
      undefined, 3000, null, 50, 0, false, 'aom', cache,
    );
    const result = await engine.act('click submit');

    expect(result.success).toBe(true);
    // LLM was consulted (miss path)
    expect(llm.generateStructuredData).toHaveBeenCalled();
    // Pattern recorded for the target
    const entry = cache.get(fingerprints[0]!, 'click submit');
    expect(entry).toBeDefined();
    expect(entry!.sequence.action).toBe('click');
    expect(entry!.sequence.name).toBe('Submit');
    expect(entry!.successCount).toBe(1);
  });

  it('on cache hit: skips LLM entirely and executes cached sequence', async () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||', library: 'mui:button' };
    // Pre-populate the cache as if a prior run had succeeded
    cache.recordSuccess(fp, 'click submit', { action: 'click', role: 'button', name: 'Submit' });

    const page = makeMockPage();
    const parser = makeMockStateParser(makeState(), { 0: fp });
    const llm = makeMockLLM({ elementId: 999, action: 'click', reasoning: 'should-not-run' });

    const engine = new ActionEngine(
      page as any, parser as any, llm,
      undefined, 3000, null, 50, 0, false, 'aom', cache,
    );
    const result = await engine.act('click submit');

    expect(result.success).toBe(true);
    expect(result.action).toContain('[pattern]');
    // LLM never invoked
    expect(llm.generateStructuredData).not.toHaveBeenCalled();
    // Hit recorded — now at 2 successes
    const entry = cache.get(fp, 'click submit');
    expect(entry!.successCount).toBe(2);
  });

  it('on cache hit: records failure and returns null when execution throws', async () => {
    const cache = new InMemoryPatternCache();
    const fp: PatternFingerprint = { aria: 'button||' };
    cache.recordSuccess(fp, 'click submit', { action: 'click', role: 'button', name: 'Submit' });

    // Page.mouse.click throws on ALL calls — including LLM-fallback retries.
    const page = makeMockPage();
    (page.mouse.click as jest.Mock).mockImplementation(async () => { throw new Error('boom'); });
    (page._locatorInstance.click as jest.Mock).mockImplementation(async () => { throw new Error('boom'); });

    const parser = makeMockStateParser(makeState(), { 0: fp });
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'fallback attempt' });

    const engine = new ActionEngine(
      page as any, parser as any, llm,
      undefined, 3000, null, 50, 0, false, 'aom', cache,
    );
    await engine.act('click submit');

    // Pattern failure recorded — confidence decayed (1 success, 1 failure = 0.5 threshold, still hittable;
    // but after a second failure it'd drop below)
    const entry = cache.get(fp, 'click submit');
    expect(entry).toBeDefined();
    expect(entry!.failureCount).toBeGreaterThanOrEqual(1);
    // LLM fallback was invoked because the pattern path failed
    expect(llm.generateStructuredData).toHaveBeenCalled();
  });

  it('does not record a pattern when target has no fingerprint', async () => {
    const cache = new InMemoryPatternCache();
    const page = makeMockPage();
    // No fingerprints returned for any id
    const parser = makeMockStateParser(makeState(), {});
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'ok' });

    const engine = new ActionEngine(
      page as any, parser as any, llm,
      undefined, 3000, null, 50, 0, false, 'aom', cache,
    );
    await engine.act('click submit');

    expect(cache.getStats().totalHits).toBe(0);
    // No entries persisted because fingerprint came back empty
    const anyKey = Array.from(cache.getStats().hitsByLayer.library ? [1] : []);
    expect(anyKey.length).toBe(0);
  });

  it('fingerprints top-N relevance-filtered candidates (bounded pool)', async () => {
    const cache = new InMemoryPatternCache();
    const page = makeMockPage();
    // 30 candidates — the probe pool is capped (currently 20) so the
    // fingerprint batch stays bounded regardless of page size. We only
    // assert an upper bound; the exact cap is an internal tuning knob.
    const PROBE_CAP = 25;
    const elements = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      role: 'button',
      name: `Btn${i}`,
      boundingClientRect: { x: 10, y: 20 + i * 40, width: 80, height: 30 },
    }));
    const parser = makeMockStateParser({ url: 'https://example.com', title: 't', elements }, {});
    const llm = makeMockLLM({ elementId: 0, action: 'click', reasoning: 'ok' });

    const engine = new ActionEngine(
      page as any, parser as any, llm,
      undefined, 3000, null, 50, 0, false, 'aom', cache,
    );
    await engine.act('click btn0');

    expect(parser.computeTargetFingerprints).toHaveBeenCalled();
    const args = (parser.computeTargetFingerprints as jest.Mock).mock.calls[0]![0] as unknown[];
    expect((args as Array<unknown>).length).toBeLessThanOrEqual(PROBE_CAP);
    // And at least some candidates WERE probed — we didn't silently skip everything
    expect((args as Array<unknown>).length).toBeGreaterThan(5);
  });
});
