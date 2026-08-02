import type { ElementHandle, Page } from 'playwright';
import type { UIElement } from '../../core/state-parser.js';
import { ignoreRejection } from '../../utils/ignore-rejection.js';
import type { ViewportPoint } from './coordinates.js';

/**
 * Slider filling, in three strategies.
 *
 * Sliders are the widest-varying control on the web: a native
 * `<input type="range">`, a paired number field, or a pure-ARIA thumb with no
 * input behind it at all. Each needs a different mechanism, and which one
 * applies can only be determined in the page.
 *
 *  1. **Native range input** — write through the native value setter.
 *  2. **Sibling numeric input** — the visible slider is decorative and a text
 *     field next to it holds the value (price filters do this constantly).
 *  3. **Keyboard** — ARIA-only sliders respond to arrow keys and nothing else.
 */

/** Upper bound on arrow-key presses, so a bad min/max cannot spin forever. */
const MAX_ARROW_PRESSES = 500;

/** Levels to walk up when hunting for a container holding a numeric input. */
const SIBLING_SEARCH_DEPTH = 8;

/** Levels to walk up when hunting for the focusable slider element. */
const SLIDER_SEARCH_DEPTH = 8;

type SliderStrategy = 'range' | 'sibling' | 'keyboard' | 'none';

interface SliderRange {
  min: number;
  max: number;
  now: number;
}

/**
 * Resolves the slider through Playwright's accessible-name lookup.
 *
 * Preferred over the click coordinates because the AOM's rect for a slider is
 * frequently the whole track or an ancestor group — Amazon reports its price
 * slider's centroid up under the page header.
 */
async function resolveSliderHandle(page: Page, target: UIElement): Promise<ElementHandle | null> {
  try {
    const locator = page.getByRole('slider', { name: target.name, exact: false }).first();
    return await locator.elementHandle({ timeout: 2000 });
  } catch {
    return null;
  }
}

