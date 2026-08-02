import type { Page } from 'playwright';
import type { UIElement } from '../../core/state-parser.js';
import { ActionError } from '../../types/errors.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { ignoreRejection } from '../../utils/ignore-rejection.js';
import { parseDateValue, formatNativeInputValue, pickDateFromPopup } from './datepicker.js';
import type { ViewportPoint } from './coordinates.js';

/**
 * Date and time filling, in three strategies.
 *
 * The DOM offers no way to ask "what kind of date control is this", so the shape
 * is classified in the page first and the strategy follows from the answer.
 *
 *  1. **Native** `<input type="date|time|datetime-local|month|week">` — format to
 *     the ISO shape the type demands and write through the native setter.
 *     Typing into these opens the OS picker, which is not automatable.
 *  2. **Writable wrapped input** (MUI, Ant Design, react-datepicker) — click,
 *     select-all, type, commit with Tab.
 *  3. **Popup-only** (flatpickr with a readonly input, pure-UI calendars) — open
 *     the calendar and navigate it.
 */

/** Levels to walk up from the hit node while classifying. */
const CLASSIFY_DEPTH = 6;

const NATIVE_DATE_SELECTOR =
  'input[type="date"], input[type="time"], input[type="datetime-local"], ' +
  'input[type="month"], input[type="week"]';

type Classification =
  { kind: 'native'; type: string } | { kind: 'writable' } | { kind: 'popup' } | { kind: 'unknown' };

async function classify(page: Page, point: ViewportPoint): Promise<Classification> {
  return page.evaluate(
    ({ x, y, sel, depth }: { x: number; y: number; sel: string; depth: number }) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!hit) return { kind: 'unknown' as const };
      let node: HTMLElement | null = hit;
      for (let d = 0; d < depth && node; d++) {
        const nativeHere: HTMLInputElement | null = node.matches?.(sel)
          ? (node as HTMLInputElement)
          : node.querySelector<HTMLInputElement>(sel);
        if (nativeHere) return { kind: 'native' as const, type: nativeHere.type };

        const writable = Array.from(node.querySelectorAll<HTMLInputElement>('input')).find(
          i =>
            i.offsetParent !== null &&
            !i.disabled &&
            !i.readOnly &&
            i.type !== 'hidden' &&
            i.type !== 'button' &&
            i.type !== 'submit'
        );
        if (writable) return { kind: 'writable' as const };
        node = node.parentElement;
      }
      return { kind: 'popup' as const };
    },
    { x: point.x, y: point.y, sel: NATIVE_DATE_SELECTOR, depth: CLASSIFY_DEPTH }
  );
}

async function writeNativeDate(page: Page, point: ViewportPoint, formatted: string): Promise<void> {
  await page.evaluate(
    ({
      x,
      y,
      val,
      sel,
      depth,
    }: {
      x: number;
      y: number;
      val: string;
      sel: string;
      depth: number;
    }) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!hit) return;
      let input: HTMLInputElement | null = null;
      let node: HTMLElement | null = hit;
      for (let d = 0; d < depth && node && !input; d++) {
        input = node.matches?.(sel)
          ? (node as HTMLInputElement)
          : node.querySelector<HTMLInputElement>(sel);
        if (!input) node = node.parentElement;
      }
      if (!input) return;
      // Native setter, not `.value =` — see the note in slider.ts on
      // framework-controlled inputs.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      input.focus();
      setter?.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    },
    { x: point.x, y: point.y, val: formatted, sel: NATIVE_DATE_SELECTOR, depth: CLASSIFY_DEPTH }
  );
}

/**
 * Fills a date/time control.
 *
 * @returns true when the control was handled. False means the value could not be
 *          parsed as a date or the control could not be classified, and the
 *          caller should fall through to a generic text fill — a date field with
 *          a free-text format is still a text field.
 * @throws  ActionError when a popup calendar was opened but could not be
 *          navigated to the requested date; failing loudly beats leaving a
 *          half-open calendar and reporting success.
 */
export async function fillDateLike(
  page: Page,
  target: UIElement,
  value: string,
  point: ViewportPoint,
  humanLike: boolean
): Promise<boolean> {
  const parts = parseDateValue(value);
  const classification = await classify(page, point);

  if (classification.kind === 'native' && parts) {
    const formatted = formatNativeInputValue(classification.type, parts);
    if (formatted) {
      await writeNativeDate(page, point, formatted);
      return true;
    }
  }

  if (classification.kind === 'writable') {
    await withTimeout(page.mouse.click(point.x, point.y), 10_000, `focus "${target.name}"`);
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(50);
    const typeDelay = humanLike ? 90 + Math.round(Math.random() * 40) : 90;
    await page.keyboard.type(value, { delay: typeDelay });
    await page.keyboard.press('Tab').catch(ignoreRejection);
    return true;
  }

  if (classification.kind === 'popup' && parts?.year && parts.month && parts.day) {
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(400);
    const ok = await pickDateFromPopup(page, parts);
    if (!ok) {
      await page.keyboard.press('Escape').catch(ignoreRejection);
      throw new ActionError(
        `Could not navigate datepicker popup for "${target.name}" to ${parts.year}-${parts.month}-${parts.day}`,
        { element: target.name, value }
      );
    }
    return true;
  }

  return false;
}
