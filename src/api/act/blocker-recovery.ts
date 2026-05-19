import type { Locator, Page } from 'playwright';
import type { SimplifiedState, UIElement } from '../../core/state-parser.js';
import type { ActionType } from './types.js';
import { ActionError } from '../../types/errors.js';
import { clickLocator } from './click-locator.js';
import { waitForPageSettle } from './page-settle.js';

type Logger = (level: 1 | 2 | 3, message: string) => void;

/** Callback into ActionEngine's `performAction` for cookie-banner dismissal. */
export type PerformActionCallback = (action: ActionType, target: UIElement) => Promise<void>;

/** Callback into ActionEngine's locator resolution for semantic fallback. */
export type FindBestLocator = (target: UIElement) => Promise<Locator>;

/**
 * Two related fallback paths used when the primary AOM/coordinate flow
 * cannot proceed:
 *
 *  - `tryRecover` — proactive blocker dismissal (cookie banner, vendor
 *    overlay widgets, modal Escape). Called from `Sentinel.goto()` and
 *    from the act() retry loop when the planner can't find a target.
 *  - `performSemanticFallback` — last-resort Playwright-locator path
 *    using the element's role + accessible name, dispatched per action
 *    type. Used when coordinate-click and vision-grounding both fail.
 */
export class BlockerRecovery {
  constructor(
    private readonly page: Page,
    private readonly log: Logger,
    private readonly warn: Logger,
    private readonly domSettleTimeoutMs: number,
  ) {}

  async tryRecover(
    state: SimplifiedState,
    performAction: PerformActionCallback,
  ): Promise<boolean> {
    // Pattern 1: Cookie/consent banner dismissal.
    //
    // Historical footguns that this version guards against:
    //  - Substring matching of "accept" in product names ("Eczema Association
    //    Accepted" is NOT a cookie control).
    //  - German `"alle "` as an accept token matched "Alle 3 in den Einkauf" —
    //    the agent was actually adding items to the cart.
    //  - A loose fallback picked any button whose name vaguely matched the
    //    candidate regex, clicking e.g. "Continue shopping" interstitials.
    //
    // Three stacked constraints make false positives effectively impossible
    // while keeping real cookie banners matchable:
    //   1. Page-level CONTEXT: at least one element must mention cookies /
    //      consent / GDPR / privacy / Datenschutz. A product page for face
    //      towels has no such element, so Pattern 1 never fires there.
    //   2. LENGTH cap: consent-dismiss labels are always short
    //      ("Accept all", "Alle akzeptieren"). 50-char ceiling excludes
    //      every product name and every compound cart button.
    //   3. ANCHORED accept regex with word boundaries: must START with the
    //      accept intent so "Accepted" (inside "Eczema Association
    //      Accepted") can't match, and "alle" alone does not match (the
    //      keyword requires "alle akzeptieren" / "alle cookies").
    // Consent context detection: either a cookie/consent/GDPR keyword in any
    // element name, OR the characteristic accept+reject button pair (e.g. MUI's
    // "Allow analytics" + "Essential only" — no interactive element carries the
    // keyword, the header is a non-interactive text node outside the AOM we parse).
    const hasConsentKeywordContext = state.elements.some(e =>
      /\b(cookies?|consent|gdpr|dsgvo|datenschutz|privacy|datenverarbeitung|privatsph[aä]re)\b/i.test(e.name)
    );
    const hasAcceptRejectPair =
      state.elements.some(e => /^\s*allow (all|analytics|cookies|tracking|selected)\s*$/i.test(e.name)) &&
      state.elements.some(e => /^\s*(essential only|only (essential|necessary)|reject( all| cookies)?|nur (erforderlich|notwendig)|ablehnen|optionale cookies ablehnen)\s*$/i.test(e.name));
    const hasConsentContext = hasConsentKeywordContext || hasAcceptRejectPair;
    if (hasConsentContext) {
      const MAX_CONSENT_BUTTON_LEN = 50;
      const acceptPattern =
        /^\s*(akzeptieren|accept( all| cookies| and (continue|close))?|zustimmen|einverstanden|i ?agree|got it|verstanden|alle[s]? (akzeptieren|cookies? (akzeptieren|zulassen)?|annehmen)|allow (all|analytics|cookies|tracking|selected))\s*$/i;
      const settingsPattern =
        /einstell|manage|settings|preferences|verwalten|anpassen|nur (erforderlich|notwendig)|only (essential|necessary)|mehr (erfahren|infos?)|learn more/i;
      const cookieElement = state.elements.find(e =>
        (e.role === 'button' || e.role === 'link') &&
        e.name.trim().length <= MAX_CONSENT_BUTTON_LEN &&
        acceptPattern.test(e.name) &&
        !settingsPattern.test(e.name)
      );
      if (cookieElement) {
        this.log(2, `[Act] Recovery: dismissing cookie banner via "${cookieElement.name}"`);
        try {
          await performAction('click', cookieElement);
          await waitForPageSettle(this.page, this.domSettleTimeoutMs);
          return true;
        } catch { /* recovery failed, continue */ }
      }
    }

    // Pattern 2: Remove pointer-intercepting widgets (marketing popups,
    // chat widgets, newsletter overlays).
    //
    // The selector is intentionally vendor-specific instead of matching
    // generic `[class*="popup"]` / `[class*="overlay"]`. CSS frameworks
    // (Amazon's `a-overlay-*`, Bootstrap, Material) use those tokens
    // for non-blocking primitives — product-image hover overlays, lazy-
    // load placeholders, dropdown-popover roots. Removing them on every
    // step destroys the page: on Amazon search results the old greedy
    // selector wiped 17+ framework nodes per step and made the sort
    // dropdown unstable.
    //
    // We now only remove:
    //  - Named third-party vendor widgets (getsitecontrol, intercom,
    //    drift, zendesk, hubspot, tawk, freshchat, usabilla) — these
    //    are exclusively overlay popups/chat bubbles with no legitimate
    //    in-flow use.
    //  - Elements carrying the explicit `aria-modal="true"` contract —
    //    WAI-ARIA signals a blocking dialog unambiguously.
    //
    // Plus a structural sanity check: the candidate must be positioned
    // (fixed/absolute) with a non-trivial size AND either high z-index
    // OR explicit aria-modal, before we `.remove()` it. Stops stray
    // decorative absolute-positioned spans from being wiped.
    try {
      const removed = await this.page.evaluate(() => {
        const blockers = document.querySelectorAll(
          'getsitecontrol-widget, ' +
          '[class*="getsitecontrol"], ' +
          '[class*="intercom-"], [id*="intercom-"], ' +
          '[class*="drift-frame"], [class*="drift-widget"], ' +
          '[class*="zendesk-"], [id*="zendesk-"], ' +
          '[id*="hubspot-messages"], ' +
          '[id*="fc_frame"], ' +                  // Freshchat
          '[id*="tawk-container"], [class*="tawk-"], ' +
          '[class*="usabilla-"], ' +
          '[aria-modal="true"]'
        );
        let count = 0;
        for (const el of Array.from(blockers)) {
          const he = el as HTMLElement;
          const style = window.getComputedStyle(he);
          if (style.position !== 'fixed' && style.position !== 'absolute') continue;
          const rect = he.getBoundingClientRect();
          // Must be visibly sized — decorative tiny absolutes don't block.
          if (rect.width < 80 || rect.height < 80) continue;
          const z = parseInt(style.zIndex || '0', 10) || 0;
          const isAriaModal = he.getAttribute('aria-modal') === 'true';
          // Either elevated z-index (overlay-typical) or explicit
          // aria-modal. Excludes decorative absolutely-positioned
          // elements at default stacking.
          if (!isAriaModal && z < 100) continue;
          he.remove();
          count++;
        }
        return count;
      });
      if (removed > 0) {
        this.log(2, `[Act] Recovery: removed ${removed} pointer-intercepting widget(s)`);
        return true;
      }
    } catch { /* evaluate failed */ }

    // Pattern 3: Generic modal close (Escape key). Skip when a listbox/menu
    // popover is visible — Escape would close our own open dropdown, not the
    // blocker. Safety net in case the upstream `hasBlocker` check was called
    // in a context where the listbox guard didn't apply.
    const hasModal = state.elements.some(e => e.region === 'modal' || e.region === 'popup');
    if (hasModal) {
      const listboxOpen = await this.page.evaluate(() => {
        const nodes = document.querySelectorAll('[role="option"], [role="listbox"], [role="menu"]');
        for (const n of Array.from(nodes) as HTMLElement[]) {
          if (n.offsetParent !== null) {
            const r = n.getBoundingClientRect();
            if (r.width >= 1 && r.height >= 1) return true;
          }
        }
        return false;
      }).catch(() => false);
      if (listboxOpen) {
        this.log(2, `[Act] Recovery: Escape skipped — listbox popover is open`);
        return false;
      }
      this.log(2, `[Act] Recovery: pressing Escape to close modal/popup`);
      try {
        await this.page.keyboard.press('Escape');
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        return true;
      } catch { /* recovery failed */ }
    }

    return false;
  }

