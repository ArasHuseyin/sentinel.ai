/**
 * E2E Test — Amazon: Search + Filter + Sort.
 *
 * Reales Szenario: Nutzer sucht ein bestimmtes Produkt und muss
 * Filter (Marke, Preis) und Sortierung (Kundenbewertung) kombinieren,
 * um es in den Ergebnissen zu finden.
 *
 * Run:  GEMINI_API_KEY=... npx jest src/__tests__/e2e/amazon-filter-sort.test.ts --no-coverage
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

describeE2E('E2E: Amazon Filter + Sort', () => {
  let sentinel: Sentinel;

  beforeAll(async () => {
    sentinel = new Sentinel({
      apiKey: API_KEY,
      headless: false,
      verbose: 2,
      viewport: { width: 1920, height: 1080 },
      domSettleTimeoutMs: 3000,
    });
    await sentinel.init();
  }, 30_000);

  afterAll(async () => {
    await sentinel.close();
  }, 15_000);

  it('searches, filters by brand, sorts by rating, extracts top results', async () => {
    await sentinel.goto('https://www.amazon.de');

    // Note: index-based price sliders (Amazon, Booking) are a known limitation
    // for all current AI browser frameworks (Stagehand + Sentinel both fail).
    // The slider's value space is 0..N (positions), not actual EUR amounts —
    // a proper fix requires aria-valuetext binary-search. See TODO.md.
    const result = await sentinel.run(
      'Find Sony over-ear bluetooth headphones on Amazon using search, filter and sort:\n' +
      '\n' +
      '1. Accept any cookie/consent banners first\n' +
      '2. Search for "bluetooth kopfhörer over-ear" in the search field and submit\n' +
      '3. On the results page, filter by brand: Sony (use the brand/Marke filter in the left sidebar)\n' +
      '4. Sort the results by "Durchschn. Kundenrezension" (average customer rating) via the sort dropdown at the top right\n' +
      '5. When the filtered + sorted results are visible, extract the first 3 products with: product name, price, and star rating',
      {
        maxSteps: 15,
        onStep: step => {
          const icon = step.type === 'extract' ? '🔍' : (step.success ? '✅' : '❌');
          console.log(`[Amazon ${step.stepNumber}] ${icon} ${step.instruction}`);
        },
      }
    );

    console.log(`\nAmazon Filter+Sort: ${result.totalSteps} steps, goal: ${result.goalAchieved}`);
    console.log(`Message: ${result.message}`);
    if (result.data) console.log('Data:', JSON.stringify(result.data, null, 2));
    if (result.selectors) console.log('Selectors:', JSON.stringify(result.selectors, null, 2));

    const usage = sentinel.getTokenUsage();
    console.log(`Cost: ${usage.totalTokens} tokens, $${usage.estimatedCostUsd.toFixed(5)}`);

    expect(result.totalSteps).toBeGreaterThanOrEqual(5);
  }, 300_000);
});
