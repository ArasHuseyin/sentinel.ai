import type { Frame, Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { UIElement, SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { VisionGrounding } from '../core/vision-grounding.js';
import type { ILocatorCache } from '../core/locator-cache.js';
import { generateSelector } from '../core/selector-generator.js';
import { withTimeout } from '../utils/with-timeout.js';
import { ActionError } from '../types/errors.js';

export interface ActOptions {
  variables?: Record<string, string>;
  retries?: number;
}

export interface ActionAttempt {
  path: 'coordinate-click' | 'vision-grounding' | 'locator-fallback';
  error: string;
}

export interface ActionResult {
  success: boolean;
  message: string;
  action?: string;
  /**
   * Stable CSS selector for the element that was interacted with.
   * Omitted for scroll actions, failed actions, or when no stable selector
   * could be derived. Useful for exporting selectors into Playwright tests.
   */
  selector?: string;
  /** Present on failure — describes each attempted path and its error. */
  attempts?: ActionAttempt[];
}

export type ActionType =
  | 'click'
  | 'fill'
  | 'append'
  | 'hover'
  | 'press'
  | 'select'
  | 'double-click'
  | 'right-click'
  | 'scroll-down'
  | 'scroll-up'
  | 'scroll-to'
  | 'upload'
  | 'drag';

/**
 * Replaces %variable% placeholders in an instruction string.
 */
function interpolateVariables(instruction: string, variables?: Record<string, string>): string {
  if (!variables) return instruction;
  return instruction.replace(/%(\w+)%/g, (_, key) => variables[key] ?? `%${key}%`);
}

/**
 * Waits for the DOM to stabilise after an action.
 *
 * Uses a MutationObserver to detect when the DOM stops changing (300 ms of
 * silence) rather than `networkidle`, which is unreliable on SPAs that keep
 * persistent WebSocket / SSE connections open. Falls back gracefully if the
 * page is in the middle of a navigation (no body) or if the evaluate call
 * fails for any reason.
 *
 * Typical settle time: ~300 ms.  Hard cap: min(timeout, 3 000) ms.
 */
async function waitForPageSettle(page: Page, timeout = 3000): Promise<void> {
  const stabilityMs = 300;
  const hardCapMs = Math.min(timeout, 3000);

  const domSettle = page.evaluate(
    ({ stabilityMs, hardCapMs }: { stabilityMs: number; hardCapMs: number }) =>
      new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> = setTimeout(resolve, stabilityMs);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(resolve, stabilityMs);
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
        });
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, hardCapMs);
      }),
    { stabilityMs, hardCapMs }
  ).catch(() => {});

  const navigationSettle = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: hardCapMs,
  }).catch(() => {});

  await Promise.race([domSettle, navigationSettle]);
}

// ─── Bézier mouse movement ────────────────────────────────────────────────────

/**
 * Moves the mouse from (x0,y0) to (x1,y1) along a cubic Bézier curve
 * with two random control points — produces a natural, human-like arc.
 *
 * Steps are scaled to the distance: short movements use fewer points,
 * long diagonal swipes use up to 40. Typical duration: ~120–180 ms.
 */
async function moveMouse(
  page: Page,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Promise<void> {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(8, Math.min(40, Math.round(dist / 15)));

  // Random control points displaced perpendicular to the straight line
  const perp = { x: -dy / dist || 0, y: dx / dist || 0 };
  const c1Offset = (0.2 + Math.random() * 0.3) * dist;
  const c2Offset = (0.2 + Math.random() * 0.3) * dist;
  const cx1 = x0 + dx * 0.25 + perp.x * c1Offset * (Math.random() > 0.5 ? 1 : -1);
  const cy1 = y0 + dy * 0.25 + perp.y * c1Offset * (Math.random() > 0.5 ? 1 : -1);
  const cx2 = x0 + dx * 0.75 + perp.x * c2Offset * (Math.random() > 0.5 ? 1 : -1);
  const cy2 = y0 + dy * 0.75 + perp.y * c2Offset * (Math.random() > 0.5 ? 1 : -1);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const bx = u * u * u * x0 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x1;
    const by = u * u * u * y0 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y1;
    await page.mouse.move(bx, by);
    // Non-uniform timing — faster in the middle, slower at start/end
    const delay = 4 + Math.round(8 * Math.sin(Math.PI * t));
    await page.waitForTimeout(delay);
  }
}

// ─── Failure diagnostics ──────────────────────────────────────────────────────

function buildFailureMessage(
  instruction: string,
  target: UIElement | null,
  attempts: ActionAttempt[]
): string {
  const elementName = target ? `"${target.name}"` : 'the target element';
  const errors = attempts.map(a => `  • ${a.path}: ${a.error}`).join('\n');

  // Detect root cause and suggest a fix
  const allErrors = attempts.map(a => a.error.toLowerCase()).join(' ');

  let tip = '';
  if (allErrors.includes('outside viewport') || allErrors.includes('scroll')) {
    tip = `Tipp: Element könnte außerhalb des sichtbaren Bereichs sein. Versuche zuerst:\n  sentinel.act('scroll to ${elementName}')`;
  } else if (allErrors.includes('timeout') || allErrors.includes('detached') || allErrors.includes('hidden')) {
    tip = `Tipp: Element könnte von einem Modal, Overlay oder Popover verdeckt sein. Schließe überlagernde Elemente zuerst.`;
  } else if (allErrors.includes('no target') || allErrors.includes('not found') || allErrors.includes('could not find')) {
    tip = `Tipp: Element "${instruction}" wurde im DOM nicht gefunden. Möglicherweise in Shadow DOM, iframe oder noch nicht gerendert.`;
  } else if (attempts.length >= 2) {
    tip = `Tipp: Alle Fallback-Pfade erschöpft. Versuche die Instruktion präziser zu formulieren oder aktiviere Vision-Grounding: { visionFallback: true }.`;
  }

  const attemptSummary = attempts.length === 1
    ? `Pfad versucht: ${attempts[0]!.path}`
    : `${attempts.length} Pfade versucht`;

  return [
    `Action fehlgeschlagen: "${instruction}" auf ${elementName}`,
    `${attemptSummary}:\n${errors}`,
    tip,
  ].filter(Boolean).join('\n');
}

// ─── Chunk-Processing ────────────────────────────────────────────────────────

/** Common stop words that should not be used for relevance matching. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'on', 'in', 'to', 'at', 'of', 'by', 'is', 'it',
  'or', 'as', 'do', 'if', 'no', 'up', 'so', 'my', 'we', 'be', 'am',
]);

/**
 * Tokenises a string into lowercase words (≥ 2 chars) for relevance scoring.
 * Filters out common stop words that cause false-positive substring matches.
 */
function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
  )];
}

/**
 * Filters `elements` down to at most `maxCount` entries, keeping those whose
 * role+name overlap most with the instruction. When the page has ≤ maxCount
 * elements the list is returned unchanged. Elements with a relevance score of 0
 * fill remaining slots in their original order (stable sort).
 */
/** Keywords that identify overlay/blocker elements that should never be filtered out. */
const BLOCKER_KEYWORDS = /cookie|consent|akzeptieren|accept all|datenschutz|privacy|zustimmen/i;

export function filterRelevantElements(
  elements: UIElement[],
  instruction: string,
  maxCount: number
): UIElement[] {
  if (elements.length <= maxCount) return elements;

  const tokens = tokenize(instruction);
  if (tokens.length === 0) return elements.slice(0, maxCount);

  // Always-keep: form fields, nearby buttons, and cookie/blocker elements.
  // Form fields are the primary interaction targets — dropping them because their
  // label doesn't keyword-match the (possibly different-language) goal is a bug.
  // Buttons near form fields (submit/proceed) must also be kept — they're the
  // natural next action after filling the form.
  const FORM_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'listbox', 'radio', 'checkbox', 'slider', 'switch', 'datepicker', 'timepicker', 'file']);
  const alwaysKeep: typeof elements = [];
  const rest: typeof elements = [];
  for (const el of elements) {
    if (FORM_ROLES.has(el.role) ||
        ((el.role === 'button' || el.role === 'link') && BLOCKER_KEYWORDS.test(el.name))) {
      alwaysKeep.push(el);
    } else {
      rest.push(el);
    }
  }

  // Also keep buttons/links that are positionally near form fields (submit buttons).
  // Submit buttons are almost always directly below the form — preserving them
  // ensures the LLM can submit after filling, regardless of button label language.
  const formEls = alwaysKeep.filter(e => FORM_ROLES.has(e.role));
  if (formEls.length > 0) {
    const formYs = formEls.map(e => e.boundingClientRect.y);
    const minFormY = Math.min(...formYs);
    const maxFormY = Math.max(...formEls.map(e => e.boundingClientRect.y + e.boundingClientRect.height));
    const margin = Math.max(maxFormY - minFormY, 300);

    for (let i = rest.length - 1; i >= 0; i--) {
      const el = rest[i]!;
      if ((el.role === 'button' || el.role === 'link') &&
          el.boundingClientRect.y >= minFormY - 50 &&
          el.boundingClientRect.y <= maxFormY + margin) {
        alwaysKeep.push(el);
        rest.splice(i, 1);
      }
    }
  }

  const scored = rest.map(el => {
    const text = `${el.role} ${el.name}`
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ');
    let score = 0;
    for (const token of tokens) {
      if (text.includes(token)) score++;
    }
    return { el, score };
  });

  // Stable sort: higher score first, original order preserved for ties
  scored.sort((a, b) => b.score - a.score);
  const remaining = maxCount - alwaysKeep.length;
  return [...alwaysKeep, ...scored.slice(0, Math.max(0, remaining)).map(s => s.el)];
}

/**
 * Returns true if at least one element has a relevance score > 0 for the instruction.
 */
function hasRelevantElements(elements: UIElement[], instruction: string): boolean {
  const tokens = tokenize(instruction);
  if (tokens.length === 0) return true;
  return elements.some(el => {
    const text = `${el.role} ${el.name}`.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    return tokens.some(token => text.includes(token));
  });
}

