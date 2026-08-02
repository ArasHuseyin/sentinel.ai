import type { Page } from 'playwright';
import type { UIElement } from '../../core/state-parser.js';
import { ActionError } from '../../types/errors.js';
import { ignoreRejection } from '../../utils/ignore-rejection.js';

/** A point in viewport coordinates, ready to hand to `page.mouse`. */
export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * Coordinates so far outside the document that no amount of scrolling will
 * bring them into view.
 *
 * The AOM occasionally reports values like `y = -3184` for elements a widget
 * has just re-parented (Booking.com's autocomplete is the reproducible case).
 * Scrolling towards them wastes two round-trips and then fails; the caller
 * skips straight to a locator instead.
 */
const IMPOSSIBLE_COORDINATE_THRESHOLD = -500;

/** Default assumed when Playwright reports no viewport (headless edge cases). */
const FALLBACK_VIEWPORT = { width: 1920, height: 1080 };

export function documentCentroid(target: UIElement): ViewportPoint {
  const { x, y, width, height } = target.boundingClientRect;
  return { x: x + width / 2, y: y + height / 2 };
}

export function hasImpossibleCoordinates(point: ViewportPoint): boolean {
  return point.y < IMPOSSIBLE_COORDINATE_THRESHOLD || point.x < IMPOSSIBLE_COORDINATE_THRESHOLD;
}

/**
 * Current scroll offset, normalised.
 *
 * Both the rejection path and a malformed result collapse to the origin.
 * Treating a missing offset as 0 is right: if we cannot read the scroll
 * position, the document-space centroid is the best estimate available, and
 * the viewport bounds check below still rejects anything implausible. Reading
 * `undefined` through and doing arithmetic on it would instead produce NaN
 * coordinates, which pass every comparison and land the click nowhere.
 */
async function readScrollOffset(page: Page): Promise<ViewportPoint> {
  const raw = await page
    .evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    .catch(() => null);
  const x = (raw as ViewportPoint | null)?.x;
  const y = (raw as ViewportPoint | null)?.y;
  return {
    x: typeof x === 'number' && Number.isFinite(x) ? x : 0,
    y: typeof y === 'number' && Number.isFinite(y) ? y : 0,
  };
}

function isInsideViewport(point: ViewportPoint, viewport: { width: number; height: number }) {
  return point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height;
}

/**
 * Converts an element's document-space centroid into viewport coordinates,
 * scrolling it into view when necessary.
 *
 * Two scroll attempts, in order:
 *  1. Centre the element in the viewport via `window.scrollTo`.
 *  2. Scroll to the top and re-measure — SPAs that hijack scrolling (custom
 *     containers, scroll-locking modals) frequently ignore the first attempt,
 *     and from the top the element's own layout position is usually correct.
 *
 * @throws ActionError when the element is still unreachable after both attempts.
 */
export async function resolveViewportPoint(page: Page, target: UIElement): Promise<ViewportPoint> {
  const centroid = documentCentroid(target);
  const viewport = page.viewportSize() ?? FALLBACK_VIEWPORT;

  let offset = await readScrollOffset(page);
  let point = { x: centroid.x - offset.x, y: centroid.y - offset.y };

  if (!isInsideViewport(point, viewport)) {
    await page.evaluate(
      ({ x, y }: ViewportPoint) => {
        window.scrollTo({
          left: Math.max(0, x - window.innerWidth / 2),
          top: Math.max(0, y - window.innerHeight / 2),
          behavior: 'instant',
        });
      },
      { x: centroid.x, y: centroid.y }
    );
    await page.waitForTimeout(100);
    offset = await readScrollOffset(page);
    point = { x: centroid.x - offset.x, y: centroid.y - offset.y };
  }

  if (!isInsideViewport(point, viewport)) {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(ignoreRejection);
    await page.waitForTimeout(100);
    offset = await readScrollOffset(page);
    point = { x: centroid.x - offset.x, y: centroid.y - offset.y };
  }

  if (!isInsideViewport(point, viewport)) {
    throw new ActionError(
      `Element "${target.name}" is outside viewport at (${point.x.toFixed(0)}, ${point.y.toFixed(0)}) even after scrolling`,
      { element: target.name, x: point.x, y: point.y }
    );
  }

  return point;
}

/**
 * Reads the accessible label of whatever sits at `point`, for comparison
 * against the element we meant to hit.
 *
 * Walks up to five levels up from the hit node looking for a label, because the
 * topmost element at a coordinate is usually an unlabelled presentational span
 * inside the control that actually carries the name.
 *
 * @returns the lower-cased label, or '' when nothing identifiable is there.
 */
export async function readLabelAtPoint(page: Page, point: ViewportPoint): Promise<string> {
  return page
    .evaluate(({ x, y }: ViewportPoint) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return '';
      let node: HTMLElement | null = el;
      for (let d = 0; d < 5 && node; d++) {
        const label =
          node.getAttribute('aria-label') ||
          node.getAttribute('placeholder') ||
          node.getAttribute('name') ||
          '';
        if (label) return label.toLowerCase();
        const labelledBy = node.getAttribute('aria-labelledby');
        if (labelledBy) {
          const ref = document.getElementById(labelledBy);
          if (ref) return ref.textContent?.trim().toLowerCase() || '';
        }
        node = node.parentElement;
      }
      return el.textContent?.trim().slice(0, 40).toLowerCase() || '';
    }, point)
    .catch(() => '');
}

/**
 * Decides whether the label found at the click point contradicts the intended
 * target badly enough to abandon coordinates.
 *
 * Deliberately lenient. Partial containment in either direction counts as a
 * match, since accessible names are routinely truncated or decorated. Technical
 * ids (dotted, no spaces — `auto.fahrzeug.erstbesitzv-radiogroup`) are the name
 * of the *container* a control sits in, so they are never treated as a
 * mismatch; the old strict comparison rejected legitimate radio-group hits.
 */
export function isCoordinateMismatch(hitName: string, targetName: string): boolean {
  if (!hitName || !targetName) return false;
  const target = targetName.toLowerCase();
  const hitIsTechnicalId = /^[\w.-]+$/.test(hitName) && hitName.includes('.');
  return (
    !hitIsTechnicalId &&
    hitName.length > 2 &&
    target.length > 2 &&
    !hitName.includes(target) &&
    !target.includes(hitName)
  );
}
