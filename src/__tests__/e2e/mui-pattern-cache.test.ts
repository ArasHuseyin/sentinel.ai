/**
 * E2E — Validates the cross-site widget pattern cache end-to-end.
 *
 *   Run 1 (cold cache): LLM decides the action → tokens billed → cache populated
 *   Run 2 (warm cache): pattern lookup hits → LLM skipped → 0 tokens
 *
 * Asserts the 0-token property directly via `getTokenUsage()`, and
 * separately the `[pattern]` marker on the ActionResult. Covers two
 * components that stress different fingerprint layers:
 *
 *   TextField — simplest (ARIA textbox + library signature both hit)
 *   Select    — hidden-native-select pattern, complex combobox cascade
 *
 * Run: GEMINI_API_KEY=... npx jest -c jest.e2e.config.ts src/__tests__/e2e/mui-pattern-cache.test.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Sentinel } from '../../index.js';

if (!process.env.GEMINI_VERSION) {
  process.env.GEMINI_VERSION = 'gemini-3-flash-preview';
}

const API_KEY = process.env.GEMINI_API_KEY ?? '';
const RUN_E2E = API_KEY.length > 0;
const describeE2E = RUN_E2E ? describe : describe.skip;

/** Per-test cold-vs-warm summary, printed at afterAll for readability. */
interface RunPair {
  component: string;
  firstRunTokens: number;
  secondRunTokens: number;
  secondHitPattern: boolean;
}
const pairs: RunPair[] = [];

describeE2E('E2E: PatternCache — LLM-skip on second hit', () => {
  let sentinel: Sentinel;

  beforeAll(async () => {
    sentinel = new Sentinel({
      apiKey: API_KEY,
      headless: false,
      verbose: 2,
      viewport: { width: 1280, height: 800 },
      domSettleTimeoutMs: 3000,
      patternCache: true,  // in-memory, shared across acts within this instance
    });
    await sentinel.init();
  }, 30_000);

  afterAll(async () => {
    await sentinel.close();
    console.log('\n─── PatternCache Cold-vs-Warm Summary ─────────────────');
    for (const p of pairs) {
      const savings = p.firstRunTokens - p.secondRunTokens;
      const marker = p.secondHitPattern ? '🎯 [pattern]' : '🔥 LLM';
      console.log(`  ${p.component}: cold=${p.firstRunTokens}t  warm=${p.secondRunTokens}t  saved=${savings}t  ${marker}`);
    }
    const allWarmHit = pairs.every(p => p.secondRunTokens === 0 && p.secondHitPattern);
    console.log(`\n  Verdict: ${allWarmHit ? '✅ Pattern cache functional (all warm hits)' : '⚠️  Some warm runs missed the cache'}`);
    console.log('────────────────────────────────────────────────────────\n');
  }, 15_000);

  async function runColdWarm(component: string, url: string, instruction: string): Promise<RunPair> {
    // ── Cold run: cache empty, LLM decides
    await sentinel.goto(url);
    const t0 = sentinel.getTokenUsage().totalTokens;
    const result1 = await sentinel.act(instruction);
    const t1 = sentinel.getTokenUsage().totalTokens;
    const firstRunTokens = t1 - t0;

    expect(result1.success).toBe(true);
    expect(firstRunTokens).toBeGreaterThan(0);
    // Cold run must NOT be labelled a pattern hit
    expect(result1.action ?? '').not.toContain('[pattern]');

    // ── Re-navigate so the DOM is fresh (state parser, coord space, etc.)
    await sentinel.goto(url);

    // ── Warm run: same instruction, same URL, same widget shape
    const t2 = sentinel.getTokenUsage().totalTokens;
    const result2 = await sentinel.act(instruction);
    const t3 = sentinel.getTokenUsage().totalTokens;
    const secondRunTokens = t3 - t2;
    const secondHitPattern = (result2.action ?? '').includes('[pattern]');

    const pair: RunPair = { component, firstRunTokens, secondRunTokens, secondHitPattern };
    pairs.push(pair);
    return pair;
  }

  it('TextField: warm run skips LLM entirely AND fills the correct field', async () => {
    const pair = await runColdWarm(
      'TextField',
      'https://mui.com/material-ui/react-text-field/',
      'Fill the first Outlined text field with "pattern-probe"'
    );
    expect(pair.secondHitPattern).toBe(true);
    expect(pair.secondRunTokens).toBe(0);

    // Semantic check: some input labelled "Outlined" now carries the
    // probe value. The MUI Docs page renders the Outlined demo across
    // several sections (Basic, Form Props, Validation, ...), so the
    // pattern hit may legitimately fill any of them. The key invariant
    // is that the name-compat check routed the fill to an "Outlined"-
    // labelled input and NOT to a different-same-shape sibling (e.g.
    // "With a start adornment") — that's exactly what the name-compat
    // logic in `tryPatternCache` guarantees.
    const outlinedHasValue = await sentinel.page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll<HTMLLabelElement>('label'));
      const outlinedLabels = labels.filter(l =>
        l.textContent?.trim().toLowerCase().includes('outlined')
      );
      return outlinedLabels.some(label => {
        const forId = label.getAttribute('for');
        const input = forId
          ? document.getElementById(forId) as HTMLInputElement | null
          : label.parentElement?.querySelector('input') as HTMLInputElement | null;
        return input?.value === 'pattern-probe';
      });
    });
    expect(outlinedHasValue).toBe(true);
  }, 120_000);

  it('Select: warm run skips LLM entirely', async () => {
    const pair = await runColdWarm(
      'Select',
      'https://mui.com/material-ui/react-select/',
      'Select "Twenty" from the Age dropdown'
    );
    expect(pair.secondHitPattern).toBe(true);
    expect(pair.secondRunTokens).toBe(0);
  }, 120_000);
});