  async performSemanticFallback(
    action: ActionType,
    target: UIElement | null,
    value: string | undefined,
    findBestLocator: FindBestLocator,
  ): Promise<void> {
    if (action === 'scroll-down' && !target) {
      await this.page.mouse.wheel(0, 600);
      return;
    }
    if (action === 'scroll-up' && !target) {
      await this.page.mouse.wheel(0, -600);
      return;
    }

    if (!target) throw new ActionError('No target element for semantic fallback', { action });

    const locator = await findBestLocator(target);

    switch (action) {
      case 'click':
        if (target.role === 'radio' || target.role === 'checkbox') {
          try { await locator.check({ timeout: 5000 }); }
          catch { await clickLocator(locator, { timeout: 5000 }, this.warn); }
        } else {
          await clickLocator(locator, { timeout: 5000 }, this.warn);
        }
        break;
      case 'double-click':
        await locator.dblclick({ timeout: 5000 });
        break;
      case 'right-click':
        await locator.click({ button: 'right', timeout: 5000 });
        break;
      case 'fill':
        await locator.fill(value || '', { timeout: 5000 });
        break;
      case 'append':
        await locator.focus({ timeout: 5000 });
        await locator.press('End');
        await locator.pressSequentially(value || '', { delay: 30 });
        break;
      case 'hover':
        await locator.hover({ timeout: 5000 });
        break;
      case 'press':
        await locator.focus({ timeout: 5000 });
        await locator.press(value || 'Enter');
        break;
      case 'select':
        await locator.selectOption(value || '', { timeout: 5000 });
        break;
      case 'scroll-to':
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
        break;
      case 'scroll-down':
        await locator.evaluate(el => el.scrollBy(0, 300));
        break;
      case 'scroll-up':
        await locator.evaluate(el => el.scrollBy(0, -300));
        break;
    }
  }
}