// ─── Datepicker / Timepicker helpers ─────────────────────────────────────────

export interface DateParts {
  year: number;   // 0 = unset (time-only values)
  month: number;  // 1-12, 0 = unset
  day: number;    // 1-31, 0 = unset
  hour?: number;
  minute?: number;
}

/**
 * Parses a human-entered date/time string into its numeric parts. Supports:
 *  - ISO 8601: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`
 *  - European dot-notation: `DD.MM.YYYY`
 *  - Slash notation: `DD/MM/YYYY` (if day > 12) or `MM/DD/YYYY` (otherwise)
 *  - Time-only: `HH:mm`
 *  - Any format accepted by `Date.parse` as final fallback
 *    (e.g. `October 15, 2026`, `15 Oct 2026`)
 */
export function parseDateValue(value: string): DateParts | null {
  const s = value.trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s);
  if (iso) {
    const year = +iso[1]!, month = +iso[2]!, day = +iso[3]!;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const result: DateParts = { year, month, day };
      if (iso[4] !== undefined) result.hour = +iso[4];
      if (iso[5] !== undefined) result.minute = +iso[5];
      return result;
    }
  }

  const eu = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (eu) {
    const day = +eu[1]!, month = +eu[2]!, year = +eu[3]!;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }

  const sl = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (sl) {
    const a = +sl[1]!, b = +sl[2]!, year = +sl[3]!;
    // If first segment > 12, must be DD/MM; otherwise assume US MM/DD
    if (a > 12 && b <= 12) return { year, month: b, day: a };
    if (a <= 12 && b <= 31) return { year, month: a, day: b };
  }

  const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (timeOnly) {
    const hour = +timeOnly[1]!, minute = +timeOnly[2]!;
    if (hour <= 23 && minute <= 59) return { year: 0, month: 0, day: 0, hour, minute };
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return {
      year: parsed.getFullYear(),
      month: parsed.getMonth() + 1,
      day: parsed.getDate(),
      hour: parsed.getHours(),
      minute: parsed.getMinutes(),
    };
  }

  return null;
}