/** Runs strategies 1 and 2 in the page; returns which one applied. */
async function trySetterStrategies(
  page: Page,
  handle: ElementHandle | null,
  point: ViewportPoint,
  value: string
): Promise<SliderStrategy> {
  return page.evaluate(
    ({
      slider,
      x,
      y,
      val,
      siblingDepth,
    }: {
      slider: Node | null;
      x: number;
      y: number;
      val: string;
      siblingDepth: number;
    }) => {
      const sliderEl =
        (slider as HTMLElement | null) ?? (document.elementFromPoint(x, y) as HTMLElement | null);
      if (!sliderEl) return 'none' as const;

      // Controlled-input bypass: frameworks (React, Preact, Solid, Vue with
      // v-model) replace the value descriptor on the input instance to track
      // their own state. A direct `.value = val` assignment writes to the
      // framework-wrapped setter and is ignored / reverted on the next
      // re-render. Using the native HTMLInputElement.prototype setter writes to
      // the real DOM property, which the subsequent `input` event then carries
      // back into the framework's state tree as a user-originated change.
      // Universal across any framework built on controlled inputs — no
      // library-specific detection.
      const writeNative = (input: HTMLInputElement, next: string) => {
        // Detaching the setter is the point — re-bound via .call() below.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set;
        input.focus();
        nativeSetter?.call(input, next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };

      // Strategy 1: native range input
      const rangeInput =
        sliderEl.tagName === 'INPUT' && (sliderEl as HTMLInputElement).type === 'range'
          ? (sliderEl as HTMLInputElement)
          : (sliderEl.querySelector('input[type="range"]') as HTMLInputElement | null);
      if (rangeInput) {
        writeNative(rangeInput, val);
        return 'range' as const;
      }

      // Strategy 2: sibling text/number/tel input in a shared container.
      let container: HTMLElement | null = sliderEl;
      for (let depth = 0; depth < siblingDepth && container; depth++) {
        const inputs = Array.from(
          container.querySelectorAll<HTMLInputElement>(
            'input[type="text"], input[type="tel"], input[type="number"], input:not([type])'
          )
        ).filter(inp => inp.offsetParent !== null && !inp.disabled && !inp.readOnly);

        if (inputs.length > 0) {
          // Pick the input closest to the slider's centroid — a price filter has
          // a min and a max field and only proximity distinguishes them.
          const sliderRect = sliderEl.getBoundingClientRect();
          const sx = sliderRect.left + sliderRect.width / 2;
          const sy = sliderRect.top + sliderRect.height / 2;
          const closest = inputs
            .map(inp => {
              const r = inp.getBoundingClientRect();
              return {
                inp,
                dist: Math.hypot(r.left + r.width / 2 - sx, r.top + r.height / 2 - sy),
              };
            })
            .sort((a, b) => a.dist - b.dist)[0];

          if (closest) {
            writeNative(closest.inp, val);
            return 'sibling' as const;
          }
        }
        container = container.parentElement;
      }

      return 'keyboard' as const;
    },
    { slider: handle, x: point.x, y: point.y, val: value, siblingDepth: SIBLING_SEARCH_DEPTH }
  );
}

/**
 * Focuses the real slider element and reads its ARIA range.
 *
 * Many component libraries (MUI, Chakra, Radix) put `role="slider"` on an inner
 * thumb and the ARIA attributes only on that thumb, while `elementFromPoint` at
 * the centroid returns the track or a styled wrapper. Arrow keys only move the
 * thumb when the thumb is the active element, so the walk and the `focus()` here
 * are what make strategy 3 work at all.
 */
async function focusSliderAndReadRange(
  page: Page,
  handle: ElementHandle | null,
  point: ViewportPoint
): Promise<SliderRange | null> {
  return page
    .evaluate(
      ({ slider, x, y, depth }: { slider: Node | null; x: number; y: number; depth: number }) => {
        const hit =
          (slider as HTMLElement | null) ?? (document.elementFromPoint(x, y) as HTMLElement | null);
        if (!hit) return null;

        // Walk up (bounded), checking the node and its descendants at each
        // level. Preference order when both exist in the same subtree:
        //   1. input[type="range"] — native keyboard handling, reliable focus
        //      target, value stays in sync with aria-valuenow.
        //   2. [role="slider"] — explicit ARIA role on a custom element the
        //      library listens to for keydown.
        let sliderEl: HTMLElement | null = null;
        let cursor: HTMLElement | null = hit;
        for (let d = 0; d < depth && cursor && !sliderEl; d++) {
          const nativeInput = cursor.matches?.('input[type="range"]')
            ? (cursor as HTMLInputElement)
            : cursor.querySelector<HTMLInputElement>('input[type="range"]');
          if (nativeInput) {
            sliderEl = nativeInput;
            break;
          }
          if (cursor.matches?.('[role="slider"]')) {
            sliderEl = cursor;
            break;
          }
          sliderEl = cursor.querySelector<HTMLElement>('[role="slider"]');
          if (!sliderEl) cursor = cursor.parentElement;
        }
        if (!sliderEl) return null;

        // Focus inside the evaluate so page.keyboard.press arrow events land on
        // the active element without a round-trip in between.
        sliderEl.focus();

        // ARIA may live on a sibling thumb when we focused the native input.
        const readAria = (attr: string): string | null => {
          const own = sliderEl!.getAttribute(attr);
          if (own !== null) return own;
          const sibling = sliderEl!.parentElement?.querySelector(`[${attr}]`);
          return sibling?.getAttribute(attr) ?? null;
        };
        const min = parseFloat(readAria('aria-valuemin') ?? '0');
        const max = parseFloat(readAria('aria-valuemax') ?? '100');
        // A native range input's .value is authoritative and always numeric.
        const inputValue = (sliderEl as HTMLInputElement).value;
        const parsedInput = inputValue !== undefined ? parseFloat(inputValue) : NaN;
        const now = !isNaN(parsedInput)
          ? parsedInput
          : parseFloat(readAria('aria-valuenow') ?? String(min));
        return { min, max, now };
      },
      { slider: handle, x: point.x, y: point.y, depth: SLIDER_SEARCH_DEPTH }
    )
    .catch(() => null);
}

/**
 * Sets a slider to `value`.
 *
 * Terminal: once a target reports `role="slider"` this owns the interaction and
 * the caller does not fall through to a generic fill. A slider that no strategy
 * matched is a slider we could not find, and clicking-and-typing at its
 * coordinates would land on the track — moving the value to wherever the click
 * happened to be, which is worse than doing nothing.
 */
export async function fillSlider(
  page: Page,
  target: UIElement,
  value: string,
  point: ViewportPoint
): Promise<void> {
  const handle = await resolveSliderHandle(page, target);
  try {
    const strategy = await trySetterStrategies(page, handle, point, value);
    if (strategy !== 'keyboard') return;

    const range = await focusSliderAndReadRange(page, handle, point);
    if (!range || isNaN(range.min) || isNaN(range.max)) return;

    const targetValue = parseFloat(value);
    if (isNaN(targetValue) || targetValue < range.min || targetValue > range.max) return;

    // Belt and braces: framework effects sometimes steal focus back after the
    // evaluate returns, so re-focus through the handle when we have one.
    if (handle) await handle.focus().catch(ignoreRejection);

    const steps = Math.round(targetValue - range.now);
    const key = steps >= 0 ? 'ArrowRight' : 'ArrowLeft';
    const presses = Math.min(Math.abs(steps), MAX_ARROW_PRESSES);
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(key);
    }
  } finally {
    if (handle) await handle.dispose().catch(ignoreRejection);
  }
}
