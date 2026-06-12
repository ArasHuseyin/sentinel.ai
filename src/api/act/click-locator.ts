import type { Locator } from 'playwright';

type WarnLogger = (level: 1 | 2 | 3, message: string) => void;

/**
 * Click a locator with a universal fallback for pointer-intercept
 * errors. Playwright's `locator.click()` runs an actionability check
 * that times out when a decorative overlay sits on top of the real
 * target — typical on sites that style native `<select>`s, wrap
 * `<button>`s with chrome elements, or put `aria-hidden="true"`
 * labels over an interactive element (Amazon's `a-dropdown-prompt`
 * over the sort `<select>`, Bootstrap label-covered checkboxes, MUI
 * ripple spans, etc.).
 *
 * On the intercept error only, retry via
 * `locator.evaluate(el => el.click())` — dispatches a synthetic
 * `click` MouseEvent directly on the target element, bypassing
 * pointer routing entirely. Any delegated `click` listener, React
 * `onClick`, or `data-action` handler still fires; overlays don't
 * swallow it. Other errors (timeout on truly invisible elements,
 * detached nodes) re-throw unchanged — the fallback must not mask
 * real actionability problems.
 *
 * Scope: left-click only. Right-click and double-click need
 * different event dispatches and keep Playwright's native paths.
 */
export async function clickLocator(
  locator: Locator,
  options: { timeout?: number } = {},
  warn?: WarnLogger
): Promise<void> {
  try {
    await locator.click(options);
  } catch (err: any) {
    const msg = err?.message ?? '';
    if (/intercepts pointer events|intercept.*pointer events/i.test(msg)) {
      warn?.(2, `[Act] Pointer-intercept detected — retrying via DOM-level click`);
      await locator.evaluate((el: HTMLElement) => el.click());
      return;
    }
    throw err;
  }
}
