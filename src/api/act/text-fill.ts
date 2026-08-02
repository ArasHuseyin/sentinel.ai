import type { Page } from 'playwright';
import type { UIElement } from '../../core/state-parser.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { focusDropdownPopupInput, clickBestMatchingOption } from './dropdown.js';
import type { ViewportPoint } from './coordinates.js';

/** Base per-character typing delay. Fast enough to be usable, slow enough that
 *  debounced autocompletes and input validators actually see each keystroke. */
const TYPE_DELAY_MS = 90;

/** Extra random delay added on top when `humanLike` is on. */
const HUMAN_JITTER_MS = 40;

function typeDelay(humanLike: boolean): number {
  return humanLike ? TYPE_DELAY_MS + Math.round(Math.random() * HUMAN_JITTER_MS) : TYPE_DELAY_MS;
}

/**
 * Types `value` into the control at `point`, replacing whatever is there.
 *
 * Combobox and listbox targets get one extra step: after the opening click, the
 * dropdown's own search input is located through the ARIA popup contract
 * (`aria-controls` / `aria-owns`, the trigger's subtree, or a visible
 * popup-role element) and focused, so the keystrokes reach the filter rather
 * than the page. When that worked, the best matching option is clicked
 * afterwards — completing the interaction in one act() instead of requiring a
 * separate click step.
 *
 * See `focusDropdownPopupInput` for the scope rules: it never ascends to
 * ancestor containers, so it cannot grab an unrelated input elsewhere.
 */
export async function fillText(
  page: Page,
  target: UIElement,
  value: string | undefined,
  point: ViewportPoint,
  humanLike: boolean
): Promise<void> {
  await withTimeout(page.mouse.click(point.x, point.y), 10_000, `focus "${target.name}"`);

  let isDropdownInput = false;
  if (target.role === 'combobox' || target.role === 'listbox') {
    isDropdownInput = await focusDropdownPopupInput(page, point.x, point.y);
    if (!isDropdownInput) {
      // The popup may still be animating in — one retry after a beat.
      await page.waitForTimeout(300);
      isDropdownInput = await focusDropdownPopupInput(page, point.x, point.y);
    }
  }

  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type(value || '', { delay: typeDelay(humanLike) });

  if (isDropdownInput && value) {
    await page.waitForTimeout(400); // let the filter re-render
    await clickBestMatchingOption(page, value).catch(() => false);
  }
}

/**
 * Appends `value` to the control at `point` without clearing it.
 *
 * `End` then `Control+End` moves the caret to the end of the line and then to
 * the end of the content, which covers both single-line inputs and textareas.
 */
export async function appendText(
  page: Page,
  target: UIElement,
  value: string | undefined,
  point: ViewportPoint,
  humanLike: boolean
): Promise<void> {
  await withTimeout(page.mouse.click(point.x, point.y), 10_000, `focus "${target.name}"`);
  await page.keyboard.press('End');
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(150);
  await page.keyboard.type(value || '', { delay: typeDelay(humanLike) });
}
