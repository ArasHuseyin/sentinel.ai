import type { Page } from 'playwright';
import type { CaptchaType } from '../types/errors.js';

/**
 * Result of a CAPTCHA detection scan on the current page.
 * `type === null` means no CAPTCHA found.
 */
export interface CaptchaDetection {
  type: CaptchaType | null;
  /** iframe URL or element selector that matched — useful for debugging. */
  source?: string;
}

/**
 * Detects common CAPTCHA widgets on the current page via pure DOM pattern
 * matching. No network calls, no third-party libraries, no library-specific
 * workarounds — matches on publicly documented CAPTCHA iframe URLs and
 * widget element selectors that every CAPTCHA vendor uses for embedding.
 *
 * Detection priorities (earlier wins if multiple are present):
 *   1. reCAPTCHA v2 — `iframe[src*="recaptcha/api2/anchor"]` or `.g-recaptcha`
 *   2. reCAPTCHA v3 — `iframe[src*="recaptcha/api2/bframe"]` (with no anchor)
 *   3. hCaptcha    — `iframe[src*="hcaptcha.com"]` or `[data-hcaptcha-widget-id]`
 *   4. Turnstile   — `iframe[src*="challenges.cloudflare.com"]` or `.cf-turnstile`
 *   5. FunCaptcha  — `iframe[src*="arkoselabs.com"]` or `[data-pkey]`
 *
 * Returns `null` type when no CAPTCHA is present — cheap no-op call.
 */
export async function detectCaptcha(page: Page): Promise<CaptchaDetection> {
  try {
    return await page.evaluate((): CaptchaDetection => {
      // Check iframes first — most CAPTCHAs embed via iframe
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const iframe of iframes) {
        const src = iframe.src || '';
        if (src.includes('recaptcha/api2/anchor') || src.includes('recaptcha/enterprise/anchor')) {
          return { type: 'recaptcha-v2', source: src };
        }
        if (src.includes('recaptcha/api2/bframe') || src.includes('recaptcha/enterprise/bframe')) {
          return { type: 'recaptcha-v3', source: src };
        }
        if (src.includes('hcaptcha.com')) {
          return { type: 'hcaptcha', source: src };
        }
        if (src.includes('challenges.cloudflare.com')) {
          return { type: 'turnstile', source: src };
        }
        if (src.includes('arkoselabs.com') || src.includes('funcaptcha.com')) {
          return { type: 'funcaptcha', source: src };
        }
      }
      // Fallback: widget-container selectors (CAPTCHA loaded but iframe not yet)
      if (document.querySelector('.g-recaptcha, [data-sitekey][data-callback]')) {
        return { type: 'recaptcha-v2', source: '.g-recaptcha' };
      }
      if (document.querySelector('.h-captcha, [data-hcaptcha-widget-id]')) {
        return { type: 'hcaptcha', source: '.h-captcha' };
      }
      if (document.querySelector('.cf-turnstile, [data-turnstile-callback]')) {
        return { type: 'turnstile', source: '.cf-turnstile' };
      }
      if (document.querySelector('[data-pkey]')) {
        return { type: 'funcaptcha', source: '[data-pkey]' };
      }
      return { type: null };
    });
  } catch {
    // Page may have navigated away during evaluation — treat as no CAPTCHA.
    return { type: null };
  }
}

/**
 * Produces a human-readable error message for each CAPTCHA type so users
 * can diagnose and pick a solving strategy (manual, external API, etc.).
 */
export function describeCaptcha(type: CaptchaType, source?: string): string {
  const src = source ? ` (${source})` : '';
  switch (type) {
    case 'recaptcha-v2':
      return `reCAPTCHA v2 detected${src}. Interactive checkbox challenge — ` +
        `auto-solve may work if the browser fingerprint looks human, otherwise ` +
        `an external solver (2captcha, CapSolver) is required.`;
    case 'recaptcha-v3':
      return `reCAPTCHA v3 detected${src}. Invisible score-based challenge — ` +
        `no UI to interact with. Success depends entirely on browser fingerprint ` +
        `and IP reputation. Use stealth patches and residential proxies.`;
    case 'hcaptcha':
      return `hCaptcha detected${src}. Image-selection challenge — requires an ` +
        `external solver (2captcha, CapSolver) or human intervention.`;
    case 'turnstile':
      return `Cloudflare Turnstile detected${src}. Usually auto-resolves within ` +
        `5-10 seconds for non-suspicious traffic. If it blocks, improve stealth ` +
        `patches or use a residential proxy.`;
    case 'funcaptcha':
      return `FunCaptcha (Arkose Labs) detected${src}. Interactive puzzle — ` +
        `requires a specialised external solver (e.g. CapSolver's Arkose module). ` +
        `No reliable programmatic solving without it.`;
    case 'unknown':
      return `Unknown CAPTCHA widget detected${src}. Manual intervention or a ` +
        `generic external solver is required.`;
  }
}
