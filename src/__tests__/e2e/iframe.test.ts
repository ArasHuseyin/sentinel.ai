/**
 * E2E Test — Cross-frame action routing.
 *
 * Uses a single data-URL page that embeds another data-URL page as a
 * same-origin iframe (both `data:`-origin). Verifies that when Sentinel
 * selects an element whose AOM entry lives inside an iframe, the action
 * is dispatched into the frame's document instead of the top-level page.
 *
 * Why this matters in production: Stripe Checkout, OAuth popups, and
 * email-verification widgets are commonly rendered inside iframes.
 * Without cross-frame routing, `page.mouse.click(x, y)` hits the iframe
 * boundary and the inner field never gets focus.
 *
 * Run:  GEMINI_API_KEY=... npx jest src/__tests__/e2e/iframe.test.ts --no-coverage
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

const INNER_HTML = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Inner</title>
<style>body{font-family:sans-serif;padding:20px;}input,button{display:block;margin:8px 0;padding:8px;font-size:14px;}</style>
</head><body>
<h2>Payment details</h2>
<label for="card">Card number</label>
<input id="card" name="card" type="text" aria-label="Card number" placeholder="4242 4242 4242 4242">
<button id="pay" type="button" aria-label="Pay now">Pay now</button>
<div id="status">idle</div>
<script>
  document.getElementById('pay').addEventListener('click', () => {
    document.getElementById('status').textContent =
      'paid:' + (document.getElementById('card').value || '');
  });
</script>
</body></html>`;

const OUTER_HTML = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Checkout</title>
<style>body{font-family:sans-serif;padding:40px;}iframe{width:500px;height:280px;border:1px solid #888;}</style>
</head><body>
<h1>Checkout</h1>
<p>Enter payment details in the embedded form.</p>
<iframe id="payment-frame" title="Payment" srcdoc="${INNER_HTML.replace(/"/g, '&quot;')}"></iframe>
</body></html>`;

const outerUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(OUTER_HTML);

describeE2E('E2E: Cross-frame action routing', () => {
  let sentinel: Sentinel;

  beforeAll(async () => {
    sentinel = new Sentinel({
      apiKey: API_KEY,
      headless: false,
      verbose: 2,
      viewport: { width: 1280, height: 720 },
      domSettleTimeoutMs: 3000,
    });
    await sentinel.init();
  }, 30_000);

  afterAll(async () => {
    await sentinel.close();
  }, 15_000);

  it('fills a textbox inside an iframe via frame-scoped locator', async () => {
    await sentinel.goto(outerUrl);
    await sentinel.act('Fill the Card number field with 4242 4242 4242 4242');

    const value = await sentinel.page.frameLocator('#payment-frame')
      .locator('#card').inputValue();
    expect(value).toBe('4242 4242 4242 4242');
  }, 60_000);

  it('clicks a button inside an iframe via frame-scoped locator', async () => {
    await sentinel.goto(outerUrl);
    await sentinel.act('Fill the Card number field with 1111 2222 3333 4444');
    await sentinel.act('Click the Pay now button');

    const status = await sentinel.page.frameLocator('#payment-frame')
      .locator('#status').textContent();
    expect(status).toMatch(/^paid:/);
    expect(status).toContain('1111');
  }, 90_000);
});
