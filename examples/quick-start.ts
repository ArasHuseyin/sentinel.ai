/**
 * Sentinel Quick Start — Run this in 30 seconds.
 *
 * 1. npm install @isoldex/sentinel playwright
 * 2. npx playwright install chromium
 * 3. GEMINI_API_KEY=your_key npx ts-node examples/quick-start.ts
 */
import 'dotenv/config';
import { Sentinel, z } from '../src/index.js';

async function main() {
  const sentinel = new Sentinel({
    apiKey: process.env.GEMINI_API_KEY!,
    verbose: 1,
  });

  await sentinel.init();

  // ── 1. Search + Extract in 3 steps ──────────────────────────────────────
  await sentinel.goto('https://www.npmjs.com');
  const result = await sentinel.run(
    'Search for "playwright", click the first result, extract the package name, weekly downloads, and version',
    { maxSteps: 8 }
  );
  console.log('\n--- Agent Result ---');
  console.log('Goal achieved:', result.goalAchieved);
  console.log('Steps:', result.totalSteps);
  console.log('Data:', JSON.stringify(result.data, null, 2));
  console.log('Selectors:', result.selectors);

  // ── 2. Declarative form filling ─────────────────────────────────────────
  // await sentinel.goto('https://your-form-page.com');
  // await sentinel.fillForm({ name: 'Max', email: 'max@test.com', country: 'Austria' });

  // ── 3. Network interception ─────────────────────────────────────────────
  // const apiData = await sentinel.intercept('api/search', async () => {
  //   await sentinel.act('Click search');
  // });
  // console.log('API data:', apiData);

  // ── 4. Cost tracking ────────────────────────────────────────────────────
  const usage = sentinel.getTokenUsage();
  console.log(`\nTokens: ${usage.totalTokens}, Cost: $${usage.estimatedCostUsd.toFixed(5)}`);

  await sentinel.close();
}

main().catch(console.error);
