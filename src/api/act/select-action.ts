import type { Page } from 'playwright';
import type { UIElement } from '../../core/state-parser.js';
import { withTimeout } from '../../utils/with-timeout.js';
import {
  focusDropdownPopupInput,
  trySetNativeSelectValue,
  clickBestMatchingOption,
  isListboxPopoverVisible,
  ensurePopoverClosed,
} from './dropdown.js';
import type { ViewportPoint } from './coordinates.js';

/**
 * The `select` action.
 *
 * Four shapes hide behind one AOM role. In order of preference:
 *
 *  1. **Popover already open** — a prior step opened it, so pick the visible
 *     option. Clicking the trigger again would toggle it shut, and the native
 *     setter shortcut is wrong here: sites that back a custom widget with a
 *     hidden `<select>` route user intent through the widget, so setting the
 *     value succeeds silently while the UI never reacts.
 *  2. **Native `<select>`** — drive it through its value setter. The AOM reports
 *     native selects as `combobox`, which used to send them down the custom
 *     dropdown path: that path cannot work, because the popup is OS-owned and
 *     invisible to the DOM, and its ancestor-walk for a search input could grab
 *     an unrelated field elsewhere on the page.
 *  3. **Custom dropdown with a search input** — open, type, click the match.
 *  4. **Custom dropdown without one** — open, click the match. Typing here is
 *     actively harmful: keystrokes reach the body, which on many sites closes
 *     the popover or focuses a global search bar, destroying the options.
 */
export async function performSelect(
  page: Page,
  target: UIElement,
  value: string | undefined,
  point: ViewportPoint
): Promise<void> {
  const popoverAlreadyOpen = await isListboxPopoverVisible(page);
  if (popoverAlreadyOpen && value) {
    const clicked = await clickBestMatchingOption(page, value).catch(() => false);
    if (clicked) {
      await ensurePopoverClosed(page, point.x, point.y);
      return;
    }
    // Match failed — fall through to a fresh open+select.
  }

  if (value && (await trySetNativeSelectValue(page, point.x, point.y, value))) {
    return;
  }

  if (!popoverAlreadyOpen) {
    await withTimeout(page.mouse.click(point.x, point.y), 10_000, `open select "${target.name}"`);
  }

  if (target.role !== 'combobox' && target.role !== 'listbox') {
    // Native <select> fallback for when the upfront detection missed — e.g. an
    // overlay sits on top of the element at the click coordinates.
    await page.evaluate(
      ({ x, y, val }: { x: number; y: number; val: string }) => {
        const el = document.elementFromPoint(x, y) as HTMLSelectElement | null;
        if (el && el.tagName === 'SELECT') {
          const opt = Array.from(el.options).find(o => o.text === val || o.value === val);
          if (opt) {
            el.value = opt.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      },
      { x: point.x, y: point.y, val: value || '' }
    );
    return;
  }

  const activeIsInput = await page
    .evaluate(() => {
      const active = document.activeElement;
      return active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA';
    })
    .catch(() => false);

  let hasInput = activeIsInput;
  if (!hasInput) {
    await page.waitForTimeout(300);
    hasInput = await focusDropdownPopupInput(page, point.x, point.y);
  }

  if (hasInput) {
    await page.keyboard.type(value || '');
    await page.waitForTimeout(500);
  } else {
    // No search input — give the popover a beat to render its options, then go
    // straight to match-and-click.
    await page.waitForTimeout(200);
  }

  const clicked = await clickBestMatchingOption(page, value || '').catch(() => false);
  if (!clicked) {
    // Enter confirms the highlighted option in native dropdowns; custom
    // popovers may ignore it, which is what ensurePopoverClosed is for.
    await page.keyboard.press('Enter');
  }

  // Universal close: if the trigger's aria-expanded is still true near our click
  // coordinates, dispatch Escape. Spec-compliant widgets have already closed, so
  // the check returns false and Escape is skipped.
  await ensurePopoverClosed(page, point.x, point.y);
}
