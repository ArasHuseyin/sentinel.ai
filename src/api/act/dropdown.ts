import type { Page } from 'playwright';
import { ignoreRejection } from '../../utils/ignore-rejection.js';

/**
 * Focuses the first visible text input inside an open
 * combobox/listbox/menu popup. Returns `true` if focus moved (or was
 * already on a text input), `false` if no usable input was found.
 *
 * Scopes the search in order of specificity:
 *   1. `aria-controls` / `aria-owns` target(s) on the combobox root.
 *   2. The combobox's own subtree (covers MUI `Autocomplete` and most
 *      libraries whose dropdown wraps both trigger and listbox).
 *   3. Any visible `[role="listbox"|"dialog"|"menu"|"tree"]` not
 *      already contained by the combobox — fallback for portal-rendered
 *      popups that detach from the DOM hierarchy.
 */
export async function focusDropdownPopupInput(
  page: Page,
  clickX: number,
  clickY: number,
): Promise<boolean> {
  return await page.evaluate(
    ({ x, y }: { x: number; y: number }) => {
      // Already-focused input from the click itself (MUI TextField,
      // plain `<input role="combobox">`) — nothing more to do.
      const active = document.activeElement as HTMLElement | null;
      if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return true;

      const trigger = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!trigger) return false;

      const INPUT_SEL =
        'input[role="combobox"], input[role="searchbox"], input[type="search"], input[type="text"], ' +
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])';

      const isVisible = (el: Element): boolean => {
        const he = el as HTMLElement;
        const r = he.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        if (he.offsetParent === null) {
          // offsetParent is null for `position: fixed` — fall back to
          // computed visibility so portal-rendered popups still qualify.
          const cs = getComputedStyle(he);
          if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        }
        return true;
      };

      const firstVisibleInput = (root: Element | null): HTMLInputElement | null => {
        if (!root) return null;
        const inputs = root.querySelectorAll<HTMLInputElement>(INPUT_SEL);
        for (const inp of Array.from(inputs)) {
          if (!inp.disabled && !inp.readOnly && isVisible(inp)) return inp;
        }
        return null;
      };

      const comboRoot =
        (trigger.closest('[role="combobox"], [role="listbox"]')) ?? trigger;

      // Scope 1: aria-controls / aria-owns target(s).
      const controlsAttr = comboRoot.getAttribute('aria-controls') || comboRoot.getAttribute('aria-owns');
      if (controlsAttr) {
        for (const id of controlsAttr.split(/\s+/).filter(Boolean)) {
          const popup = document.getElementById(id);
          const input = firstVisibleInput(popup);
          if (input) { input.focus(); input.select?.(); return true; }
        }
      }

      // Scope 2: combobox's own subtree.
      const ownInput = firstVisibleInput(comboRoot);
      if (ownInput) { ownInput.focus(); ownInput.select?.(); return true; }

      // Scope 3: any visible popup-role element. Excludes the combobox
      // itself (already covered by scope 2) and `aria-hidden` nodes.
      const popups = document.querySelectorAll<HTMLElement>(
        '[role="listbox"], [role="dialog"], [role="menu"], [role="tree"]'
      );
      for (const p of Array.from(popups)) {
        if (p === comboRoot || comboRoot.contains(p) || p.contains(comboRoot)) continue;
        if (p.getAttribute('aria-hidden') === 'true') continue;
        if (!isVisible(p)) continue;
        const input = firstVisibleInput(p);
        if (input) { input.focus(); input.select?.(); return true; }
      }

      return false;
    },
    { x: clickX, y: clickY }
  ).catch(() => false);
}

/**
 * Detects a native `<select>` at `(clickX, clickY)` and sets its value
 * directly via the prototype value setter + `change` event.
 *
 * Returns `true` when handled — the caller should skip any mouse click
 * and the custom-dropdown flow entirely. The AOM reports native selects
 * as `combobox`, so without this detection they would incorrectly
 * follow the click-to-open-popup path (which can't drive OS dropdowns
 * and whose fallback input search was the original bug).
 *
 * Matching is lenient: exact text, exact value, or case-insensitive
 * substring on the option's text. This covers locale-differing labels
 * („Beste Ergebnisse" vs. "Featured") where the LLM supplied the
 * English value but options are localised.
 */