/** Formats DateParts into the ISO-like string expected by native typed inputs. */
export function formatNativeInputValue(type: string, parts: DateParts): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (type) {
    case 'date':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    case 'time':
      return `${pad(parts.hour ?? 0)}:${pad(parts.minute ?? 0)}`;
    case 'datetime-local':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour ?? 0)}:${pad(parts.minute ?? 0)}`;
    case 'month':
      return `${parts.year}-${pad(parts.month)}`;
    case 'week': {
      // ISO 8601 week number calculation (Thursday-of-week rule)
      const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `${d.getUTCFullYear()}-W${pad(weekNum)}`;
    }
    default:
      return '';
  }
}

/**
 * Strategy 3 helper: navigates an open calendar popup to the target month/year
 * and clicks the day cell. Locale-aware via `Intl.DateTimeFormat` on the page's
 * own declared locale (`<html lang>` / `navigator.language`) — no hardcoded
 * language tables. Navigation buttons are matched by multi-lingual aria-label
 * keywords first, then by header-row position (leftmost=prev, rightmost=next).
 *
 * Returns `true` if a day cell was clicked, `false` if navigation/clicking
 * failed after the bounded retry budget.
 */
async function pickDateFromPopup(page: Page, parts: DateParts): Promise<boolean> {
  for (let attempt = 0; attempt < 36; attempt++) {
    const clicked = await page.evaluate(
      ({ year, month, day }: { year: number; month: number; day: number }) => {
        const locale = document.documentElement.lang || navigator.language || 'en-US';
        const target = new Date(year, month - 1, day);
        const candidates = new Set<string>();
        const safeFormat = (opts: Intl.DateTimeFormatOptions) => {
          try { return new Intl.DateTimeFormat(locale, opts).format(target); } catch { return ''; }
        };
        candidates.add(safeFormat({ year: 'numeric', month: 'long', day: 'numeric' }));
        candidates.add(safeFormat({ year: 'numeric', month: 'short', day: 'numeric' }));
        candidates.add(safeFormat({ year: 'numeric', month: '2-digit', day: '2-digit' }));
        candidates.add(safeFormat({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
        candidates.add(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        candidates.delete('');

        const roots = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"]:not([aria-hidden="true"]), [role="grid"]:not([aria-hidden="true"])'
        )).filter(el => el.offsetParent !== null);
        if (roots.length === 0) return false;
        const root = roots[roots.length - 1]!;

        const cells = Array.from(root.querySelectorAll<HTMLElement>(
          '[role="gridcell"], [role="button"], button, td[role], [data-day]'
        )).filter(c =>
          c.offsetParent !== null &&
          c.getAttribute('aria-disabled') !== 'true' &&
          !(c as HTMLButtonElement).disabled
        );

        // Pass 1: aria-label / title contains any locale-formatted candidate
        for (const cell of cells) {
          const label = cell.getAttribute('aria-label') || cell.getAttribute('title') || '';
          for (const cand of candidates) {
            if (cand && label.includes(cand)) { cell.click(); return true; }
          }
        }

        // Pass 2: text content == day number AND cell not in outside-month state
        const dayStr = String(day);
        for (const cell of cells) {
          const txt = cell.textContent?.trim();
          if (txt !== dayStr) continue;
          const cls = cell.className || '';
          if (/outside|other-?month|adjacent|different-?month/i.test(String(cls))) continue;
          if (cell.getAttribute('aria-selected') === 'false' &&
              cell.getAttribute('tabindex') === '-1' &&
              /disabled|muted/i.test(String(cls))) continue;
          cell.click();
          return true;
        }

        return false;
      },
      { year: parts.year, month: parts.month, day: parts.day }
    ).catch(() => false);

    if (clicked) return true;

    // Determine navigation direction by reading popup header
    const direction = await page.evaluate(
      ({ year, month }: { year: number; month: number }) => {
        const locale = document.documentElement.lang || navigator.language || 'en-US';
        const roots = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"]:not([aria-hidden="true"]), [role="grid"]:not([aria-hidden="true"])'
        )).filter(el => el.offsetParent !== null);
        if (roots.length === 0) return 0;
        const root = roots[roots.length - 1]!;
        const scope = root.parentElement || root;

        const headerEls = Array.from(scope.querySelectorAll<HTMLElement>(
          '[role="heading"], [aria-live], [class*="header"], [class*="caption"], [class*="title"], [class*="label"]'
        ));
        const headerText = (headerEls.map(e => e.textContent || '').join(' ') || scope.textContent || '').toLowerCase();

        let detectedMonth = 0;
        for (let m = 1; m <= 12; m++) {
          for (const style of ['long', 'short'] as const) {
            try {
              const name = new Intl.DateTimeFormat(locale, { month: style })
                .format(new Date(2000, m - 1, 1)).toLowerCase();
              if (name && name.length >= 3 && headerText.includes(name)) { detectedMonth = m; break; }
            } catch { /* locale unavailable */ }
          }
          if (detectedMonth) break;
        }
        const ym = /\b(19|20)\d{2}\b/.exec(headerText);
        const detectedYear = ym ? +ym[0] : 0;
        if (!detectedMonth || !detectedYear) return 0;

        const diff = (year - detectedYear) * 12 + (month - detectedMonth);
        if (diff > 0) return 1;
        if (diff < 0) return -1;
        return 0;
      },
      { year: parts.year, month: parts.month }
    ).catch(() => 0);

    if (direction === 0) return false;

    const navigated = await page.evaluate(
      ({ dir }: { dir: number }) => {
        const roots = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"]:not([aria-hidden="true"]), [role="grid"]:not([aria-hidden="true"])'
        )).filter(el => el.offsetParent !== null);
        if (roots.length === 0) return false;
        const root = roots[roots.length - 1]!;
        const scope = root.parentElement || root;

        const btns = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]'))
          .filter(b => b.offsetParent !== null && !(b as HTMLButtonElement).disabled);
        if (btns.length === 0) return false;

        // Multi-lingual aria-label matching (best effort — covers common European languages)
        const prevPatterns = /prev|back|zur[uü]ck|vorig|vorherig|précédent|precedent|anterior|precedente|vorige|poprzedni|предыдущ/i;
        const nextPatterns = /next|nach|weiter|n[aä]chst|suivant|siguiente|successivo|proch|pr[oó]xim|volgende|nast[eę]pn|следующ/i;

        for (const btn of btns) {
          const label = btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '';
          if (dir > 0 && nextPatterns.test(label)) { btn.click(); return true; }
          if (dir < 0 && prevPatterns.test(label)) { btn.click(); return true; }
        }

        // Fallback: position-based. Header-row buttons (near top of popup):
        // leftmost = prev, rightmost = next.
        const topY = Math.min(...btns.map(b => b.getBoundingClientRect().top));
        const headerBtns = btns.filter(b => {
          const r = b.getBoundingClientRect();
          return r.top - topY < 40; // same header row
        });
        if (headerBtns.length >= 2) {
          headerBtns.sort((a, b) =>
            a.getBoundingClientRect().left - b.getBoundingClientRect().left
          );
          const picked = dir > 0 ? headerBtns[headerBtns.length - 1]! : headerBtns[0]!;
          picked.click();
          return true;
        }
        return false;
      },
      { dir: direction }
    ).catch(() => false);

    if (!navigated) return false;
    await page.waitForTimeout(200);
  }

  return false;
}

/** Max batch-scroll iterations when looking for not-yet-rendered elements. */
const MAX_SCROLL_DISCOVERY_BATCHES = 2;

export class ActionEngine {
  constructor(
    private page: Page,
    private stateParser: StateParser,
    private gemini: LLMProvider,
    private visionGrounding?: VisionGrounding,
    private domSettleTimeoutMs = 3000,
    private locatorCache: ILocatorCache | null = null,
    /** Maximum elements sent to the LLM. Pages with more are pre-filtered by relevance. */
    private maxElements = 50,
    /**
     * Verbosity level inherited from SentinelOptions:
     *  0 = silent
     *  1 = action summary only (default)
     *  2 = + reasoning + fallback warnings
     *  3 = + chunk-processing stats + full LLM decision
     */
    private verbose: 0 | 1 | 2 | 3 = 0,
    /** When true, mouse moves along a Bézier curve and per-action delays are added. */
    private humanLike = false,
    /**
     * Element detection mode:
     *  'aom' (default) — AOM coordinates, vision only as late fallback
     *  'hybrid' — AOM primary, vision on coordinate mismatch
     *  'vision' — Vision as primary, AOM as fallback
     */
    private mode: 'aom' | 'hybrid' | 'vision' = 'aom'
  ) {}

  private log(level: 1 | 2 | 3, message: string): void {
    if (this.verbose >= level) console.log(message);
  }

  private warn(level: 1 | 2 | 3, message: string): void {
    if (this.verbose >= level) console.warn(message);
  }

  /**
   * Executes an action against an element that lives inside an iframe.
   *
   * Uses Playwright's frame-scoped locator API — `frame.getByRole(...)`
   * resolves within the frame's document, so the resulting click / fill /
   * keystroke is routed to the correct context without coordinate math.
   * The `[frame] ` prefix the parser adds for LLM visibility is stripped
   * before locator lookup because the element inside the iframe does not
   * carry that literal accessible name.
   *
   * Limitations (intentional for this iteration):
   *   - No slider / datepicker cascade inside frames — relies on direct fill.
   *   - No vision-grounding fallback inside frames.
   *   - No locator cache for frame elements (frameId is parse-local).
   */
  /**
   * Uploads file(s) to an `<input type="file">` via Playwright's
   * `locator.setInputFiles()`. Accepts a single absolute path or a
   * comma-separated list for multi-file uploads. Works with visually
   * hidden inputs — no click is dispatched.
   *
   * Locator resolution cascades through: accessible label → name/id/aria-label
   * attribute match → first file input in the context. This covers labeled
   * inputs, named inputs, and minimalist pages with a single file control.
   */
  private async performUpload(
    ctx: Page | Frame,
    target: UIElement,
    value: string | undefined
  ): Promise<void> {
    const paths = (value ?? '')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      throw new ActionError('upload requires a file path in "value"', {
        element: target.name,
        action: 'upload',
      });
    }

    const escape = (s: string) => s.replace(/"/g, '\\"');
    const n = escape(target.name);
    const strategies: Array<() => ReturnType<typeof ctx.locator>> = [
      () => ctx.getByLabel(target.name, { exact: false }),
      () => ctx.locator(`input[type="file"][name="${n}"]`),
      () => ctx.locator(`input[type="file"][id="${n}"]`),
      () => ctx.locator(`input[type="file"][aria-label="${n}"]`),
      () => ctx.locator('input[type="file"]'),
    ];

    let lastErr: unknown;
    for (const build of strategies) {
      try {
        await build().first().setInputFiles(paths, { timeout: 3000 });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new ActionError(
      `Could not locate a file input for "${target.name}": ${(lastErr as Error)?.message ?? 'no strategy succeeded'}`,
      { element: target.name, action: 'upload' }
    );
  }

  /**
   * Drags the source element onto the drop target via Playwright's
   * `locator.dragTo()`, which dispatches the full HTML5 drag sequence
   * (dragstart → dragover on target → drop) and handles autoscroll when
   * the target is off-screen. Works for kanban boards, reorderable lists,
   * and file-manager-style drops.
   */
  private async performDrag(
    ctx: Page | Frame,
    source: UIElement,
    dropTarget: UIElement
  ): Promise<void> {
    const FRAME_PREFIX = '[frame] ';
    const strip = (s: string) => s.startsWith(FRAME_PREFIX) ? s.slice(FRAME_PREFIX.length) : s;

    const srcLocator = ctx
      .getByRole(source.role as Parameters<Page['getByRole']>[0], { name: strip(source.name), exact: false })
      .first();
    const dstLocator = ctx
      .getByRole(dropTarget.role as Parameters<Page['getByRole']>[0], { name: strip(dropTarget.name), exact: false })
      .first();

    await srcLocator.dragTo(dstLocator, { timeout: 10_000 });
  }

  private async executeInFrame(
    frame: Frame,
    action: ActionType,
    target: UIElement,
    value?: string,
    dropTarget?: UIElement | null
  ): Promise<void> {
    const FRAME_PREFIX = '[frame] ';
    const nameInFrame = target.name.startsWith(FRAME_PREFIX)
      ? target.name.slice(FRAME_PREFIX.length)
      : target.name;

    const locator = frame
      .getByRole(target.role as Parameters<Frame['getByRole']>[0], { name: nameInFrame, exact: false })
      .first();

    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

    switch (action) {
      case 'click':
        await locator.click({ timeout: 10_000 });
        break;
      case 'double-click':
        await locator.dblclick({ timeout: 10_000 });
        break;
      case 'right-click':
        await locator.click({ button: 'right', timeout: 10_000 });
        break;
      case 'hover':
        await locator.hover({ timeout: 10_000 });
        break;
      case 'fill':
        await locator.fill(value ?? '', { timeout: 10_000 });
        break;
      case 'append':
        await locator.focus({ timeout: 10_000 });
        await this.page.keyboard.press('End');
        await this.page.keyboard.type(value ?? '', { delay: 90 });
        break;
      case 'press':
        await locator.focus({ timeout: 10_000 });
        await this.page.keyboard.press(value || 'Enter');
        break;
      case 'select':
        // Native <select> → selectOption; custom dropdown → click + type + Enter.
        try {
          await locator.selectOption(value ?? '', { timeout: 3000 });
        } catch {
          await locator.click({ timeout: 5000 });
          if (value) {
            await this.page.keyboard.type(value, { delay: 90 });
            await frame.waitForTimeout(300);
            await this.page.keyboard.press('Enter');
          }
        }
        break;
      case 'scroll-down':
        await frame.evaluate(() => { window.scrollBy(0, 300); });
        break;
      case 'scroll-up':
        await frame.evaluate(() => { window.scrollBy(0, -300); });
        break;
      case 'scroll-to':
        // scrollIntoViewIfNeeded already ran above; nothing more to do.
        break;
      case 'upload':
        await this.performUpload(frame, target, value);
        break;
      case 'drag':
        if (!dropTarget) {
          throw new ActionError('drag requires a drop-target element', { action });
        }
        if (dropTarget.frameId && dropTarget.frameId !== target.frameId) {
          throw new ActionError(
            'Cross-frame drag is not supported — source and drop target must share the same frame',
            { source: target.name, target: dropTarget.name }
          );
        }
        await this.performDrag(frame, target, dropTarget);
        break;
    }
  }

  async act(instruction: string, options?: ActOptions): Promise<ActionResult> {
    const resolvedInstruction = interpolateVariables(instruction, options?.variables);
    const state = await this.stateParser.parse();

    // ── Self-Healing Locator: cache lookup ────────────────────────────────────
    if (this.locatorCache) {
      const cached = this.locatorCache.get(state.url, resolvedInstruction);
      if (cached) {
        const target = state.elements.find(
          e => e.role === cached.role && e.name === cached.name
        ) ?? null;
        if (target) {
          const actionLabel = `${cached.action} on "${target.name}" (${target.role}) [cached]`;
          this.log(1, `[Act] ⚡ ${actionLabel}`);
          this.stateParser.invalidateCache();
          try {
            await this.performAction(cached.action, target, cached.value);
            await waitForPageSettle(this.page, this.domSettleTimeoutMs);
            return {
              success: true,
              message: `Successfully performed ${cached.action} on "${target.name}" (cached)`,
              action: actionLabel,
            };
          } catch {
            // Cached action failed — invalidate and fall through to LLM
            this.locatorCache.invalidate(state.url, resolvedInstruction);
          }
        } else {
          // Element no longer in DOM — invalidate stale entry
          this.locatorCache.invalidate(state.url, resolvedInstruction);
        }
      }
    }

    // ── Scroll-Discovery: find not-yet-rendered elements ──────────────────────
    // Only scroll when the page has very few elements (likely a loading/empty state)
    // AND no keyword matches exist. When the page has many elements, the LLM can
    // pick the right one even without keyword overlap — scrolling is wasteful.
    let currentState = state;
    const fewButSomeElements = currentState.elements.length > 0 && currentState.elements.length < 10;
    if (fewButSomeElements && !hasRelevantElements(currentState.elements, resolvedInstruction)) {
      this.log(2, `[Act] No relevant elements for "${resolvedInstruction}" — trying scroll discovery`);
      for (let batch = 0; batch < MAX_SCROLL_DISCOVERY_BATCHES; batch++) {
        // Batch: scroll 3 times quickly with short pauses between
        for (let i = 0; i < 3; i++) {
          await this.page.mouse.wheel(0, 600);
          await this.page.waitForTimeout(200);
        }
        await waitForPageSettle(this.page, 500); // Shorter settle for scrolls
        this.stateParser.invalidateCache();
        currentState = await this.stateParser.parse();
        if (hasRelevantElements(currentState.elements, resolvedInstruction)) {
          this.log(2, `[Act] Found relevant element after batch ${batch + 1} scroll`);
          break;
        }
      }
    }

    const visibleElements = filterRelevantElements(currentState.elements, resolvedInstruction, this.maxElements);

    if (currentState.elements.length > visibleElements.length) {
      this.log(3, `[Act] chunk-processing: ${currentState.elements.length} → ${visibleElements.length} elements sent to LLM (instruction: "${resolvedInstruction}")`);
    }

    const prompt = `
      Current Page URL: ${currentState.url}
      Page Title: ${currentState.title}
      Instruction: "${resolvedInstruction}"

      Elements on page (id | role | name | region):
      ${visibleElements.map(e => `${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}${e.value !== undefined ? ` | value="${e.value}"` : ''}`).join('\n')}

      Select the element to interact with and the action to perform.
      Return up to 3 candidate elements ranked by confidence (best first).
      Available actions:
      - "click": single click on an element
      - "double-click": double click on an element
      - "right-click": right-click (context menu) on an element
      - "fill": type text into an input field (requires "value")
      - "append": add text to the end of an input field without clearing existing content (requires "value")
      - "hover": move mouse over an element
      - "press": press a keyboard key or shortcut (requires "value", e.g. "Enter", "Escape", "Tab", "Control+a")
      - "select": pick an option from ANY dropdown — native <select> OR any element whose role is combobox/listbox (requires "value" = option text). This is a one-shot that opens the dropdown, filters to the option, and commits the selection. ALWAYS prefer "select" over "click" when the target is a dropdown and you know which option to pick — "click" only opens the dropdown and leaves you mid-flow.
      - "upload": upload file(s) to an <input type="file"> (requires "value" = absolute path; for multiple files comma-separate: "/a.pdf,/b.pdf"). Prefer this over "click" for elements with role="file".
      - "drag": drag one element onto another (requires "targetElementId" = the drop-target element id). Use for reorderable lists, kanban boards, file-manager style drops.
      - "scroll-down": scroll the page down (elementId optional, use 0 if no specific element)
      - "scroll-up": scroll the page up (elementId optional, use 0 if no specific element)
      - "scroll-to": scroll to bring a specific element into view (requires elementId)

      If the action is "fill", "append", "press", "select", or "upload", provide the "value" field.
      If the action is "drag", provide the "targetElementId" field (the id of the drop target).
      For scroll actions without a target element, set elementId to 0 in the first candidate.
    `;

    const schema = {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              elementId: { type: 'number' },
              confidence: { type: 'number' },
            },
            required: ['elementId'],
          },
        },
        action: {
          type: 'string',
          enum: [
            'click', 'double-click', 'right-click',
            'fill', 'append', 'hover', 'press', 'select',
            'upload', 'drag',
            'scroll-down', 'scroll-up', 'scroll-to',
          ],
        },
        value: { type: 'string' },
        targetElementId: { type: 'number' },
        reasoning: { type: 'string' },
      },
      required: ['candidates', 'action', 'reasoning'],
    };

    const decision = await this.gemini.generateStructuredData<{
      candidates: { elementId: number; confidence?: number }[];
      action: ActionType;
      value?: string;
      targetElementId?: number;
      reasoning: string;
    }>(prompt, schema);

    // Normalize: support old single-elementId responses gracefully
    const candidateIds = decision.candidates?.length
      ? decision.candidates.map(c => c.elementId)
      : [(decision as any).elementId ?? 0];

    // Scroll actions without a target element are valid with elementId = 0
    const isScrollWithoutTarget =
      (decision.action === 'scroll-down' || decision.action === 'scroll-up') &&
      candidateIds[0] === 0;

    this.log(2, `[Act] reasoning: ${decision.reasoning}`);
    this.log(3, `[Act] decision: ${JSON.stringify({ candidates: candidateIds, action: decision.action, value: decision.value })}`);

    // ── Vision-primary mode: use screenshot + vision LLM before AOM coordinates ──
    if (this.mode === 'vision' && this.visionGrounding && !isScrollWithoutTarget) {
      const firstTarget = currentState.elements.find(e => e.id === candidateIds[0]) ?? null;
      if (firstTarget) {
        try {
          const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
          const screenshot = await this.visionGrounding.takeScreenshot(this.page);
          const bbox = await this.visionGrounding.findElement(
            `${decision.action} on "${firstTarget.name}"`,
            screenshot,
            viewport.width,
            viewport.height
          );
          if (bbox) {
            const cx = bbox.x + bbox.width / 2;
            const cy = bbox.y + bbox.height / 2;
            if (decision.action === 'fill' || decision.action === 'append') {
              await this.page.mouse.click(cx, cy);
              await this.page.waitForTimeout(150);
              await this.page.keyboard.press('Control+a');
              await this.page.waitForTimeout(150);
              await this.page.keyboard.type(decision.value || '', { delay: 90 });
            } else {
              await withTimeout(this.page.mouse.click(cx, cy), 10_000, `vision click "${firstTarget.name}"`);
            }
            await waitForPageSettle(this.page, this.domSettleTimeoutMs);
            const selector = await generateSelector(this.page, firstTarget) ?? undefined;
            return {
              success: true,
              message: `Successfully performed ${decision.action} on "${firstTarget.name}" (via Vision)`,
              action: `${decision.action} on "${firstTarget.name}" (${firstTarget.role})`,
              ...(selector !== undefined ? { selector } : {}),
            };
          }
        } catch (visionErr: any) {
          this.warn(2, `[Act] Vision-primary failed: ${visionErr.message} — falling back to AOM`);
        }
      }
    }

    // ── Try each candidate in order ─────────────────────────────────────────
    // On failure, fall through to the next candidate without a new LLM call.
    const attempts: ActionAttempt[] = [];

    for (let ci = 0; ci < candidateIds.length; ci++) {
      const target = isScrollWithoutTarget
        ? null
        : (currentState.elements.find(e => e.id === candidateIds[ci]) ?? null);

      if (!isScrollWithoutTarget && !target) continue; // skip invalid candidate

      const actionLabel = target
        ? `${decision.action} on "${target.name}" (${target.role})`
        : `${decision.action} (page)`;

      if (ci === 0) this.log(1, `[Act] ${actionLabel}`);
      else this.log(2, `[Act] Trying candidate #${ci + 1}: ${actionLabel}`);

      // Pre-action validation: check if element is actually clickable
      if (target && (decision.action === 'click' || decision.action === 'double-click' || decision.action === 'right-click')) {
        const blockReason = await this.validateTarget(target);
        if (blockReason) {
          this.warn(2, `[Act] Target blocked: ${blockReason}`);
          attempts.push({ path: 'coordinate-click', error: blockReason });
          continue; // try next candidate
        }
      }

      // Generate stable selector before action — DOM is still in pre-action state
      const selector = target ? (await generateSelector(this.page, target) ?? undefined) : undefined;

      // Invalidate cache after action – state will change
      this.stateParser.invalidateCache();

      // For drag, resolve the drop-target element alongside the source.
      const dropTarget = decision.action === 'drag' && decision.targetElementId !== undefined
        ? (currentState.elements.find(e => e.id === decision.targetElementId) ?? null)
        : null;

      try {
        await this.performAction(decision.action, target, decision.value, dropTarget);
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        // ── Self-Healing Locator: populate cache on success ──────────────────
        if (this.locatorCache && target && !isScrollWithoutTarget) {
          this.locatorCache.set(currentState.url, resolvedInstruction, {
            action: decision.action,
            role: target.role,
            name: target.name,
            ...(decision.value !== undefined ? { value: decision.value } : {}),
          });
        }
        return {
          success: true,
          message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''}${ci > 0 ? ` (candidate #${ci + 1})` : ''}`,
          action: actionLabel,
          ...(selector !== undefined ? { selector } : {}),
        };
      } catch (err: any) {
        const errorMsg: string = err.message ?? '';
        attempts.push({ path: 'coordinate-click', error: `candidate #${ci + 1}: ${errorMsg}` });
        this.warn(2, `[Act] Candidate #${ci + 1} failed: ${errorMsg}`);

        // If a widget/overlay intercepts pointer events, remove it and retry THIS candidate
        if (errorMsg.includes('intercepts pointer events') && ci === 0) {
          this.log(2, `[Act] Pointer-intercepting element detected — removing and retrying`);
          try {
            await this.page.evaluate(() => {
              document.querySelectorAll(
                'getsitecontrol-widget, [class*="popup"], [class*="overlay"], [id*="widget"], [class*="chat-widget"], [class*="intercom"]'
              ).forEach(el => {
                const s = window.getComputedStyle(el);
                if (s.position === 'fixed' || s.position === 'absolute' || s.zIndex > '999') el.remove();
              });
            });
            // Retry the same candidate after removing the blocker
            await this.performAction(decision.action, target, decision.value, dropTarget);
            await waitForPageSettle(this.page, this.domSettleTimeoutMs);
            if (this.locatorCache && target && !isScrollWithoutTarget) {
              this.locatorCache.set(currentState.url, resolvedInstruction, {
                action: decision.action, role: target.role, name: target.name,
                ...(decision.value !== undefined ? { value: decision.value } : {}),
              });
            }
            return {
              success: true,
              message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''} (after removing blocker)`,
              action: actionLabel,
              ...(selector !== undefined ? { selector } : {}),
            };
          } catch { /* retry also failed — continue to next candidate */ }
        }
      }
    }

    // All candidates failed — fall through to vision/semantic fallback with first valid target
    const fallbackTarget = isScrollWithoutTarget
      ? null
      : (currentState.elements.find(e => e.id === candidateIds[0]) ?? null);

    if (!isScrollWithoutTarget && !fallbackTarget) {
      return { success: false, message: `Could not find any candidate element`, attempts };
    }

    // ── Auto-recovery: try to dismiss common page blockers ──────────────────
    this.stateParser.invalidateCache();
    const recoveryState = await this.stateParser.parse();
    const recovered = await this.tryRecoverFromBlocker(recoveryState);
    if (recovered) {
      // Re-parse after recovery and retry the first candidate
      this.stateParser.invalidateCache();
      const freshState = await this.stateParser.parse();
      const retryTarget = freshState.elements.find(e => e.id === candidateIds[0])
        ?? freshState.elements.find(e => e.name === fallbackTarget?.name);
      if (retryTarget) {
        try {
          await this.performAction(decision.action, retryTarget, decision.value);
          await waitForPageSettle(this.page, this.domSettleTimeoutMs);
          return {
            success: true,
            message: `Successfully performed ${decision.action} on "${retryTarget.name}" (after auto-recovery)`,
            action: `${decision.action} on "${retryTarget.name}" (${retryTarget.role})`,
          };
        } catch { /* recovery retry also failed — continue to vision/semantic fallback */ }
      }
    }

    const actionLabel = fallbackTarget
      ? `${decision.action} on "${fallbackTarget.name}" (${fallbackTarget.role})`
      : `${decision.action} (page)`;
    const selector = fallbackTarget ? (await generateSelector(this.page, fallbackTarget) ?? undefined) : undefined;
    const target = fallbackTarget;

    // Vision-Grounding als zweite Stufe (nur wenn aktiviert)
    if (this.visionGrounding && target) {
      try {
        const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
        const screenshot = await this.visionGrounding.takeScreenshot(this.page);
        const bbox = await this.visionGrounding.findElement(
          `${decision.action} on "${target.name}"`,
          screenshot,
          viewport.width,
          viewport.height
        );
        if (bbox) {
          const cx = bbox.x + bbox.width / 2;
          const cy = bbox.y + bbox.height / 2;
          await withTimeout(this.page.mouse.click(cx, cy), 10_000, `vision click "${target.name}"`);
          await waitForPageSettle(this.page, this.domSettleTimeoutMs);
          return {
            success: true,
            message: `Successfully performed ${decision.action} on "${target.name}" (via Vision Grounding)`,
            action: actionLabel,
            ...(selector !== undefined ? { selector } : {}),
          };
        }
        attempts.push({ path: 'vision-grounding', error: 'Element nicht im Screenshot gefunden' });
      } catch (visionError: any) {
        attempts.push({ path: 'vision-grounding', error: visionError.message });
        this.warn(2, `[Act] Vision fallback failed: ${visionError.message}`);
      }
    }

    this.warn(2, `[Act] All candidates failed, trying semantic fallback...`);
    try {
      // Capture state before fallback to verify it actually changed something
      this.stateParser.invalidateCache();
      const stateBeforeFallback = await this.stateParser.parse();

      await this.performSemanticFallback(decision.action, target, decision.value);
      await waitForPageSettle(this.page, this.domSettleTimeoutMs);

      // Verify the fallback actually changed the page
      this.stateParser.invalidateCache();
      const stateAfterFallback = await this.stateParser.parse();
      const pageChanged =
        stateBeforeFallback.url !== stateAfterFallback.url ||
        stateBeforeFallback.title !== stateAfterFallback.title ||
        Math.abs(stateBeforeFallback.elements.length - stateAfterFallback.elements.length) >= 2 ||
        stateBeforeFallback.elements.some(e => e.state?.focused) !== stateAfterFallback.elements.some(e => e.state?.focused);

      if (!pageChanged) {
        this.warn(2, `[Act] Semantic fallback completed but page state unchanged — marking as failed`);
        attempts.push({ path: 'locator-fallback', error: 'action completed but page state unchanged' });
        const message = buildFailureMessage(resolvedInstruction, target, attempts);
        return { success: false, message, action: actionLabel, attempts };
      }

      return {
        success: true,
        message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''} (via fallback)`,
        action: actionLabel,
        ...(selector !== undefined ? { selector } : {}),
      };
    } catch (fallbackError: any) {
      attempts.push({ path: 'locator-fallback', error: fallbackError.message });
      const message = buildFailureMessage(resolvedInstruction, target, attempts);
      this.warn(2, `[Act] All paths failed:\n${message}`);
      return { success: false, message, action: actionLabel, attempts };
    }
  }

  private async performAction(
    action: ActionType,
    target: UIElement | null,
    value?: string,
    dropTarget?: UIElement | null
  ): Promise<void> {
    // Retry with backoff for transient failures (timeout, element detached, scroll issues).
    // Non-transient errors (wrong element, validation) are thrown immediately so the
    // caller can fall through to vision/semantic fallback instead of wasting retries.
    const RETRY_DELAYS = [200, 500];
    const isTransient = (err: any) =>
      /timeout|detach|disposed|intercept|not found|outside viewport/i.test(err?.message ?? '');

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        await this.performActionOnce(action, target, value, dropTarget);
        return;
      } catch (err) {
        if (attempt < RETRY_DELAYS.length && isTransient(err)) {
          this.warn(2, `[Act] Transient failure (attempt ${attempt + 1}), retrying in ${RETRY_DELAYS[attempt]}ms...`);
          await this.page.waitForTimeout(RETRY_DELAYS[attempt]!);
        } else {
          throw err;
        }
      }
    }
  }

  private async performActionOnce(
    action: ActionType,
    target: UIElement | null,
    value?: string,
    dropTarget?: UIElement | null
  ): Promise<void> {
    // Scroll actions that don't need a target element.
    // mouse.wheel dispatches a native wheel event at the current cursor position so
    // the browser routes it to whichever element is actually scrollable — works for
    // both window-level scroll and scrollable container divs (SPAs, iframes, etc.).
    if (action === 'scroll-down' && !target) {
      await this.page.mouse.wheel(0, 600);
      return;
    }
    if (action === 'scroll-up' && !target) {
      await this.page.mouse.wheel(0, -600);
      return;
    }

    if (!target) throw new ActionError('No target element provided', { action });

    // Cross-frame routing: element lives inside an iframe.
    // Delegate to Playwright's frame locator API, which dispatches clicks,
    // fills, and keystrokes into the frame's document — coordinate-based
    // paths would hit the iframe boundary rather than the inner content.
    if (target.frameId) {
      const frame = this.stateParser.getFrame(target.frameId);
      if (frame) {
        await this.executeInFrame(frame, action, target, value, dropTarget);
        return;
      }
      this.warn(2, `[Act] Frame "${target.frameId}" not in registry — falling back to main-frame path`);
    }

    // File upload: locator-based, no coordinates required (setInputFiles
    // works even for visually hidden <input type="file">).
    if (action === 'upload') {
      await this.performUpload(this.page, target, value);
      return;
    }

    // Drag & drop: source → drop-target via Playwright locator.dragTo().
    // Cross-frame drag is not supported in this iteration — both elements
    // must share the same context (main document or same iframe).
    if (action === 'drag') {
      if (!dropTarget) {
        throw new ActionError('drag requires a drop-target element', { action });
      }
      await this.performDrag(this.page, target, dropTarget);
      return;
    }

    const { x, y, width, height } = target.boundingClientRect;
    const cx = x + width / 2;
    const cy = y + height / 2;

    const viewport = this.page.viewportSize() ?? { width: 1920, height: 1080 };

    // Skip coordinate-based clicking entirely when coordinates are clearly impossible
    // (e.g. y=-3184 on Booking.com autocomplete). Go straight to locator fallback.
    if (cy < -500 || cx < -500) {
      this.warn(2, `[Act] Impossible coordinates (${cx.toFixed(0)}, ${cy.toFixed(0)}) for "${target.name}" — using locator`);
      const locator = this.page.getByRole(target.role as any, { name: target.name, exact: false });
      if (action === 'fill') {
        await locator.fill(value || '', { timeout: 5000 });
      } else {
        await locator.click({ timeout: 5000 });
      }
      return;
    }

    // Get scroll position to convert document coords to viewport coords
    let scrollOffset = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      .catch(() => ({ x: 0, y: 0 }));
    let vpCx = cx - (scrollOffset?.x ?? 0);
    let vpCy = cy - (scrollOffset?.y ?? 0);

    // If element is outside viewport, scroll it into view
    if (vpCx < 0 || vpCy < 0 || vpCx > viewport.width || vpCy > viewport.height) {
      await this.page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          window.scrollTo({
            left: Math.max(0, x - window.innerWidth / 2),
            top: Math.max(0, y - window.innerHeight / 2),
            behavior: 'instant',
          });
        },
        { x: cx, y: cy }
      );
      await this.page.waitForTimeout(100);

      scrollOffset = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
        .catch(() => ({ x: 0, y: 0 }));
      vpCx = cx - (scrollOffset?.x ?? 0);
      vpCy = cy - (scrollOffset?.y ?? 0);
    }

    // Fallback: if scrollTo didn't work (SPAs may override scroll),
    // try scrolling to page top first, then re-check
    if (vpCx < 0 || vpCy < 0 || vpCx > viewport.width || vpCy > viewport.height) {
      await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this.page.waitForTimeout(100);
      scrollOffset = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
        .catch(() => ({ x: 0, y: 0 }));
      vpCx = cx - (scrollOffset?.x ?? 0);
      vpCy = cy - (scrollOffset?.y ?? 0);
    }

    if (vpCx < 0 || vpCy < 0 || vpCx > viewport.width || vpCy > viewport.height) {
      throw new ActionError(
        `Element "${target.name}" is outside viewport at (${vpCx.toFixed(0)}, ${vpCy.toFixed(0)}) even after scrolling`,
        { element: target.name, x: vpCx, y: vpCy }
      );
    }

    const clickX = vpCx;
    const clickY = vpCy;

    // Click-target verification: confirm the element at (clickX, clickY)
    // actually corresponds to the intended target. Catches coordinate mismatches
    // where a dynamically-appeared element has stale AOM coordinates pointing
    // to a different field (e.g., Motorleistung coords hit Treibstoff).
    //
    // Skip for slider+fill: the locator.fill() fallback fails silently on ARIA-only
    // sliders, but the dedicated slider-fill logic in the switch below has its own
    // locator-based element lookup with 3 fallback strategies.
    const isSliderFill = target?.role === 'slider' && action === 'fill';
    const isDatepickerFill = (target?.role === 'datepicker' || target?.role === 'timepicker') && action === 'fill';
    if (target && !isSliderFill && !isDatepickerFill && (action === 'fill' || action === 'click' || action === 'select')) {
      const hitName = await this.page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null;
          if (!el) return '';
          // Walk up to find the nearest labeled container
          let node: HTMLElement | null = el;
          for (let d = 0; d < 5 && node; d++) {
            const label = node.getAttribute('aria-label') ||
              node.getAttribute('placeholder') ||
              node.getAttribute('name') || '';
            if (label) return label.toLowerCase();
            const labelledBy = node.getAttribute('aria-labelledby');
            if (labelledBy) {
              const ref = document.getElementById(labelledBy);
              if (ref) return ref.textContent?.trim().toLowerCase() || '';
            }
            node = node.parentElement;
          }
          return el.textContent?.trim().slice(0, 40).toLowerCase() || '';
        },
        { x: clickX, y: clickY }
      ).catch(() => '');

      if (hitName && target.name) {
        const targetLower = target.name.toLowerCase();
        // Technical IDs (contain dots, no spaces) are container/group names, not real mismatches.
        // e.g. "auto.fahrzeug.erstbesitzv-radiogroup" is the radiogroup containing the radio button.
        const hitIsTechnicalId = /^[\w.-]+$/.test(hitName) && hitName.includes('.');
        const mismatch = !hitIsTechnicalId &&
          hitName.length > 2 && targetLower.length > 2 &&
          !hitName.includes(targetLower) && !targetLower.includes(hitName);
        if (mismatch) {
          // Coordinates point to wrong element — use Playwright locator as direct fallback.
          // This is more reliable than coordinate-based clicking for dynamically positioned
          // elements (dropdown options, conditional form fields, etc.).
          this.warn(2, `[Act] Coordinate mismatch: "${target.name}" at (${clickX.toFixed(0)}, ${clickY.toFixed(0)}) hits "${hitName}" — using locator fallback`);
          // Try multiple locator strategies: full name, short name (after ':'), just last word
          const nameVariants = [target.name];
          if (target.name.includes(':')) {
            nameVariants.push(target.name.split(':').pop()!.trim());
          }
          for (const name of nameVariants) {
            try {
              const locator = this.page.getByRole(target.role as any, { name, exact: false });
              if (action === 'fill') {
                await locator.fill(value || '', { timeout: 3000 });
              } else {
                await locator.click({ timeout: 3000 });
              }
              return; // locator click succeeded
            } catch {
              continue; // try next name variant
            }
          }
          // All variants failed
          throw new ActionError(
            `Coordinate mismatch: target is "${target.name}" but element at (${clickX.toFixed(0)}, ${clickY.toFixed(0)}) is "${hitName}"`,
            { element: target.name, hitElement: hitName }
          );
        }
      }
    }

    // Human-like: move mouse along a Bézier curve to the target
    if (this.humanLike && (
      action === 'click' || action === 'double-click' || action === 'right-click' ||
      action === 'hover' || action === 'fill' || action === 'append'
    )) {
      const cur = await this.page.evaluate(() => ({
        x: (window as any).__sentinelMouseX ?? 0,
        y: (window as any).__sentinelMouseY ?? 0,
      })).catch(() => ({ x: 0, y: 0 }));
      await moveMouse(this.page, cur.x, cur.y, clickX, clickY);
      await this.page.evaluate(
        ({ x, y }) => { (window as any).__sentinelMouseX = x; (window as any).__sentinelMouseY = y; },
        { x: clickX, y: clickY }
      ).catch(() => {});
      await this.page.waitForTimeout(80 + Math.round(Math.random() * 120));
    }

    switch (action) {
      case 'click':
        if (target.role === 'radio' || target.role === 'checkbox') {
          await this.page.evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null;
              if (!el) return;
              const hiddenInput = el.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
              if (hiddenInput) { hiddenInput.click(); return; }
              const label = el.closest('label') as HTMLLabelElement | null;
              if (label) { label.click(); return; }
              el.click();
            },
            { x: clickX, y: clickY }
          );
        } else {
          await withTimeout(this.page.mouse.click(clickX, clickY), 10_000, `click "${target.name}"`);
        }
        break;

      case 'double-click':
        await withTimeout(this.page.mouse.dblclick(clickX, clickY), 10_000, `double-click "${target.name}"`);
        break;

      case 'right-click':
        await withTimeout(this.page.mouse.click(clickX, clickY, { button: 'right' }), 10_000, `right-click "${target.name}"`);
        break;

      case 'fill': {
        // Slider: three strategies, in order:
        //  1. Native <input type="range"> — set .value directly
        //  2. Sibling text/number/tel input in shared container (e.g. Amazon price filter,
        //     idealo, Zalando) — fill the spatially-closest input
        //  3. Keyboard simulation on the slider itself (ARIA-only sliders) — uses
        //     aria-valuemin/valuemax/valuenow + Arrow keys to reach target value
        if (target && target.role === 'slider' && value) {
          // Get an element handle for the actual slider via Playwright locator.
          // Coordinates from the AOM may be stale or point to a different element
          // (Amazon's Mindestpreis slider reports coords under the header).
          let sliderHandle: import('playwright').ElementHandle | null = null;
          try {
            const loc = this.page.getByRole('slider', { name: target.name, exact: false }).first();
            sliderHandle = await loc.elementHandle({ timeout: 2000 });
          } catch { /* fall through to coord-based lookup */ }

          const handled = await this.page.evaluate(
            ({ slider, x, y, val }: { slider: Node | null; x: number; y: number; val: string }) => {
              const sliderEl = (slider as HTMLElement | null) ?? (document.elementFromPoint(x, y) as HTMLElement | null);
              if (!sliderEl) return 'none';

              // Strategy 1: native range input
              const rangeInput = sliderEl.tagName === 'INPUT' && (sliderEl as HTMLInputElement).type === 'range'
                ? (sliderEl as HTMLInputElement)
                : sliderEl.querySelector('input[type="range"]') as HTMLInputElement | null;
              if (rangeInput) {
                // Controlled-input bypass: frameworks (React, Preact, Solid,
                // Vue with v-model) replace the value descriptor on the input
                // instance to track their own state. A direct `.value = val`
                // assignment writes to the framework-wrapped setter and is
                // ignored / reverted on the next re-render. Using the native
                // HTMLInputElement.prototype setter writes to the real DOM
                // property, which the subsequent `input` event then carries
                // back into the framework's state tree as a user-originated
                // change. Universal across any framework built on controlled
                // inputs — no library-specific detection.
                const nativeSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, 'value'
                )?.set;
                rangeInput.focus();
                nativeSetter?.call(rangeInput, val);
                rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
                rangeInput.dispatchEvent(new Event('change', { bubbles: true }));
                return 'range';
              }

              // Strategy 2: sibling text/number/tel input in shared container
              // Walk up until we find a container with numeric text inputs
              let container: HTMLElement | null = sliderEl;
              for (let depth = 0; depth < 8 && container; depth++) {
                const inputs = Array.from(container.querySelectorAll<HTMLInputElement>(
                  'input[type="text"], input[type="tel"], input[type="number"], input:not([type])'
                )).filter(inp => inp.offsetParent !== null && !inp.disabled && !inp.readOnly);

                if (inputs.length > 0) {
                  // Pick the input closest to the slider's centroid
                  const sliderRect = sliderEl.getBoundingClientRect();
                  const sx = sliderRect.left + sliderRect.width / 2;
                  const sy = sliderRect.top + sliderRect.height / 2;
                  const closest = inputs
                    .map(inp => {
                      const r = inp.getBoundingClientRect();
                      const cx = r.left + r.width / 2;
                      const cy = r.top + r.height / 2;
                      return { inp, dist: Math.hypot(cx - sx, cy - sy) };
                    })
                    .sort((a, b) => a.dist - b.dist)[0];

                  if (closest) {
                    const input = closest.inp;
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                      window.HTMLInputElement.prototype, 'value'
                    )?.set;
                    input.focus();
                    nativeSetter?.call(input, val);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return 'sibling';
                  }
                }
                container = container.parentElement;
              }

              return 'keyboard'; // signal to caller to try keyboard simulation
            },
            { slider: sliderHandle, x: clickX, y: clickY, val: value }
          );

          if (handled === 'keyboard') {
            // Strategy 3: keyboard simulation using aria-valuemin/valuemax/valuenow.
            //
            // Critical detail: many component libraries (MUI, Material-UI, Chakra,
            // Radix) place `role="slider"` on an inner thumb element, with ARIA
            // attributes ONLY on that thumb. `elementFromPoint` at the slider
            // centroid returns the track or wrapper, which has no aria-* attrs
            // and cannot receive focus meaningfully. We must walk from the hit
            // element to the nearest `[role="slider"]` descendant/ancestor and
            // focus it explicitly — arrow keys only move the thumb if it's the
            // active element.
            const sliderInfo = await this.page.evaluate(
              ({ slider, x, y }: { slider: Node | null; x: number; y: number }) => {
                const hit = (slider as HTMLElement | null) ?? (document.elementFromPoint(x, y) as HTMLElement | null);
                if (!hit) return null;
                // Ancestor-walk to find the focusable slider element. The hit
                // target may be a track, rail, label, or styled wrapper that
                // doesn't itself respond to arrow keys. We walk UP (bounded)
                // and at each level check current + descendants.
                //
                // Preference order when both exist in the same subtree:
                //   1. input[type="range"] — native keyboard handler, reliable
                //      focus target, value stays in sync with aria-valuenow.
                //   2. [role="slider"] — explicit ARIA role on a custom element
                //      (span, div) that the library listens to for keydown.
                //
                // ARIA attributes may live on either element; we read them
                // from whichever we focus.
                let sliderEl: HTMLElement | null = null;
                let cursor: HTMLElement | null = hit;
                for (let depth = 0; depth < 8 && cursor && !sliderEl; depth++) {
                  // Native range input wins — directly focusable and keyboard-native
                  const nativeInput = cursor.matches?.('input[type="range"]')
                    ? (cursor as HTMLInputElement)
                    : cursor.querySelector<HTMLInputElement>('input[type="range"]');
                  if (nativeInput) { sliderEl = nativeInput; break; }
                  // Fall back to explicit ARIA slider role
                  if (cursor.matches?.('[role="slider"]')) { sliderEl = cursor; break; }
                  sliderEl = cursor.querySelector<HTMLElement>('[role="slider"]');
                  if (!sliderEl) cursor = cursor.parentElement;
                }
                if (!sliderEl) return null;
                // Focus inside the evaluate so page.keyboard.press arrow
                // events land on the active element without a round-trip.
                sliderEl.focus();
                // Read ARIA values from sliderEl directly; if missing (e.g. we
                // focused the native input and ARIA lives on a sibling thumb),
                // fall back to ancestor/descendant lookup within a small window.
                const readAria = (attr: string): string | null => {
                  const own = sliderEl!.getAttribute(attr);
                  if (own !== null) return own;
                  const parent = sliderEl!.parentElement;
                  const sibling = parent?.querySelector(`[${attr}]`);
                  return sibling?.getAttribute(attr) ?? null;
                };
                const min = parseFloat(readAria('aria-valuemin') ?? '0');
                const max = parseFloat(readAria('aria-valuemax') ?? '100');
                // When the focused element is a native range input, its .value
                // is the authoritative current value (always a number).
                const inputValue = (sliderEl as HTMLInputElement).value;
                const parsedInput = inputValue !== undefined ? parseFloat(inputValue) : NaN;
                const now = !isNaN(parsedInput) ? parsedInput : parseFloat(readAria('aria-valuenow') ?? String(min));
                return { min, max, now };
              },
              { slider: sliderHandle, x: clickX, y: clickY }
            ).catch(() => null);

            if (sliderInfo && !isNaN(sliderInfo.min) && !isNaN(sliderInfo.max)) {
              const targetValue = parseFloat(value);
              if (!isNaN(targetValue) && targetValue >= sliderInfo.min && targetValue <= sliderInfo.max) {
                // Extra focus attempt via the Playwright handle if we have one —
                // belt-and-suspenders for cases where the in-evaluate focus() is
                // overridden by framework effects after return.
                if (sliderHandle) {
                  await sliderHandle.focus().catch(() => {});
                }
                const steps = Math.round(targetValue - sliderInfo.now);
                const key = steps >= 0 ? 'ArrowRight' : 'ArrowLeft';
                const count = Math.min(Math.abs(steps), 500); // cap to avoid runaway
                for (let i = 0; i < count; i++) {
                  await this.page.keyboard.press(key);
                }
              }
            }
          }

          if (sliderHandle) {
            await sliderHandle.dispose().catch(() => {});
          }
          break;
        }

        // Datepicker / Timepicker: universal three-strategy cascade.
        //  1. Native <input type="date|time|datetime-local|month|week"> →
        //     format to ISO, set via native value setter + dispatch events.
        //     Avoids opening the OS-level picker UI.
        //  2. Wrapped writable <input> (MUI, Ant Design, react-datepicker) →
        //     click to focus, Ctrl+A to clear, type raw value, Tab to commit.
        //  3. Popup-only (flatpickr readonly, pure-UI calendars) →
        //     open popup, navigate via ARIA headings + locale-aware Intl
        //     month detection, click target day cell.
        if (target && (target.role === 'datepicker' || target.role === 'timepicker') && value) {
          const parts = parseDateValue(value);

          const classification = await this.page.evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const hit = document.elementFromPoint(x, y) as HTMLElement | null;
              if (!hit) return { kind: 'unknown' as const };
              const NATIVE_SEL =
                'input[type="date"], input[type="time"], input[type="datetime-local"], ' +
                'input[type="month"], input[type="week"]';
              let node: HTMLElement | null = hit;
              for (let depth = 0; depth < 6 && node; depth++) {
                const nativeHere: HTMLInputElement | null = node.matches?.(NATIVE_SEL)
                  ? (node as HTMLInputElement)
                  : node.querySelector<HTMLInputElement>(NATIVE_SEL);
                if (nativeHere) return { kind: 'native' as const, type: nativeHere.type };

                const writable = Array.from(node.querySelectorAll<HTMLInputElement>('input'))
                  .find(i =>
                    i.offsetParent !== null && !i.disabled && !i.readOnly &&
                    i.type !== 'hidden' && i.type !== 'button' && i.type !== 'submit'
                  );
                if (writable) return { kind: 'writable' as const };
                node = node.parentElement;
              }
              return { kind: 'popup' as const };
            },
            { x: clickX, y: clickY }
          );

          // Strategy 1: native input
          if (classification.kind === 'native' && parts) {
            const formatted = formatNativeInputValue(classification.type, parts);
            if (formatted) {
              await this.page.evaluate(
                ({ x, y, val, sel }: { x: number; y: number; val: string; sel: string }) => {
                  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
                  if (!hit) return;
                  let input: HTMLInputElement | null = null;
                  let node: HTMLElement | null = hit;
                  for (let d = 0; d < 6 && node && !input; d++) {
                    input = node.matches?.(sel)
                      ? (node as HTMLInputElement)
                      : node.querySelector<HTMLInputElement>(sel);
                    if (!input) node = node.parentElement;
                  }
                  if (!input) return;
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                  )?.set;
                  input.focus();
                  setter?.call(input, val);
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  input.blur();
                },
                {
                  x: clickX, y: clickY, val: formatted,
                  sel: 'input[type="date"], input[type="time"], input[type="datetime-local"], input[type="month"], input[type="week"]',
                }
              );
              break;
            }
          }

          // Strategy 2: writable wrapped input — click, clear, type, commit via Tab.
          if (classification.kind === 'writable') {
            await withTimeout(this.page.mouse.click(clickX, clickY), 10_000, `focus "${target.name}"`);
            await this.page.waitForTimeout(150);
            await this.page.keyboard.press('Control+a');
            await this.page.waitForTimeout(50);
            const typeDelay = this.humanLike ? 90 + Math.round(Math.random() * 40) : 90;
            await this.page.keyboard.type(value, { delay: typeDelay });
            await this.page.keyboard.press('Tab').catch(() => {});
            break;
          }

          // Strategy 3: popup-only — open calendar, navigate months, click day.
          if (classification.kind === 'popup' && parts && parts.year && parts.month && parts.day) {
            await this.page.mouse.click(clickX, clickY);
            await this.page.waitForTimeout(400);
            const ok = await pickDateFromPopup(this.page, parts);
            if (!ok) {
              await this.page.keyboard.press('Escape').catch(() => {});
              throw new ActionError(
                `Could not navigate datepicker popup for "${target.name}" to ${parts.year}-${parts.month}-${parts.day}`,
                { element: target.name, value }
              );
            }
            break;
          }

          // Unclassifiable or unparsable value → fall through to generic fill.
        }

        await withTimeout(this.page.mouse.click(clickX, clickY), 10_000, `focus "${target.name}"`);

        // For combobox/listbox: click may open a dropdown trigger.
        // Try to find & focus the actual search input inside the dropdown.
        // Works for both combobox AND listbox roles — many dropdown widgets
        // report as listbox but have a hidden search input.
        // If no input is found, falls through to normal fill (no delay wasted).
        let isDropdownInput = false;
        if (target.role === 'combobox' || target.role === 'listbox') {
          isDropdownInput = await this.page.evaluate(
            ({ x, y }: { x: number; y: number }) => {
              // Check if an input already has focus
              const active = document.activeElement;
              if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return true;

              // Search for a visible input in the container hierarchy
              const el = document.elementFromPoint(x, y) as HTMLElement | null;
              let container: HTMLElement | null = el?.closest?.('div') ?? el?.parentElement ?? null;
              for (let depth = 0; depth < 5 && container; depth++) {
                const input = container.querySelector(
                  'input[role="combobox"], input[type="search"], input[type="text"], ' +
                  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
                ) as HTMLInputElement | null;
                if (input && input.offsetParent !== null) { input.focus(); return true; }
                container = container.parentElement;
              }
              return false;
            },
            { x: clickX, y: clickY }
          ).catch(() => false);

          // If no input found immediately, wait for dropdown animation and retry
          if (!isDropdownInput) {
            await this.page.waitForTimeout(300);
            isDropdownInput = await this.page.evaluate(
              ({ x, y }: { x: number; y: number }) => {
                const active = document.activeElement;
                if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return true;
                const el = document.elementFromPoint(x, y) as HTMLElement | null;
                let container: HTMLElement | null = el?.closest?.('div') ?? el?.parentElement ?? null;
                for (let depth = 0; depth < 5 && container; depth++) {
                  const input = container.querySelector(
                    'input[role="combobox"], input[type="search"], input[type="text"], ' +
                    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
                  ) as HTMLInputElement | null;
                  if (input && input.offsetParent !== null) { input.focus(); return true; }
                  container = container.parentElement;
                }
                return false;
              },
              { x: clickX, y: clickY }
            ).catch(() => false);
          }
        }

        await this.page.keyboard.press('Control+a');
        await this.page.waitForTimeout(150);
        if (this.humanLike) {
          await this.page.keyboard.type(value || '', { delay: 90 + Math.round(Math.random() * 40) });
        } else {
          await this.page.keyboard.type(value || '', { delay: 90 });
        }

        // Auto-select: after typing into a dropdown search, click the first matching option.
        // This completes the dropdown interaction in one step instead of requiring a separate click.
        if (isDropdownInput && value) {
          await this.page.waitForTimeout(400); // wait for filter/render
          await this.page.evaluate(
            ({ val }: { val: string }) => {
              const options = document.querySelectorAll('[role="option"]');
              const lowerVal = val.toLowerCase();
              // Exact match
              for (const opt of Array.from(options)) {
                if ((opt as HTMLElement).textContent?.trim().toLowerCase() === lowerVal) {
                  (opt as HTMLElement).click(); return;
                }
              }
              // Contains match
              for (const opt of Array.from(options)) {
                if ((opt as HTMLElement).textContent?.trim().toLowerCase().includes(lowerVal)) {
                  (opt as HTMLElement).click(); return;
                }
              }
            },
            { val: value }
          ).catch(() => {});
        }
        break;
      }

      case 'append':
        await withTimeout(this.page.mouse.click(clickX, clickY), 10_000, `focus "${target.name}"`);
        await this.page.keyboard.press('End');
        await this.page.keyboard.press('Control+End');
        await this.page.waitForTimeout(150);
        if (this.humanLike) {
          await this.page.keyboard.type(value || '', { delay: 90 + Math.round(Math.random() * 40) });
        } else {
          await this.page.keyboard.type(value || '', { delay: 90 });
        }
        break;

      case 'hover':
        await withTimeout(this.page.mouse.move(clickX, clickY), 10_000, `hover "${target.name}"`);
        break;

      case 'press':
        await withTimeout(this.page.mouse.click(clickX, clickY), 10_000, `focus "${target.name}"`);
        await this.page.keyboard.press(value || 'Enter');
        break;

      case 'select':
        await withTimeout(this.page.mouse.click(clickX, clickY), 10_000, `open select "${target.name}"`);

        if (target.role === 'combobox' || target.role === 'listbox') {
          // Custom dropdown: click trigger → find input → type to filter → click option
          const selectNeedsSearch = await this.page.evaluate(() => {
            const active = document.activeElement;
            return !(active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA');
          }).catch(() => true);

          if (selectNeedsSearch) {
            await this.page.waitForTimeout(300);
            await this.page.evaluate(
              ({ x, y }: { x: number; y: number }) => {
                const el = document.elementFromPoint(x, y) as HTMLElement | null;
                let container: HTMLElement | null = el?.closest?.('div') ?? el?.parentElement ?? null;
                for (let depth = 0; depth < 5 && container; depth++) {
                  const input = container.querySelector(
                    'input[role="combobox"], input[type="search"], input[type="text"], ' +
                    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
                  ) as HTMLInputElement | null;
                  if (input && input.offsetParent !== null) { input.focus(); input.select(); return; }
                  container = container.parentElement;
                }
              },
              { x: clickX, y: clickY }
            );
          }

          await this.page.keyboard.type(value || '');
          await this.page.waitForTimeout(500);

          // Click the matching option from the dropdown
          const clicked = await this.page.evaluate(
            ({ val }: { val: string }) => {
              const options = document.querySelectorAll(
                '[role="option"], [role="listbox"] li, [role="listbox"] div[id]'
              );
              // Exact match first
              for (const opt of Array.from(options)) {
                const text = (opt as HTMLElement).textContent?.trim();
                if (text === val) { (opt as HTMLElement).click(); return true; }
              }
              // Partial match (contains)
              for (const opt of Array.from(options)) {
                const text = (opt as HTMLElement).textContent?.trim();
                if (text && text.includes(val)) { (opt as HTMLElement).click(); return true; }
              }
              return false;
            },
            { val: value || '' }
          );

          if (!clicked) {
            // Fallback: press Enter to confirm current selection
            await this.page.keyboard.press('Enter');
          }
        } else {
          // Native <select> element
          await this.page.evaluate(
            ({ x, y, val }: { x: number; y: number; val: string }) => {
              const el = document.elementFromPoint(x, y) as HTMLSelectElement | null;
              if (el && el.tagName === 'SELECT') {
                const opt = Array.from(el.options).find(o => o.text === val || o.value === val);
                if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
              }
            },
            { x: clickX, y: clickY, val: value || '' }
          );
        }
        break;

      case 'scroll-down':
        await this.page.evaluate(({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y);
          if (el) el.scrollBy(0, 300);
        }, { x: clickX, y: clickY });
        break;

      case 'scroll-up':
        await this.page.evaluate(({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y);
          if (el) el.scrollBy(0, -300);
        }, { x: clickX, y: clickY });
        break;

      case 'scroll-to':
        await this.page.evaluate(({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, { x: clickX, y: clickY });
        break;
    }
  }

  /**
   * Tries multiple Playwright locator strategies in order of specificity.
   * Returns the first locator that resolves to a visible element, or falls
   * back to the most specific strategy if none is currently visible (e.g.
   * the element exists but is off-screen and needs scrolling).
   */
  private async findBestLocator(target: UIElement) {
    const strategies = [
      // 1. Exact ARIA role + exact accessible name (most specific)
      target.name
        ? this.page.getByRole(target.role as any, { name: target.name, exact: true })
        : null,
      // 2. ARIA role + partial/case-insensitive name match
      target.name
        ? this.page.getByRole(target.role as any, { name: target.name })
        : null,
      // 3. CSS role attribute + hasText (original strategy)
      target.name
        ? this.page.locator(`[role="${target.role}"]`, { hasText: target.name }).first()
        : this.page.locator(`[role="${target.role}"]`).first(),
      // 4. Plain text match as last resort
      target.name
        ? this.page.getByText(target.name, { exact: false }).first()
        : null,
      // 5. If name contains ':' context prefix, try without it (e.g. "Info: Weiter" → "Weiter")
      target.name?.includes(':')
        ? this.page.getByRole(target.role as any, { name: target.name.split(':').pop()!.trim() })
        : null,
    ].filter((l): l is NonNullable<typeof l> => l !== null);

    for (const locator of strategies) {
      try {
        const isVisible = await locator.isVisible({ timeout: 1500 });
        if (isVisible) return locator;
      } catch {
        continue;
      }
    }

    // None visible right now — return the most specific strategy anyway.
    // The caller's scrollIntoViewIfNeeded / click will handle it.
    return strategies[0]!;
  }

  /**
   * Validates that the element at the target's coordinates is actually
   * interactive (not disabled, not hidden behind an overlay).
   * Returns null if valid, or an error message if blocked.
   */
  private async validateTarget(target: UIElement): Promise<string | null> {
    const cx = target.boundingClientRect.x + target.boundingClientRect.width / 2;
    const cy = target.boundingClientRect.y + target.boundingClientRect.height / 2;

    return this.page.evaluate(
      ({ x, y }: { x: number; y: number }) => {
        // AOM coordinates are in document (layout) space.
        // If the element is below the fold, scroll it into view first
        // so elementFromPoint can actually find it.
        const vpX = x - window.scrollX;
        const vpY = y - window.scrollY;
        const inViewport = vpX >= 0 && vpY >= 0 && vpX < window.innerWidth && vpY < window.innerHeight;

        if (!inViewport) {
          // Scroll the point into view before checking
          window.scrollTo({ left: Math.max(0, x - window.innerWidth / 2), top: Math.max(0, y - window.innerHeight / 2), behavior: 'instant' });
        }

        // Re-calculate viewport coords after possible scroll
        const finalVpX = x - window.scrollX;
        const finalVpY = y - window.scrollY;
        const el = document.elementFromPoint(finalVpX, finalVpY);
        if (!el) return null; // can't determine — let the action try

        // Check disabled state
        if ((el as HTMLElement).hasAttribute('disabled') ||
            el.getAttribute('aria-disabled') === 'true') {
          return 'element is disabled';
        }

        // Check if hidden
        if ((el as HTMLElement).offsetParent === null &&
            getComputedStyle(el).position !== 'fixed') {
          return 'element is hidden (display:none)';
        }

        // Check if an overlay/modal is covering the target
        const role = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        if (role === 'dialog' || role === 'alertdialog' || tag === 'dialog') {
          const ariaLabel = el.getAttribute('aria-label') || '';
          if (/cookie|consent|privacy|datenschutz/i.test(ariaLabel) ||
              /cookie|consent|privacy|datenschutz/i.test(el.textContent?.slice(0, 200) || '')) {
            return 'blocked by cookie/consent overlay';
          }
          return 'blocked by dialog/modal overlay';
        }

        return null; // valid
      },
      { x: cx, y: cy }
    ).catch(() => null); // on error, assume valid
  }

  /**
   * Attempts to recover from common page blockers (cookie banners,
   * overlays, modals) by dismissing them automatically.
   * Returns true if a recovery action was performed.
   */
  async tryRecoverFromBlocker(state: SimplifiedState): Promise<boolean> {
    // Pattern 1: Cookie/consent banner — prefer accept/agree buttons over settings buttons
    const cookieCandidates = state.elements.filter(e =>
      (e.role === 'button' || e.role === 'link') &&
      /cookie|consent|accept|akzeptieren|zustimmen|accept all|got it|verstanden|i agree/i.test(e.name)
    );
    // Prioritize buttons that actually ACCEPT (not "settings", "einstellungen", "manage")
    const acceptPattern = /akzeptieren|accept|zustimmen|agree|got it|verstanden|alle /i;
    const settingsPattern = /einstell|manage|settings|preferences|verwalten|anpassen/i;
    // Only click accept-type elements. For links: require accept keywords (links without
    // them are usually navigation to cookie policy pages, not dismiss actions).
    // For buttons without accept keywords: only click if they don't match settings pattern.
    const cookieElement = cookieCandidates.find(e => acceptPattern.test(e.name) && !settingsPattern.test(e.name))
      ?? cookieCandidates.find(e => e.role === 'button' && !settingsPattern.test(e.name));
    if (cookieElement) {
      this.log(2, `[Act] Recovery: dismissing cookie banner via "${cookieElement.name}"`);
      try {
        await this.performAction('click', cookieElement);
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        return true;
      } catch { /* recovery failed, continue */ }
    }

    // Pattern 2: Remove pointer-intercepting widgets (marketing popups, chat widgets)
    try {
      const removed = await this.page.evaluate(() => {
        const blockers = document.querySelectorAll(
          'getsitecontrol-widget, [class*="popup"], [class*="overlay"], [id*="widget"], [class*="chat-widget"], [class*="intercom"]'
        );
        let count = 0;
        for (const el of Array.from(blockers)) {
          const style = window.getComputedStyle(el);
          // Only remove elements that cover a large area or have high z-index
          if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex > '999') {
            el.remove();
            count++;
          }
        }
        return count;
      });
      if (removed > 0) {
        this.log(2, `[Act] Recovery: removed ${removed} pointer-intercepting widget(s)`);
        return true;
      }
    } catch { /* evaluate failed */ }

    // Pattern 3: Generic modal close (Escape key)
    const hasModal = state.elements.some(e => e.region === 'modal' || e.region === 'popup');
    if (hasModal) {
      this.log(2, `[Act] Recovery: pressing Escape to close modal/popup`);
      try {
        await this.page.keyboard.press('Escape');
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        return true;
      } catch { /* recovery failed */ }
    }

    return false;
  }

  private async performSemanticFallback(
    action: ActionType,
    target: UIElement | null,
    value?: string
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

    const locator = await this.findBestLocator(target);

    switch (action) {
      case 'click':
        if (target.role === 'radio' || target.role === 'checkbox') {
          try { await locator.check({ timeout: 5000 }); }
          catch { await locator.click({ timeout: 5000 }); }
        } else {
          await locator.click({ timeout: 5000 });
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
