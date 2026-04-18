import type { Page, Frame } from 'playwright';
import type { CaptchaType } from '../types/errors.js';

export interface CaptchaSolverOptions {
  /**
   * Built-in solving strategies (no external API keys required):
   *  - `'auto'` (default) — tries the safe strategies: reCAPTCHA v2 checkbox
   *    click and Turnstile auto-resolve wait. Gives up gracefully on types
   *    that genuinely need external solvers (hCaptcha images, FunCaptcha).
   *  - `'skip'` — don't attempt to solve. Detection still runs so
   *    `CaptchaDetectedError` surfaces with a clear type — useful when the
   *    caller has their own solver downstream.
   *  - `'manual'` — pause and wait for the user to solve interactively
   *    (only meaningful in headful mode). Polls until the CAPTCHA widget
   *    signals completion or `timeoutMs` elapses.
   */
  strategy?: 'auto' | 'skip' | 'manual';

  /** Max wait per solving attempt (ms). Default 20_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

/**
 * Attempts to resolve the detected CAPTCHA using built-in strategies.
 * Returns `true` if the CAPTCHA is now cleared (safe to retry the failed
 * action), `false` if the strategy can't handle this type and an external
 * solver or human intervention is required.
 *
 * No external API calls, no third-party dependencies — pure Playwright
 * interaction. Handles the CAPTCHA types that solve "for free":
 *
 *   reCAPTCHA v2 — click the anchor iframe's checkbox. Works 30-70 % of
 *     the time depending on browser fingerprint and IP reputation.
 *     If Google decides an image challenge is needed, click still
 *     succeeds but the challenge blocks further interaction.
 *
 *   Turnstile — Cloudflare's proof-of-work runs in the iframe. For
 *     non-suspicious traffic it auto-resolves in 3-10 seconds. We just
 *     poll until the widget token appears or the timeout expires.
 *
 *   reCAPTCHA v3 / hCaptcha / FunCaptcha — not auto-solvable. Returns
 *     false so the caller surfaces CaptchaDetectedError.
 */
export async function attemptAutoSolve(
  page: Page,
  type: CaptchaType,
  options: CaptchaSolverOptions = {}
): Promise<boolean> {
  const strategy = options.strategy ?? 'auto';
  if (strategy === 'skip') return false;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (strategy === 'manual') {
    return await waitForHumanSolve(page, type, timeoutMs);
  }

  switch (type) {
    case 'recaptcha-v2':
      return await solveRecaptchaV2Checkbox(page, timeoutMs);
    case 'turnstile':
      return await waitForTurnstileResolve(page, timeoutMs);
    case 'recaptcha-v3':
    case 'hcaptcha':
    case 'funcaptcha':
    case 'unknown':
      return false;
  }
}

/**
 * Clicks the "I'm not a robot" checkbox inside Google's anchor iframe.
 * Resolves true when aria-checked flips to "true"; false on image-
 * challenge popup or timeout.
 */
async function solveRecaptchaV2Checkbox(page: Page, timeoutMs: number): Promise<boolean> {
  const anchorFrame = findAnchorFrame(page);
  if (!anchorFrame) return false;

  try {
    const checkbox = anchorFrame.locator('#recaptcha-anchor, [role="checkbox"]').first();
    await checkbox.click({ timeout: 5000 });
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const checked = await anchorFrame
        .locator('#recaptcha-anchor, [role="checkbox"]')
        .first()
        .getAttribute('aria-checked', { timeout: 1000 });
      if (checked === 'true') return true;
    } catch {
      return false;
    }
    if (hasChallengeBframe(page)) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Waits for Cloudflare Turnstile to resolve itself. Proof-of-work runs
 * in-iframe; legitimate traffic completes within seconds. We detect via
 * populated response-token input.
 */
async function waitForTurnstileResolve(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const tokenInputs = document.querySelectorAll<HTMLInputElement>(
        'input[name="cf-turnstile-response"], input[name="cf_challenge_response"]'
      );
      for (const input of Array.from(tokenInputs)) {
        if (input.value && input.value.length > 0) return true;
      }
      const wrapper = document.querySelector('.cf-turnstile, [data-sitekey]');
      if (wrapper?.getAttribute('data-turnstile-status') === 'success') return true;
      return false;
    }).catch(() => false);
    if (done) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Manual strategy — polls for externally-provided solution. Useful in
 * headful mode where the human solves while Sentinel waits.
 */
async function waitForHumanSolve(page: Page, type: CaptchaType, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (type === 'recaptcha-v2' || type === 'recaptcha-v3') {
      const anchor = findAnchorFrame(page);
      if (anchor) {
        try {
          const checked = await anchor
            .locator('#recaptcha-anchor, [role="checkbox"]')
            .first()
            .getAttribute('aria-checked', { timeout: 1000 });
          if (checked === 'true') return true;
        } catch { /* frame gone */ }
      }
      const resolved = await page.evaluate(() => {
        const ta = document.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]');
        return !!(ta && ta.value && ta.value.length > 0);
      }).catch(() => false);
      if (resolved) return true;
    } else if (type === 'turnstile') {
      const done = await page.evaluate(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>(
          'input[name="cf-turnstile-response"], input[name="cf_challenge_response"]'
        );
        return Array.from(inputs).some(i => i.value && i.value.length > 0);
      }).catch(() => false);
      if (done) return true;
    } else {
      const done = await page.evaluate(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>(
          'textarea[name*="captcha-response" i], input[name*="captcha-response" i], ' +
          'input[name="h-captcha-response"], input[name="fc-token"]'
        );
        return Array.from(inputs).some(i => i.value && i.value.length > 0);
      }).catch(() => false);
      if (done) return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findAnchorFrame(page: Page): Frame | null {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes('recaptcha/api2/anchor') || url.includes('recaptcha/enterprise/anchor')) {
      return frame;
    }
  }
  return null;
}

function hasChallengeBframe(page: Page): boolean {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes('recaptcha/api2/bframe') || url.includes('recaptcha/enterprise/bframe')) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