export async function trySetNativeSelectValue(
  page: Page,
  clickX: number,
  clickY: number,
  value: string,
): Promise<boolean> {
  return await page.evaluate(
    ({ x, y, val }: { x: number; y: number; val: string }) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!hit) return false;
      const sel = (hit.closest?.('select') ?? hit.querySelector?.('select'));
      if (!sel) return false;

      const trimmed = val.trim();
      const lower = trimmed.toLowerCase();
      const match =
        Array.from(sel.options).find(o => o.text.trim() === trimmed || o.value === trimmed) ??
        Array.from(sel.options).find(o => o.text.trim().toLowerCase() === lower) ??
        Array.from(sel.options).find(o => o.text.trim().toLowerCase().includes(lower));
      if (!match) return false;

      // Use the native prototype setter so framework-controlled selects
      // (React/Vue v-model) see the change as user-originated. A plain
      // `sel.value = …` assignment gets swallowed by the framework's
      // wrapped descriptor.
      // Detaching the setter is the point — it is re-bound via .call(sel, …).
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      sel.focus();
      setter?.call(sel, match.value);
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.blur();
      return true;
    },
    { x: clickX, y: clickY, val: value }
  ).catch(() => false);
}

/**
 * Clicks the option in an open dropdown/listbox that best matches
 * `value`. Returns `true` on a confirmed click, `false` when no option
 * scored high enough to trust.
 *
 * Two universal bugs this replaces in the older selectors:
 *
 * 1. **Wrapper-vs-option ambiguity.** The previous query
 *    `'[role="option"], [role="listbox"] li, …'` returned
 *    `<li role="presentation">` wrappers *before* their inner
 *    `<a role="option">` because `querySelectorAll` returns in
 *    document-tree order, not selector-order. Sites like Amazon pin
 *    the click handler on the inner anchor and read `data-value`
 *    off it; dispatching `.click()` on the outer `<li>` fires the
 *    handler with `event.target = <li>`, so the handler finds no
 *    `data-value` on the target and silently no-ops. We now query
 *    explicit `[role="option"]` first (the accessible option itself),
 *    and only fall back to structural listbox children when no
 *    explicit option exists — and within a chosen wrapper, we drill
 *    down to the interactive descendant before clicking.
 *
 * 2. **Asymmetric substring matching.** The previous check
 *    `text === val || text.includes(val)` failed when the option
 *    text was an *abbreviation* of the LLM-provided value (Amazon:
 *    option `"Durchschn. Kundenbewertung"`, LLM passes the full
 *    `"Durchschnittliche Kundenbewertung"`). Scoring now combines
 *    normalization (lowercase, punctuation-stripped, whitespace-
 *    collapsed), bi-directional substring, and token-overlap with
 *    `startsWith` so `durchschnittliche` matches the option's
 *    `durchschn.` token. A 0.5 coverage threshold keeps low-overlap
 *    false matches out.
 */
