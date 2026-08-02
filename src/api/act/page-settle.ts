import type { Page } from 'playwright';
import { ignoreRejection } from '../../utils/ignore-rejection.js';

/**
 * Waits for the DOM to stabilise after an action.
 *
 * Two-signal strategy (universal, no library-specific selectors):
 *
 *   1. MutationObserver — resolves after `stabilityMs` of DOM silence.
 *      Handles classic re-renders where React/Vue/etc swap in content
 *      and then stop touching the tree.
 *
 *   2. Loading-indicator detection — DOES NOT resolve while any of these
 *      are visible, regardless of mutation silence:
 *        - `[aria-busy="true"]`  (WAI-ARIA standard)
 *        - `[role="progressbar"]` (visible)
 *        - visible elements whose class contains `loading`/`skeleton`/`spinner`
 *      This catches modern SPAs where the initial render fires fast but
 *      real content arrives 3-8 s later (Shopify, Airbnb, many GraphQL
 *      apps). Without this check the old 3 s cap expired mid-skeleton.
 *
 * Hard cap: min(timeout, 8 000) ms — safety net for pages whose loading
 * indicators never disappear (broken spinners, animated placeholders).
 * Typical real settle time: 300 ms – 2 s.
 */
export async function waitForPageSettle(page: Page, timeout = 5000): Promise<void> {
  const stabilityMs = 300;
  const hardCapMs = Math.min(timeout, 8000);

  const domSettle = page.evaluate(
    ({ stabilityMs, hardCapMs }: { stabilityMs: number; hardCapMs: number }) =>
      new Promise<void>(resolve => {
        const start = Date.now();
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        let done = false;

        const finish = (): void => {
          if (done) return;
          done = true;
          observer.disconnect();
          if (silenceTimer) clearTimeout(silenceTimer);
          resolve();
        };

        const hasLoadingSignal = (): boolean => {
          // WAI-ARIA standard: aria-busy signals "work in progress"
          if (document.querySelector('[aria-busy="true"]')) return true;
          // Explicit progress indicator (W3C role)
          const pb = document.querySelector('[role="progressbar"]');
          if (pb && (pb as HTMLElement).offsetParent !== null) return true;
          // Common class-name heuristics — tolerant of any CSS framework
          const candidates = document.querySelectorAll(
            '[class*="loading" i], [class*="skeleton" i], [class*="spinner" i]'
          );
          for (const el of Array.from(candidates)) {
            if ((el as HTMLElement).offsetParent !== null) return true;
          }
          return false;
        };

        const armSilenceTimer = (): void => {
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            silenceTimer = null;
            // Stability reached. Release only if no loading indicator is
            // still visible — otherwise wait for the next mutation, which
            // will re-arm this timer.
            if (!hasLoadingSignal()) finish();
          }, stabilityMs);
        };

        const observer = new MutationObserver(armSilenceTimer);
        observer.observe(document.body, { childList: true, subtree: true });
        armSilenceTimer(); // kick off

        // Hard-cap safety net — always release eventually
        setTimeout(finish, hardCapMs);
        void start;
      }),
    { stabilityMs, hardCapMs }
  ).catch(ignoreRejection);

  const navigationSettle = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: hardCapMs,
  }).catch(ignoreRejection);

  await Promise.race([domSettle, navigationSettle]);
}
