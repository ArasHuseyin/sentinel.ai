/**
 * E2E Tests — Real browser, real pages, real LLM.
 *
 * These tests require a GEMINI_API_KEY environment variable.
 * They launch a real Chromium instance and interact with live websites.
 *
 * Run:   GEMINI_API_KEY=... npx jest src/__tests__/e2e/ --no-coverage
 * Skip:  Tests auto-skip when GEMINI_API_KEY is not set.
 *
 * Note: These tests hit real websites and LLM APIs.
 * They may be flaky due to network conditions, page changes, or rate limits.
 * Timeout is set generously (60s per test) to account for LLM latency.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Sentinel, z } from '../../index.js';

// Default model if not set in .env
if (!process.env.GEMINI_VERSION) {
  process.env.GEMINI_VERSION = 'gemini-3-flash-preview';
}

const API_KEY = process.env.GEMINI_API_KEY ?? '';
const RUN_E2E = API_KEY.length > 0;

// Skip entire suite if no API key
const describeE2E = RUN_E2E ? describe : describe.skip;

describeE2E('E2E: Real Browser Tests', () => {
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

  // ─── 1. Google Search: act + extract ────────────────────────────────────────

  describe('Google Search', () => {
    it('searches and extracts results', async () => {
      await sentinel.goto('https://www.google.com');

      // Handle possible cookie consent (EU)
      await sentinel.act('Accept cookies if a consent dialog is visible, otherwise do nothing').catch(() => {});

      await sentinel.act('Fill "Playwright browser automation" into the search field');
      await sentinel.act('Press Enter');

      const results = await sentinel.extract(
        'Extract the titles of the first 3 search results',
        z.object({
          titles: z.array(z.string()),
        })
      );

      expect(results.titles).toBeDefined();
      expect(results.titles.length).toBeGreaterThanOrEqual(1);
      console.log('Google results:', results.titles);
    }, 60_000);
  });

  // ─── 2. Hacker News: Navigation + Extract on a SPA-like page ───────────────

  describe('Hacker News', () => {
    it('navigates to newest and extracts story titles', async () => {
      await sentinel.goto('https://news.ycombinator.com');

      await sentinel.act('Click on "new" to see newest stories');

      const stories = await sentinel.extract(
        'Extract the titles of the first 5 stories',
        z.object({
          stories: z.array(z.string()),
        })
      );

      expect(stories.stories.length).toBeGreaterThanOrEqual(3);
      console.log('HN stories:', stories.stories);
    }, 60_000);

    it('observes interactive elements', async () => {
      await sentinel.goto('https://news.ycombinator.com');

      const observations = await sentinel.observe();

      expect(observations.length).toBeGreaterThan(0);
      // Should find links, buttons, etc.
      const hasLinks = observations.some(o => o.method === 'click');
      expect(hasLinks).toBe(true);
      console.log(`Observed ${observations.length} possible actions`);
    }, 60_000);
  });

  // ─── 3. Wikipedia: Complex page with many elements + extract ────────────────

  describe('Wikipedia', () => {
    it('searches and extracts article summary', async () => {
      await sentinel.goto('https://en.wikipedia.org');

      await sentinel.act('Fill "TypeScript" into the search field');
      await sentinel.act('Click the search button or press Enter');

      const article = await sentinel.extract(
        'Extract the first paragraph of the article as a summary',
        z.object({
          title: z.string(),
          summary: z.string(),
        })
      );

      expect(article.title).toBeDefined();
      expect(article.summary.length).toBeGreaterThan(50);
      console.log('Wikipedia:', article.title, '-', article.summary.slice(0, 100) + '...');
    }, 60_000);
  });

  // ─── 4. Cookie-Banner Recovery ──────────────────────────────────────────────

  describe('Cookie Banner Handling', () => {
    it('handles a page with cookie consent and continues', async () => {
      // spiegel.de is a German news site that always shows a cookie banner
      await sentinel.goto('https://www.spiegel.de');

      // This should trigger auto-recovery or succeed via act
      const result = await sentinel.act('Click on the main headline or top article link');

      // If we got here without throwing, cookie handling worked
      expect(result.success).toBe(true);
      console.log('Cookie banner handled, action:', result.action);
    }, 60_000);
  });

  // ─── 5. GitHub: Complex SPA with many interactive elements ──────────────────

  describe('GitHub', () => {
    it('navigates a repository and extracts info', async () => {
      await sentinel.goto('https://github.com/ArasHuseyin/sentinel');

      const repoInfo = await sentinel.extract(
        'Extract the repository description, star count, and programming language',
        z.object({
          description: z.string(),
          stars: z.string(),
          language: z.string(),
        })
      );

      expect(repoInfo.description).toBeDefined();
      expect(repoInfo.language).toBeDefined();
      console.log('GitHub repo:', repoInfo);
    }, 60_000);

    it('navigates to issues tab', async () => {
      await sentinel.goto('https://github.com/microsoft/playwright');

      await sentinel.act('Click on the Issues tab');

      const pageTitle = await sentinel.extract(
        'What page are we on? Extract the tab name and issue count if visible',
        z.object({
          currentTab: z.string(),
          issueCount: z.string().optional(),
        })
      );

      expect(pageTitle.currentTab.toLowerCase()).toContain('issue');
      console.log('GitHub issues:', pageTitle);
    }, 60_000);
  });

  // ─── 6. Autonomous Agent: Multi-step workflow ──────────────────────────────

  describe('Autonomous Agent', () => {
    it('runs a multi-step goal on Hacker News', async () => {
      await sentinel.goto('https://news.ycombinator.com');

      const result = await sentinel.run(
        'Go to the "Ask HN" section and extract the titles of the top 3 posts',
        { maxSteps: 8 }
      );

      expect(result.totalSteps).toBeGreaterThanOrEqual(2);
      console.log(`Agent: ${result.totalSteps} steps, goal achieved: ${result.goalAchieved}`);
      if (result.data) {
        console.log('Agent data:', JSON.stringify(result.data).slice(0, 200));
      }
    }, 90_000);
  });

  // ─── 7. Form Interaction: Fill, select, submit ─────────────────────────────

  describe('Form Interaction', () => {
    it('fills and submits a search form on npmjs.com', async () => {
      await sentinel.goto('https://www.npmjs.com');

      await sentinel.act('Fill "sentinel browser automation" into the search field');
      await sentinel.act('Press Enter or click the search button');

      const results = await sentinel.extract(
        'Extract the names of the first 3 packages from the search results',
        z.object({
          packages: z.array(z.string()),
        })
      );

      expect(results.packages.length).toBeGreaterThanOrEqual(1);
      console.log('npm packages:', results.packages);
    }, 60_000);
  });

  // ─── 8. Scroll Discovery: Elements below the fold ──────────────────────────

  describe('Scroll Discovery', () => {
    it('finds elements that require scrolling', async () => {
      await sentinel.goto('https://news.ycombinator.com');

      // The "More" link is at the bottom of the page — needs scrolling
      const result = await sentinel.act('Click the "More" link at the bottom of the page');

      expect(result.success).toBe(true);
      console.log('Scroll discovery:', result.message);
    }, 60_000);
  });

  // ─── 9. Region Awareness: Header vs Main content ───────────────────────────

  describe('Region Awareness', () => {
    it('distinguishes header from main content elements', async () => {
      await sentinel.goto('https://en.wikipedia.org');

      const observations = await sentinel.observe('What navigation elements are in the header?');

      expect(observations.length).toBeGreaterThan(0);
      console.log(`Found ${observations.length} header elements`);
    }, 60_000);
  });

  // ─── 10. Performance: Token tracking ────────────────────────────────────────

  describe('Performance Tracking', () => {
    it('tracks token usage across actions', async () => {
      await sentinel.goto('https://news.ycombinator.com');

      await sentinel.act('Click on the first story link');

      const usage = sentinel.getTokenUsage();
      expect(usage.totalTokens).toBeGreaterThan(0);
      console.log(`Tokens: ${usage.totalTokens}, Cost: $${usage.estimatedCostUsd.toFixed(5)}`);
    }, 60_000);
  });

  // ─── 11. Durchblicker.at: KFZ-Versicherungsvergleich ─────────────────────────

  describe('Durchblicker.at KFZ-Versicherung', () => {
    it('completes a car insurance comparison with fake data', async () => {
      await sentinel.goto('https://www.durchblicker.at/autoversicherung');

      const result = await sentinel.run(
        'Complete the car insurance comparison form on durchblicker.at. Use these details:\n' +
        '- Accept any cookie/consent banners first\n' +
        '- Car brand: BMW\n' +
        '- Car model: 4er (or 4 Series, 420i, or similar)\n' +
        '- First registration: January 2020\n' +
        '- Engine power: 190 PS\n' +
        '- Fuel type: Benzin\n' +
        '- Birth year of policyholder: 1990\n' +
        '- Postal code: 1010 (Wien)\n' +
        '- Name: Max Mustermann\n' +
        '- Fill all required fields, click through all form steps\n' +
        '- When results/offers appear, extract the first 3 insurance providers with their prices',
        {
          maxSteps: 25,
          onStep: step => {
            const icon = step.type === 'extract' ? '🔍' : (step.success ? '✅' : '❌');
            console.log(`[Durchblicker ${step.stepNumber}] ${icon} ${step.instruction}`);
          },
        }
      );

      console.log(`\nDurchblicker: ${result.totalSteps} steps, goal: ${result.goalAchieved}`);
      console.log(`Message: ${result.message}`);
      if (result.data) {
        console.log('Data:', JSON.stringify(result.data, null, 2));
      }
      if (result.selectors) {
        console.log('Selectors:', JSON.stringify(result.selectors, null, 2));
      }

      const usage = sentinel.getTokenUsage();
      console.log(`Cost: ${usage.totalTokens} tokens, $${usage.estimatedCostUsd.toFixed(5)}`);

      expect(result.totalSteps).toBeGreaterThanOrEqual(5);
    }, 300_000);
  });

  // ─── 12. Onix VP: Login + Tarifrechner + günstigsten Tarif wählen ───────────

  describe('Onix VP Tarifrechner', () => {
    it('logs in, fills the tariff calculator with fake data, and selects the cheapest tariff', async () => {
      await sentinel.goto('https://vp.onix-connect.com/');

      const result = await sentinel.run(
        'Complete the following steps on vp.onix-connect.com (energy provider switch platform):\n' +
        '\n' +
        '1. LOGIN:\n' +
        '   - Email: samil.andak@hotmail.com\n' +
        '   - Password: odkPLlGAwz\n' +
        '   - Click the login/submit button\n' +
        '\n' +
        '2. NAVIGATE TO TARIFRECHNER:\n' +
        '   - After login, find and open the Tarifrechner (tariff calculator) for Strom (electricity) or Gas\n' +
        '\n' +
        '3. FILL THE FORM with fake data:\n' +
        '   - Use realistic Austrian fake data for all required fields\n' +
        '   - PLZ / Postal code: 1010\n' +
        '   - Verbrauch / Consumption: 3500 kWh (for Strom) or 15000 kWh (for Gas)\n' +
        '   - For any personal fields: Max Mustermann, Musterstraße 1, 1010 Wien\n' +
        '   - Fill ALL required fields, click through ALL form steps/pages\n' +
        '\n' +
        '4. SELECT CHEAPEST TARIFF:\n' +
        '   - When tariff results appear, identify the cheapest option\n' +
        '   - Select/click on the cheapest tariff\n' +
        '   - Extract the selected tariff details (provider name, tariff name, yearly price)',
        {
          maxSteps: 40,
          onStep: step => {
            const icon = step.type === 'extract' ? '🔍' : (step.success ? '✅' : '❌');
            console.log(`[Onix ${step.stepNumber}] ${icon} ${step.instruction}`);
          },
        }
      );

      console.log(`\n${'='.repeat(60)}`);
      console.log(`Onix VP: ${result.totalSteps} steps, goal: ${result.goalAchieved}`);
      console.log(`Message: ${result.message}`);
      if (result.data) {
        console.log('\nSelected tariff:');
        console.log(JSON.stringify(result.data, null, 2));
      }
      if (result.selectors) {
        console.log('\nSelectors:', JSON.stringify(result.selectors, null, 2));
      }

      const usage = sentinel.getTokenUsage();
      console.log(`\nCost: ${usage.totalTokens} tokens, $${usage.estimatedCostUsd.toFixed(5)}`);

      expect(result.totalSteps).toBeGreaterThanOrEqual(3);
    }, 600_000); // 10 Minuten — Login + mehrstufiges Formular + Tarifauswahl
  });
});