export async function clickBestMatchingOption(page: Page, value: string): Promise<boolean> {
  if (!value) return false;
  return await page.evaluate(
    ({ val }: { val: string }) => {
      const normalize = (s: string): string =>
        s.toLowerCase().replace(/[\s.,:;!?()[\]{}"'·•/\\-]+/g, ' ').trim();
      const normVal = normalize(val);
      if (!normVal) return false;
      const valTokens = normVal.split(/\s+/).filter(t => t.length > 1);

      const isInteractable = (el: HTMLElement): boolean => {
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        const r = el.getBoundingClientRect();
        return r.width >= 1 && r.height >= 1;
      };

      // Primary pool: explicit ARIA options (the accessible element
      // the screen reader / keyboard focus would land on).
      const explicit = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .filter(isInteractable);
      // Structural fallback: listboxes whose items don't use the
      // explicit role (older code, pre-ARIA listboxes). `:not(
      // [role="presentation"])` excludes wrapper <li>s like Amazon's.
      const structural = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="listbox"] li:not([role="presentation"]), ' +
        '[role="listbox"] div[id]:not([role="presentation"])'
      )).filter(isInteractable);

      const pools: HTMLElement[][] = explicit.length > 0
        ? [explicit]
        : [structural];
      if (pools.length === 0 || pools[0]!.length === 0) return false;

      const score = (text: string): number => {
        const n = normalize(text);
        if (!n) return 0;
        if (n === normVal) return 100;
        if (n.includes(normVal)) return 80;   // option longer than val
        if (normVal.includes(n)) return 70;   // option shorter than val (abbreviation)
        if (valTokens.length === 0) return 0;
        const textTokens = n.split(/\s+/);
        const overlap = valTokens.filter(vt =>
          textTokens.some(tt => tt === vt || tt.startsWith(vt) || vt.startsWith(tt))
        ).length;
        const coverage = overlap / Math.max(valTokens.length, textTokens.length);
        return coverage >= 0.5 ? Math.round(50 * coverage) : 0;
      };

      let best: { el: HTMLElement; score: number } | null = null;
      for (const pool of pools) {
        for (const opt of pool) {
          // Prefer the element's accessible label if provided —
          // falls back to textContent for the common case.
          const label =
            opt.getAttribute('aria-label') ||
            opt.textContent || '';
          const s = score(label);
          if (s > 0 && (!best || s > best.score)) best = { el: opt, score: s };
        }
        if (best) break; // don't fall through to structural pool once explicit matched
      }

      if (!best) return false;

      // Drill down to the most specific clickable descendant when the
      // matched element is a wrapper. Synthetic `.click()` events do
      // not bubble from a parent to its children, so if the site's
      // click handler reads `event.target`/`data-value` off the inner
      // element, clicking the wrapper misses. When the match is
      // already an `<a>`, `<button>`, or `[role="option"]`, there's
      // nothing more specific to find.
      const isSpecific = best.el.matches('[role="option"], a, button, input, [onclick]');
      const interactive = isSpecific
        ? best.el
        : (best.el.querySelector<HTMLElement>(
            '[role="option"], a[href], a[data-value], button, [tabindex="0"], [onclick]'
          ) ?? best.el);
      interactive.click();
      return true;
    },
    { val: value }
  ).catch(() => false);
}

/**
 * Returns true if a listbox/menu popover with at least one visible
 * `[role="option"]` is currently rendered anywhere on the page.
 *
 * Used by the `select` action to avoid clicking the combobox trigger when
 * the popover is already open — that would toggle it shut and wipe the
 * options before we can pick one. Works universally for any WAI-ARIA
 * combobox pattern; widgets that don't mark their options with `role`
 * fall back to the unconditional open-click path.
 */
export async function isListboxPopoverVisible(page: Page): Promise<boolean> {
  const result = await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    for (const opt of options) {
      if (opt.getAttribute('aria-hidden') === 'true') continue;
      if (opt.offsetParent === null) continue;
      const r = opt.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) return true;
    }
    return false;
  }).catch(() => false);
  // Strict boolean — page.evaluate may return unexpected shapes in edge
  // cases (test mocks, weird serialization). Anything non-true means
  // "don't skip the open-click".
  return result === true;
}

/**
 * Best-effort guarantee that a combobox/dropdown popover has closed
 * after a selection action. Idempotent — a no-op on pages that
 * already closed correctly.
 *
 * Signal: any element with `aria-expanded="true"` whose centroid lies
 * within ~250 px of the click coordinates. Per WAI-ARIA 1.2, the
 * combobox trigger MUST toggle `aria-expanded` with its popup state;
 * a lingering `true` value after commit means the widget's internal
 * close handler did not fire (common on sites that pin close-handlers
 * to `mousedown` or `isTrusted` click events, both of which
 * Playwright's synthetic click loses). We then dispatch `Escape`,
 * which every ARIA-conformant widget (and most non-conformant ones)
 * treats as a dismiss signal.
 *
 * The 250 px proximity check is the safety net: it prevents Escape
 * from dismissing unrelated expanded widgets elsewhere on the page
 * (e.g. a sidebar accordion that legitimately stays open).
 */
export async function ensurePopoverClosed(
  page: Page,
  clickX: number,
  clickY: number,
): Promise<void> {
  await page.waitForTimeout(150);
  const stuck = await page.evaluate(
    ({ x, y }: { x: number; y: number }) => {
      const expanded = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-expanded="true"]')
      );
      for (const el of expanded) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (Math.hypot(cx - x, cy - y) < 250) return true;
      }
      return false;
    },
    { x: clickX, y: clickY }
  ).catch(() => false);
  if (stuck) {
    await page.keyboard.press('Escape').catch(ignoreRejection);
  }
}
