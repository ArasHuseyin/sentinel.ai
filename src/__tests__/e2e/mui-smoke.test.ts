/**
 * E2E Smoke Test — Material UI components on the official mui.com docs site.
 *
 * Purpose: validate that the 🔴-tier work (datepicker cascade, widget
 * detection, form-field handling, slider 3-strategy cascade) actually
 * survives contact with real-world MUI markup. This is a Go/No-Go gate
 * for the Pattern-Store MVP — if these fail, we fix the foundation first.
 *
 * MUI is used on an estimated ~40% of React production sites, so any gap
 * against its live docs is a gap against a huge swath of the real web.
 *
 * Scope: five core components, one natural-language interaction each.
 * Verification is dual-layer:
 *   1. `sentinel.act()` returns `success: true` (Sentinel didn't throw)
 *   2. DOM-level confirmation where cheap (input value, selected option)
 *
 * Tests are NOT pattern-perfect — they target MUI's "basic demo" section
 * on each page, which is the first and most stable example. Flakiness on
 * the network path is absorbed by generous per-test timeouts.
 *
 * Run:  GEMINI_API_KEY=... npx jest -c jest.e2e.config.ts src/__tests__/e2e/mui-smoke.test.ts
 *       (the default jest.config.ts excludes the e2e/ directory)
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

// Tracks results so the final summary prints a Go/No-Go verdict for the run.
const smokeResults: Array<{ component: string; passed: boolean; note?: string }> = [];

describeE2E('MUI smoke — 🔴 foundation Go/No-Go', () => {
  let sentinel: Sentinel;

  beforeAll(async () => {
    sentinel = new Sentinel({
      apiKey: API_KEY,
      headless: false,
      verbose: 2,
      viewport: { width: 1280, height: 800 },
      domSettleTimeoutMs: 3000,
    });
    await sentinel.init();
  }, 30_000);

  afterAll(async () => {
    await sentinel.close();
    // Print the summary so CI output shows the gate verdict at a glance
    const passed = smokeResults.filter(r => r.passed).length;
    const total = smokeResults.length;
    console.log('\n─── MUI Smoke Test Summary ────────────────────────────');
    for (const r of smokeResults) {
      console.log(`  ${r.passed ? '✅' : '❌'} ${r.component}${r.note ? ` — ${r.note}` : ''}`);
    }
    console.log(`\n  Score: ${passed}/${total} (${Math.round((passed / Math.max(total, 1)) * 100)}%)`);
    console.log(`  Verdict: ${passed === total ? '✅ GO for Pattern-Store' : passed >= total * 0.8 ? '🟡 LIKELY GO — fix gaps first' : '❌ NO-GO — fix 🔴 foundation before Pattern-Store'}`);
    console.log('────────────────────────────────────────────────────────\n');
  }, 15_000);

  // ── 1. TextField — baseline form field ────────────────────────────────────

  it('TextField: fills the Basic TextField with a string', async () => {
    const component = 'TextField';
    try {
      await sentinel.goto('https://mui.com/material-ui/react-text-field/');
      const result = await sentinel.act('Fill the first Outlined text field with "hello sentinel"');
      expect(result.success).toBe(true);

      // DOM-level verification: at least one visible input should carry the typed value
      const hasValue = await sentinel.page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
          .some(i => i.value === 'hello sentinel');
      });
      expect(hasValue).toBe(true);
      smokeResults.push({ component, passed: true });
    } catch (err: any) {
      smokeResults.push({ component, passed: false, note: err.message });
      throw err;
    }
  }, 90_000);

  // ── 2. Select — custom dropdown (hidden native <select> + visible trigger) ─

  it('Select: opens a basic MuiSelect and picks an option', async () => {
    const component = 'Select';
    try {
      await sentinel.goto('https://mui.com/material-ui/react-select/');
      // MUI Select is the canonical Pattern-8 case (hidden select + custom trigger).
      // Direct "Select X from Y" phrasing routes the planner to action="select"
      // (compound "open and choose" gets split into just the click action).
      const result = await sentinel.act('Select "Twenty" from the Age dropdown');
      expect(result.success).toBe(true);

      // Verify: the trigger should now display "Twenty" as its selected value
      const showsTwenty = await sentinel.page.evaluate(() => {
        return Array.from(document.querySelectorAll('[class*="MuiSelect-select"]'))
          .some(el => el.textContent?.trim() === 'Twenty');
      });
      expect(showsTwenty).toBe(true);
      smokeResults.push({ component, passed: true });
    } catch (err: any) {
      smokeResults.push({ component, passed: false, note: err.message });
      throw err;
    }
  }, 90_000);

  // ── 3. Autocomplete — type-to-filter combobox ────────────────────────────

  it('Autocomplete: types into an Autocomplete and commits an option', async () => {
    const component = 'Autocomplete';
    try {
      await sentinel.goto('https://mui.com/material-ui/react-autocomplete/');
      // Autocomplete is combobox + listbox pattern. The typing + auto-select
      // path in act.ts (click trigger → type → match option) is exercised.
      const result = await sentinel.act('Fill the first Movie combobox with "Godfather" and select the top match');
      expect(result.success).toBe(true);

      // Verify: some input on the page should reflect the chosen value
      const hasGodfather = await sentinel.page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
          .some(i => /godfather/i.test(i.value));
      });
      expect(hasGodfather).toBe(true);
      smokeResults.push({ component, passed: true });
    } catch (err: any) {
      smokeResults.push({ component, passed: false, note: err.message });
      throw err;
    }
  }, 120_000);

  // ── 4. Slider — 3-strategy fill cascade ──────────────────────────────────

  it('Slider: sets a Continuous slider to a target value', async () => {
    const component = 'Slider';
    try {
      await sentinel.goto('https://mui.com/material-ui/react-slider/');
      // MUI Slider is ARIA-only (no native <input type=range>) — exercises
      // Strategy 3 (keyboard simulation via aria-valuemin/max/now) of the
      // 3-strategy fill cascade in act.ts.
      //
      // Target 70 (not 30) — MUI's first Continuous slider defaults to 30,
      // so target==default would need zero keypresses and the verifier
      // legitimately sees no state change.
      const result = await sentinel.act('Move the first slider to value 70');
      expect(result.success).toBe(true);

      // Verify: libraries expose the current value via either pathway —
      // an explicit [role="slider"][aria-valuenow] or a native
      // <input type="range">.value. Accept whichever carries ~70.
      const reachedTarget = await sentinel.page.evaluate(() => {
        const near70 = (raw: string | null): boolean => {
          if (raw === null) return false;
          const v = parseFloat(raw);
          return !isNaN(v) && Math.abs(v - 70) <= 2;
        };
        const ariaMatch = Array.from(document.querySelectorAll('[role="slider"]'))
          .some(el => near70(el.getAttribute('aria-valuenow')));
        const inputMatch = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="range"]'))
          .some(inp => near70(inp.value));
        return ariaMatch || inputMatch;
      });
      expect(reachedTarget).toBe(true);
      smokeResults.push({ component, passed: true });
    } catch (err: any) {
      smokeResults.push({ component, passed: false, note: err.message });
      throw err;
    }
  }, 120_000);

  // ── 5. DatePicker — the datepicker cascade acid test ─────────────────────

  it('DatePicker: sets a Basic date picker to 10/15/2026', async () => {
    const component = 'DatePicker';
    try {
      await sentinel.goto('https://mui.com/x/react-date-pickers/date-picker/');
      // MUI DatePicker has a writable wrapped <input> — exercises Strategy 2
      // (focus, Ctrl+A, type, Tab) of the datepicker cascade in act.ts.
      const result = await sentinel.act('Fill the first date picker with 10/15/2026');
      expect(result.success).toBe(true);

      // Verify: the picker input should carry the formatted date (MUI may
      // reformat to MM/DD/YYYY — so we just check for the year + day tokens).
      const hasDate = await sentinel.page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
          .some(i => /2026/.test(i.value) && /15/.test(i.value) && /10/.test(i.value));
      });
      expect(hasDate).toBe(true);
      smokeResults.push({ component, passed: true });
    } catch (err: any) {
      smokeResults.push({ component, passed: false, note: err.message });
      throw err;
    }
  }, 120_000);
});
