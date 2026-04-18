import { describe, it, expect, jest } from '@jest/globals';
import { detectCaptcha, describeCaptcha } from '../reliability/captcha-detector.js';
import type { CaptchaType } from '../types/errors.js';

/**
 * The detector calls `page.evaluate(fn)` — we mock the page by returning
 * a canned detection result per test. This exercises the consumer contract
 * (shape, error handling, type coverage) without needing a real browser.
 * The detection logic ITSELF runs in the browser and is covered by
 * integration tests against live CAPTCHA-gated pages.
 */
function makePage(evalResult: any = { type: null }, shouldThrow = false): any {
  return {
    evaluate: jest.fn(async () => {
      if (shouldThrow) throw new Error('page navigated');
      return evalResult;
    }),
  };
}

describe('detectCaptcha', () => {
  it('returns {type: null} when no CAPTCHA is present', async () => {
    const page = makePage({ type: null });
    const result = await detectCaptcha(page);
    expect(result.type).toBeNull();
  });

  it('returns recaptcha-v2 when anchor iframe is found', async () => {
    const page = makePage({
      type: 'recaptcha-v2',
      source: 'https://www.google.com/recaptcha/api2/anchor?...',
    });
    const result = await detectCaptcha(page);
    expect(result.type).toBe('recaptcha-v2');
    expect(result.source).toContain('recaptcha');
  });

  it('returns turnstile for Cloudflare iframes', async () => {
    const page = makePage({
      type: 'turnstile',
      source: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    });
    const result = await detectCaptcha(page);
    expect(result.type).toBe('turnstile');
  });

  it('recovers gracefully when page.evaluate throws', async () => {
    const page = makePage(null, true);
    const result = await detectCaptcha(page);
    expect(result.type).toBeNull();
  });
});

describe('describeCaptcha', () => {
  const types: CaptchaType[] = [
    'recaptcha-v2', 'recaptcha-v3', 'hcaptcha',
    'turnstile', 'funcaptcha', 'unknown',
  ];

  it('produces a non-empty message for every captcha type', () => {
    for (const t of types) {
      const msg = describeCaptcha(t);
      expect(msg.length).toBeGreaterThan(20);
    }
  });

  it('includes the source hint when provided', () => {
    const msg = describeCaptcha('recaptcha-v2', 'iframe-src-here');
    expect(msg).toContain('iframe-src-here');
  });

  it('omits parentheses when no source is provided', () => {
    const msg = describeCaptcha('turnstile');
    expect(msg).not.toContain('()');
  });

  it('mentions external solver for hCaptcha / FunCaptcha', () => {
    expect(describeCaptcha('hcaptcha')).toMatch(/external solver|2captcha|CapSolver/i);
    expect(describeCaptcha('funcaptcha')).toMatch(/external solver|CapSolver/i);
  });

  it('mentions stealth/fingerprint for score-based captchas', () => {
    expect(describeCaptcha('recaptcha-v3')).toMatch(/fingerprint|stealth|proxy/i);
    expect(describeCaptcha('turnstile')).toMatch(/stealth|proxy|fingerprint/i);
  });
});
