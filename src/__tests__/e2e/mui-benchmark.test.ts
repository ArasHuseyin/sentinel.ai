/**
 * MUI Component Benchmark — 12 components against live mui.com docs.
 *
 * Purpose: comprehensive widget-coverage test that also auto-populates
 * the pattern cache. Each component is exercised with a single natural-
 * language instruction against its docs page. Pattern cache is enabled
 * so successful interactions are learned for zero-token reuse.
 *
 * Success rate ≥ 10/12 (83%) = production-ready for most form-heavy sites.
 * Success rate ≥ 11/12 (92%) = strong coverage, ready for Pattern Store Phase 2.
 *
 * Run: GEMINI_API_KEY=... npx jest -c jest.e2e.config.ts src/__tests__/e2e/mui-benchmark.test.ts
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

interface BenchmarkResult {
  component: string;
  passed: boolean;
  tokens: number;
  durationMs: number;
  note?: string;
}

const results: BenchmarkResult[] = [];

const COMPONENTS: Array<{
  name: string;
  url: string;
  instruction: string;
}> = [
  // ─── Existing 5 (proven in smoke test) ──────────────────────────────────
  {
    name: 'TextField',
    url: 'https://mui.com/material-ui/react-text-field/',
    instruction: 'Fill the first Outlined text field with "benchmark-test"',
  },
  {
    name: 'Select',
    url: 'https://mui.com/material-ui/react-select/',
    instruction: 'Select "Twenty" from the Age dropdown',
  },
  {
    name: 'Autocomplete',
    url: 'https://mui.com/material-ui/react-autocomplete/',
    instruction: 'Select "The Godfather" from the first Movie combobox',
  },
  {
    name: 'Slider',
    url: 'https://mui.com/material-ui/react-slider/',
    instruction: 'Move the first slider to value 70',
  },
  {
    name: 'DatePicker',
    url: 'https://mui.com/x/react-date-pickers/date-picker/',
    instruction: 'Fill the first date picker with 10/15/2026',
  },
  // ─── New 7 components ───────────────────────────────────────────────────
  {
    name: 'Checkbox',
    url: 'https://mui.com/material-ui/react-checkbox/',
    instruction: 'Click the first checkbox to check it',
  },
  {
    name: 'Switch',
    url: 'https://mui.com/material-ui/react-switch/',
    instruction: 'Toggle the first switch',
  },
  {
    name: 'Radio',
    url: 'https://mui.com/material-ui/react-radio-button/',
    instruction: 'Select the "Female" radio button',
  },
  {
    name: 'Rating',
    url: 'https://mui.com/material-ui/react-rating/',
    instruction: 'Set the first rating to 4 stars',
  },
  {
    name: 'Tabs',
    url: 'https://mui.com/material-ui/react-tabs/',
    instruction: 'Click the "Item Two" tab',
  },
  {
    name: 'ToggleButton',
    url: 'https://mui.com/material-ui/react-toggle-button/',
    instruction: 'Click the center alignment toggle button',
  },
  {
    name: 'Accordion',
    url: 'https://mui.com/material-ui/react-accordion/',
    instruction: 'Click "Accordion 1" to expand it',
  },
];

describeE2E('MUI Benchmark — 12 components', () => {
  let sentinel: Sentinel;

  beforeAll(async () => {
    sentinel = new Sentinel({
      apiKey: API_KEY,
      headless: false,
      verbose: 1,
      viewport: { width: 1280, height: 800 },
      domSettleTimeoutMs: 3000,
      patternCache: true,
    });
    await sentinel.init();
  }, 30_000);

  afterAll(async () => {
    await sentinel.close();
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
    const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  MUI Component Benchmark Results');
    console.log('═══════════════════════════════════════════════════════');
    for (const r of results) {
      const icon = r.passed ? '✅' : '❌';
      const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
      const tok = r.tokens > 0 ? `${r.tokens}t` : '0t';
      console.log(`  ${icon} ${r.component.padEnd(16)} ${dur.padStart(6)}  ${tok.padStart(7)}${r.note ? `  — ${r.note}` : ''}`);
    }
    console.log('───────────────────────────────────────────────────────');
    console.log(`  Score: ${passed}/${total} (${Math.round((passed / Math.max(total, 1)) * 100)}%)`);
    console.log(`  Total: ${totalTokens} tokens, ${(totalDuration / 1000).toFixed(1)}s`);
    const avgTokens = Math.round(totalTokens / Math.max(total, 1));
    console.log(`  Avg:   ${avgTokens} tokens/component`);
    if (passed >= total * 0.92) console.log('  Verdict: 🏆 EXCELLENT — ready for Pattern Store Phase 2');
    else if (passed >= total * 0.83) console.log('  Verdict: ✅ GOOD — production-ready for form-heavy sites');
    else if (passed >= total * 0.67) console.log('  Verdict: 🟡 ACCEPTABLE — address gaps before shipping');
    else console.log('  Verdict: ❌ NEEDS WORK — significant gaps in widget coverage');
    console.log('═══════════════════════════════════════════════════════\n');
  }, 15_000);

  for (const comp of COMPONENTS) {
    it(`${comp.name}: ${comp.instruction}`, async () => {
      const t0 = Date.now();
      const tokensBefore = sentinel.getTokenUsage().totalTokens;
      let recorded = false;

      try {
        await sentinel.goto(comp.url);
        const result = await sentinel.act(comp.instruction);
        const tokens = sentinel.getTokenUsage().totalTokens - tokensBefore;
        const durationMs = Date.now() - t0;

        const entry: BenchmarkResult = {
          component: comp.name,
          passed: result.success,
          tokens,
          durationMs,
        };
        if (result.success && result.action?.includes('[pattern]')) entry.note = 'pattern hit';
        if (!result.success) entry.note = result.message?.slice(0, 80);
        results.push(entry);
        recorded = true;

        expect(result.success).toBe(true);
      } catch (err: any) {
        if (!recorded) {
          results.push({
            component: comp.name,
            passed: false,
            tokens: sentinel.getTokenUsage().totalTokens - tokensBefore,
            durationMs: Date.now() - t0,
            note: err.message?.slice(0, 80),
          });
        }
        throw err;
      }
    }, 90_000);
  }
});
