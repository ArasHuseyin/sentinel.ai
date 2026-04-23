import type { Frame, Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { UIElement, SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { VisionGrounding } from '../core/vision-grounding.js';
import type { ILocatorCache } from '../core/locator-cache.js';
import type { IPatternCache, PatternSequence } from '../core/pattern-cache.js';
import type { PatternFingerprint } from '../core/pattern-signature.js';
import { generateSelector } from '../core/selector-generator.js';
import { withTimeout } from '../utils/with-timeout.js';
import { ActionError, CaptchaDetectedError } from '../types/errors.js';
import { detectCaptcha, describeCaptcha } from '../reliability/captcha-detector.js';

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
async function waitForPageSettle(page: Page, timeout = 5000): Promise<void> {
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
    tip = `Tip: element may be outside the visible area. Try first:\n  sentinel.act('scroll to ${elementName}')`;
  } else if (allErrors.includes('timeout') || allErrors.includes('detached') || allErrors.includes('hidden')) {
    tip = `Tip: element may be covered by a modal, overlay, or popover. Dismiss overlapping elements first.`;
  } else if (allErrors.includes('no target') || allErrors.includes('not found') || allErrors.includes('could not find')) {
    tip = `Tip: element "${instruction}" was not found in the DOM. It may live in a shadow DOM, iframe, or not be rendered yet.`;
  } else if (attempts.length >= 2) {
    tip = `Tip: all fallback paths exhausted. Reformulate the instruction more precisely or enable vision grounding: { visionFallback: true }.`;
  }

  const attemptSummary = attempts.length === 1
    ? `Path tried: ${attempts[0]!.path}`
    : `${attempts.length} paths tried`;

  return [
    `Action failed: "${instruction}" on ${elementName}`,
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

/** Max retries after the LLM signals `notFound: true` (one scroll + re-ask per retry). */
const MAX_NOT_FOUND_SCROLL_RETRIES = 1;

/** Scroll step used when the LLM signals the target is not visible, as a fraction of viewport height. */
const NOT_FOUND_SCROLL_FRACTION = 0.8;

/**
 * Stable system instruction for action-decision LLM calls. Extracted to a module
 * constant so every act() in a session ships the exact same system text — that's
 * what lets Gemini's implicit caching, OpenAI's auto prompt cache, and Anthropic's
 * cache_control reuse the prefix and discount it on hits. Per-call variables
 * (URL, title, instruction, elements) stay in the user prompt.
 */
const ACT_SYSTEM_INSTRUCTION = `
You are a browser-automation action planner. Given a user instruction and the list of interactive elements on the current page, decide which element(s) to interact with and how.

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

If NONE of the listed elements is plausibly the target of the instruction (e.g. the target is likely off-screen, inside a collapsed section, or not yet rendered), set "notFound": true and leave candidates empty. Do NOT invent element IDs. The system will scroll once and re-ask.
`.trim();

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
    private mode: 'aom' | 'hybrid' | 'vision' = 'aom',
    /**
     * Cross-site widget pattern cache. When present, each `act()` call
     * first fingerprints the top relevant elements and probes the cache
     * — a hit routes past the LLM entirely. Successful and failed
     * actions write back to build up the library of learned patterns.
     */
    private patternCache: IPatternCache | null = null
  ) {}

  private log(level: 1 | 2 | 3, message: string): void {
    if (this.verbose >= level) console.log(message);
  }

  private warn(level: 1 | 2 | 3, message: string): void {
    if (this.verbose >= level) console.warn(message);
  }

  /**
   * Loose name-compatibility check used at pattern lookup time. Two names
   * are compatible if either is a non-trivial substring of the other —
   * after lowercase-trim normalisation. This preserves cross-site reuse
   * ("Email" on site A matches "Email address" on site B) while rejecting
   * false same-shape hits within a single page ("Outlined" vs "With a
   * start adornment").
   */
  private static namesCompatible(candidate: string, cached: string): boolean {
    const a = candidate.toLowerCase().trim();
    const b = cached.toLowerCase().trim();
    if (!a || !b) return a === b;
    if (a === b) return true;
    // Substring either direction — but require at least 3 chars of overlap
    // to avoid accidental matches on short words like "ok" or "id".
    if (a.length >= 3 && b.includes(a)) return true;
    if (b.length >= 3 && a.includes(b)) return true;
    return false;
  }

  /** Roles whose textual value is sensitive and must NOT be persisted to the pattern cache. */
  private static readonly SENSITIVE_VALUE_ROLES: ReadonlySet<string> = new Set<string>([
    // Password fields are classified as 'textbox' by the parser — we can't
    // distinguish them by role alone. Attribute-level filtering happens when
    // the pattern is recorded (type=password / type=tel on the element).
  ]);

  /**
   * Sanitises a candidate PatternSequence before recording — strips the
   * user-entered value when the target looks like a sensitive input so
   * we never persist credentials / phone numbers / card data into the
   * shared pattern cache.
   */
  private static sanitiseForCache(
    sequence: PatternSequence,
    sensitive: boolean
  ): PatternSequence {
    if (!sensitive) return sequence;
    const { value, ...rest } = sequence;
    void value;
    return rest;
  }

  /** Heuristic: is filling this element's value a privacy concern worth redacting? */
  private async isSensitiveTarget(target: UIElement): Promise<boolean> {
    if (!target) return false;
    // Role-based fast check
    if (ActionEngine.SENSITIVE_VALUE_ROLES.has(target.role)) return true;
    // DOM-level check: look for type=password / type=tel at the target coords
    try {
      const { x, y, width, height } = target.boundingClientRect;
      return await this.page.evaluate(
        ({ cx, cy }: { cx: number; cy: number }) => {
          const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
          if (!el) return false;
          let cursor: HTMLElement | null = el;
          for (let d = 0; d < 4 && cursor; d++) {
            if (cursor.tagName === 'INPUT') {
              const t = (cursor as HTMLInputElement).type?.toLowerCase();
              if (t === 'password' || t === 'tel') return true;
            }
            const input = cursor.querySelector?.('input[type="password"], input[type="tel"]');
            if (input) return true;
            cursor = cursor.parentElement;
          }
          return false;
        },
        { cx: x + width / 2, cy: y + height / 2 }
      );
    } catch {
      return false;
    }
  }

  /**
   * Fingerprints the top-N candidates in a single round-trip. Computed
   * ONCE per `act()` call BEFORE the action fires so both the cache
   * lookup and any post-success recording reference the pre-action DOM
   * state — critical for stability since many libraries mutate widget
   * classes after focus/fill/select (e.g. `Mui-focused` prepended to a
   * container's classList would otherwise flip the library signature
   * between lookup and record, causing permanent cache misses).
   */
  /**
   * How many relevance-ranked candidates get fingerprinted and probed.
   * Wider pools increase the chance of hitting the user's intended target
   * when many same-shape widgets exist on one page (MUI docs can easily
   * render 15+ textbox variants). Upper bound is a cost-vs-coverage
   * trade-off: each extra candidate is ~2ms of `elementFromPoint` +
   * fingerprint work, all in a single page.evaluate round-trip.
   */
  private static readonly PATTERN_PROBE_TOP_N = 20;

  private async fingerprintTopCandidates(
    candidates: UIElement[],
  ): Promise<Map<number, PatternFingerprint>> {
    if (!this.patternCache || candidates.length === 0) return new Map();
    const top = candidates
      .slice(0, ActionEngine.PATTERN_PROBE_TOP_N)
      .filter(c => c.boundingClientRect.width > 0);
    if (top.length === 0) return new Map();
    return await this.stateParser.computeTargetFingerprints(
      top.map(e => ({
        id: e.id,
        x: e.boundingClientRect.x + e.boundingClientRect.width / 2,
        y: e.boundingClientRect.y + e.boundingClientRect.height / 2,
      })),
    );
  }

  /**
   * Probes the pattern cache for any of the pre-fingerprinted candidates.
   * Returns a successful ActionResult on a confirmed hit, `null` on miss
   * (the caller then continues down to the LLM path).
   *
   * Failure semantics: if a cache-hit action throws, we record a failure
   * against that pattern (confidence decay) and return `null` so the
   * normal LLM flow takes over. Self-healing by design.
   */
  private async tryPatternCache(
    candidates: UIElement[],
    fingerprints: Map<number, PatternFingerprint>,
    instruction: string,
  ): Promise<ActionResult | null> {
    if (!this.patternCache || fingerprints.size === 0) return null;
    // Iterate candidates in relevance order — first cache hit wins.
    const top = candidates.slice(0, ActionEngine.PATTERN_PROBE_TOP_N);
    this.log(2, `[Pattern] probing ${top.length} candidate(s) against cache (${fingerprints.size} fingerprints computed)`);
    for (const candidate of top) {
      const fp = fingerprints.get(candidate.id);
      if (!fp || (!fp.aria && !fp.library && !fp.topology)) {
        this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — no fingerprint (elementFromPoint returned nothing)`);
        continue;
      }
      const entry = this.patternCache.get(fp, instruction);
      if (!entry) {
        this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — MISS fp=${JSON.stringify(fp)}`);
        continue;
      }
      // Name-compat check: several widgets on the same page often share a
      // fingerprint (e.g. every MUI TextField has the same ARIA shape).
      // The stored sequence points at a specific element by name, so hit
      // only when the candidate's accessible name is compatible with the
      // cached one — exact or substring either direction. Prevents cache
      // hits from routing the action to the wrong same-shape widget.
      if (!ActionEngine.namesCompatible(candidate.name, entry.sequence.name)) {
        this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — FP match but name differs from cached "${entry.sequence.name}" — skipping`);
        continue;
      }
      this.log(2, `[Pattern]   ${candidate.id} (${candidate.role} "${candidate.name}") — HIT fp=${JSON.stringify(fp)}`);

      const actionLabel = `${entry.sequence.action} on "${candidate.name}" (${candidate.role}) [pattern]`;
      this.log(1, `[Act] 🎯 ${actionLabel}`);
      this.stateParser.invalidateCache();
      try {
        await this.performAction(entry.sequence.action, candidate, entry.sequence.value);
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        // Successful hit — bump confidence
        this.patternCache.recordSuccess(fp, instruction, entry.sequence);
        return {
          success: true,
          message: `Successfully performed ${entry.sequence.action} on "${candidate.name}" (pattern)`,
          action: actionLabel,
        };
      } catch (err: any) {
        // Pattern matched but execution failed — decay confidence, fall through to LLM
        this.patternCache.recordFailure(fp, instruction);
        this.warn(2, `[Act] Pattern hit failed (${err?.message ?? 'unknown'}) — falling back to LLM`);
        return null;
      }
    }
    return null;
  }

  /**
   * Records a successful LLM-directed action into the pattern cache.
   * Uses the pre-action fingerprint map populated by `act()` (either via
   * the initial top-N batch or the JIT single-target compute triggered
   * when the LLM picked outside the top-N). Both paths guarantee the
   * stored key was computed on the same pre-action DOM state a future
   * lookup will probe — no drift from framework state classes.
   * Sensitive-field filter kicks in for password / tel / card inputs.
   */
  private async recordPatternSuccess(
    target: UIElement,
    sequence: PatternSequence,
    instruction: string,
    preActionFingerprints: Map<number, PatternFingerprint>,
  ): Promise<void> {
    if (!this.patternCache) return;
    try {
      const fp = preActionFingerprints.get(target.id);
      if (!fp || (!fp.aria && !fp.library && !fp.topology)) {
        this.log(2, `[Pattern] record skipped for ${target.id} "${target.name}" — no usable fingerprint`);
        return;
      }
      const sensitive = await this.isSensitiveTarget(target);
      this.patternCache.recordSuccess(fp, instruction, ActionEngine.sanitiseForCache(sequence, sensitive));
      this.log(2, `[Pattern] recorded ${target.role} "${target.name}" fp=${JSON.stringify(fp)}`);
    } catch {
      // Pattern recording must never abort the caller's action path.
    }
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
        await this.clickLocator(locator, { timeout: 10_000 });
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
          await this.clickLocator(locator, { timeout: 5000 });
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

    // ── LLM decision loop ─────────────────────────────────────────────────────
    // Ask the LLM first. If it signals `notFound: true` (target is not in the
    // current element list), scroll one viewport-height once and re-ask. No
    // blind pre-scrolling on keyword mismatch — that caused phantom scrolling
    // on pages where instruction tokens (brand names, sort values, etc.) don't
    // literally appear in role+name.
    let currentState = state;
    let decision!: {
      candidates: { elementId: number; confidence?: number }[];
      action: ActionType;
      value?: string;
      targetElementId?: number;
      reasoning: string;
      notFound?: boolean;
    };
    let candidateIds: number[] = [];
    let preActionFingerprints: Map<number, PatternFingerprint> = new Map();

    for (let attempt = 0; attempt <= MAX_NOT_FOUND_SCROLL_RETRIES; attempt++) {
      const visibleElements = filterRelevantElements(currentState.elements, resolvedInstruction, this.maxElements);

      if (currentState.elements.length > visibleElements.length) {
        this.log(3, `[Act] chunk-processing: ${currentState.elements.length} → ${visibleElements.length} elements sent to LLM (instruction: "${resolvedInstruction}")`);
      }

      // ── Pattern cache: cross-site learned widget interactions ───────────────
      // Fingerprint the top relevant candidates ONCE, pre-action. The same
      // fingerprint map feeds both lookup and post-success recording, so
      // the key written on run N matches the key probed on run N+1 — state
      // classes added by the action (e.g. focus indicators) don't drift
      // the hash.
      preActionFingerprints = await this.fingerprintTopCandidates(visibleElements);
      const patternResult = await this.tryPatternCache(visibleElements, preActionFingerprints, resolvedInstruction);
      if (patternResult) return patternResult;

      const prompt = `
Current Page URL: ${currentState.url}
Page Title: ${currentState.title}
Instruction: "${resolvedInstruction}"

Elements on page (id | role | name | region):
${visibleElements.map(e => `${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}${e.value !== undefined ? ` | value="${e.value}"` : ''}`).join('\n')}
      `.trim();

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
          notFound: { type: 'boolean' },
        },
        required: ['candidates', 'action', 'reasoning'],
      };

      decision = await this.gemini.generateStructuredData<typeof decision>(prompt, schema, {
        systemInstruction: ACT_SYSTEM_INSTRUCTION,
      });

      // Normalize: support old single-elementId responses gracefully. If the LLM
      // returns empty candidates AND no legacy elementId, treat it as notFound
      // so we retry (or fail cleanly) instead of silently clicking element 0.
      const legacyElementId = (decision as any).elementId;
      if (decision.candidates?.length) {
        candidateIds = decision.candidates.map(c => c.elementId);
      } else if (typeof legacyElementId === 'number') {
        candidateIds = [legacyElementId];
      } else {
        candidateIds = [];
        if (!decision.notFound) {
          this.log(2, `[Act] LLM returned empty candidates without notFound — treating as notFound`);
          decision.notFound = true;
        }
      }

      if (decision.notFound && attempt < MAX_NOT_FOUND_SCROLL_RETRIES) {
        this.log(2, `[Act] LLM: target not in current view — scrolling ${Math.round(NOT_FOUND_SCROLL_FRACTION * 100)}% viewport and re-asking`);
        const vpHeight = await this.page.evaluate(() => window.innerHeight).catch(() => 720);
        await this.page.mouse.wheel(0, Math.floor(vpHeight * NOT_FOUND_SCROLL_FRACTION));
        await waitForPageSettle(this.page, 500);
        this.stateParser.invalidateCache();
        currentState = await this.stateParser.parse();
        continue;
      }
      break;
    }



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

      // JIT pre-action fingerprint: if the LLM picked a target that wasn't
      // in the initial top-N fingerprinted pool, capture its fingerprint
      // NOW (still pre-action — performAction hasn't fired yet). This
      // guarantees the recorded fingerprint matches the state a future
      // `tryPatternCache` lookup will probe — no post-action drift.
      if (this.patternCache && target && !preActionFingerprints.has(target.id)) {
        const { x, y, width, height } = target.boundingClientRect;
        if (width > 0 && height > 0) {
          const extra = await this.stateParser.computeTargetFingerprints([
            { id: target.id, x: x + width / 2, y: y + height / 2 },
          ]);
          const fp = extra.get(target.id);
          if (fp) preActionFingerprints.set(target.id, fp);
        }
      }

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
        // ── Pattern cache: record widget-level success for cross-site reuse ──
        if (target && !isScrollWithoutTarget) {
          await this.recordPatternSuccess(target, {
            action: decision.action,
            role: target.role,
            name: target.name,
            ...(decision.value !== undefined ? { value: decision.value } : {}),
          }, resolvedInstruction, preActionFingerprints);
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
                const z = parseInt(s.zIndex, 10);
                if (s.position === 'fixed' || s.position === 'absolute' || (Number.isFinite(z) && z > 999)) el.remove();
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
      // Re-parse after recovery and retry the first candidate. Match by
      // role + name, NOT by `element.id`: the id is a parse-counter
      // (0..N) that the state-parser re-assigns on every parse, so
      // `candidateIds[0]` from the pre-recovery state points to an
      // arbitrary element in the fresh state (often a completely
      // unrelated widget that happens to land at that index). Role +
      // name are semantic and survive re-parse.
      this.stateParser.invalidateCache();
      const freshState = await this.stateParser.parse();
      const retryTarget = fallbackTarget
        ? (freshState.elements.find(e =>
            e.role === fallbackTarget.role && e.name === fallbackTarget.name
          ) ?? null)
        : null;
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

      // Before giving up, check whether a CAPTCHA is blocking the page.
      // When one is present, the generic "action failed" message is useless —
      // the user needs to know they hit a bot-check so they can route the
      // call through an external solver, enable stealth patches, or fall
      // back to manual intervention. Throwing CaptchaDetectedError instead
      // of returning success:false short-circuits Sentinel's retry loop
      // (no point retrying the same CAPTCHA) and surfaces the exact type.
      const captcha = await detectCaptcha(this.page).catch(() => ({ type: null as null }));
      if (captcha.type) {
        throw new CaptchaDetectedError(
          captcha.type,
          describeCaptcha(captcha.type, captcha.source),
          { captchaSource: captcha.source, failedAttempts: attempts }
        );
      }

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

    // Radio buttons: AOM bounding boxes frequently cover the entire radio-
    // group container rather than the individual radio circle + label. Using
    // coordinate-based clicking at the AOM centroid therefore hits the group
    // wrapper, triggering a coordinate-mismatch error. Playwright's locator
    // API resolves the individual radio by accessible name — no coordinates
    // needed, works regardless of group nesting or label layout.
    if (action === 'click' && target.role === 'radio') {
      try {
        await this.page
          .getByRole('radio', { name: target.name, exact: false })
          .first()
          .click({ timeout: 10_000 });
        return;
      } catch {
        // Locator miss — fall through to coordinate path
      }
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
        await this.clickLocator(locator, { timeout: 5000 });
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

    // For `select` with a visible listbox popover: skip the coord-mismatch
    // check. The popover structurally covers the trigger area with its first
    // option, so `elementFromPoint(triggerX, triggerY)` legitimately returns
    // an option element — not a real target mismatch. The switch-case below
    // handles this via `isListboxPopoverVisible` → `clickBestMatchingOption`.
    const skipCoordCheckForOpenSelect =
      action === 'select' && await this.isListboxPopoverVisible();

    if (target && !isSliderFill && !isDatepickerFill && !skipCoordCheckForOpenSelect &&
        (action === 'fill' || action === 'click' || action === 'select')) {
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
                await this.clickLocator(locator, { timeout: 3000 });
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
        // Locate the dropdown's internal search input via the ARIA popup
        // contract (aria-controls / aria-owns, trigger subtree, or a
        // visible popup-role element). See `focusDropdownPopupInput` for
        // the scope rules — never ascends to ancestor divs, so it cannot
        // grab unrelated inputs elsewhere on the page.
        let isDropdownInput = false;
        if (target.role === 'combobox' || target.role === 'listbox') {
          isDropdownInput = await this.focusDropdownPopupInput(clickX, clickY);
          if (!isDropdownInput) {
            await this.page.waitForTimeout(300);
            isDropdownInput = await this.focusDropdownPopupInput(clickX, clickY);
          }
        }

        await this.page.keyboard.press('Control+a');
        await this.page.waitForTimeout(150);
        if (this.humanLike) {
          await this.page.keyboard.type(value || '', { delay: 90 + Math.round(Math.random() * 40) });
        } else {
          await this.page.keyboard.type(value || '', { delay: 90 });
        }

        // Auto-select: after typing into a dropdown search, click the best
        // matching option. Completes the dropdown interaction in one step
        // instead of requiring a separate click step.
        if (isDropdownInput && value) {
          await this.page.waitForTimeout(400); // wait for filter/render
          await this.clickBestMatchingOption(value).catch(() => false);
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

      case 'select': {
        // If a listbox popover is ALREADY visible, the planner opened it in a
        // prior step — go straight to clicking the matching option. We skip
        // both the native <select>.value setter AND the opening click here:
        //   - The setter-shortcut is wrong for sites that surface options via
        //     custom anchor widgets backed by a hidden <select>: Amazon-style
        //     dropdowns route user intent through anchor clicks, not through
        //     programmatic change events on the underlying <select>, so
        //     setting the value silently succeeds but the UI never reacts.
        //   - Clicking the trigger would TOGGLE the popover closed.
        // Matches real-user behaviour: dropdown is open, pick the visible option.
        const popoverAlreadyOpen = await this.isListboxPopoverVisible();
        if (popoverAlreadyOpen && value) {
          const clicked = await this.clickBestMatchingOption(value).catch(() => false);
          if (clicked) {
            await this.ensurePopoverClosed(clickX, clickY);
            break;
          }
          // Match failed — fall through to fresh open+select.
        }

        // Native <select> first. AOM reports native selects as `combobox`,
        // which previously routed them through the custom-dropdown flow
        // (click → search-input walk → type → option-click). That path is
        // wrong for OS-owned popups — the dropdown can't be driven from
        // the DOM, and the ancestor-walk input search could grab unrelated
        // inputs on the page (e.g. a top-nav search bar) because a common
        // layout container lived within 5 levels. Bypass the click entirely
        // and drive the HTMLSelectElement via its native value setter.
        if (value && await this.trySetNativeSelectValue(clickX, clickY, value)) {
          break;
        }

        if (!popoverAlreadyOpen) {
          await withTimeout(this.page.mouse.click(clickX, clickY), 10_000, `open select "${target.name}"`);
        }

        if (target.role === 'combobox' || target.role === 'listbox') {
          // Custom dropdown: open → focus popup-scoped input → type → click option.
          const activeIsInput = await this.page.evaluate(() => {
            const active = document.activeElement;
            return active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA';
          }).catch(() => false);

          // Only type the value when we actually focused a search input inside
          // the popover. Listboxes WITHOUT a search input (plain <li>/<a
          // role="option"> lists) would otherwise receive keystrokes into the
          // document body, which on many sites closes the popover or shifts
          // focus to an unrelated global search bar — destroying the options
          // before we can match+click them.
          let hasInput = activeIsInput;
          if (!hasInput) {
            await this.page.waitForTimeout(300);
            hasInput = await this.focusDropdownPopupInput(clickX, clickY);
          }

          if (hasInput) {
            await this.page.keyboard.type(value || '');
            await this.page.waitForTimeout(500);
          } else {
            // No search input — give the popover a beat to finish rendering
            // its options, then go straight to match-and-click.
            await this.page.waitForTimeout(200);
          }

          const clicked = await this.clickBestMatchingOption(value || '').catch(() => false);

          if (!clicked) {
            // Fallback: press Enter to confirm current selection. Native
            // <select> dropdowns close on Enter; custom popovers may not
            // — the trailing `ensurePopoverClosed` takes care of that.
            await this.page.keyboard.press('Enter');
          }

          // Universal close: if the popover is still open (trigger's
          // aria-expanded still true near our click coords), dispatch
          // Escape. Covers custom popovers whose close-handler didn't
          // fire from our synthetic option click or from Enter — without
          // affecting spec-compliant widgets (they've already closed, so
          // the stuck check returns false and Escape is skipped).
          await this.ensurePopoverClosed(clickX, clickY);
        } else {
          // Native <select> fallback when the upfront detection missed
          // (e.g. an overlay sits on top of the <select> at click coords).
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
      }

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
   * Focuses the search/filter input that belongs to a dropdown popup
   * opened at `(clickX, clickY)`. Returns `true` if an input was focused
   * (either already-focused by the click, or located and focused here).
   *
   * Scope rules, in order:
   *   1. If the trigger (or its closest `[role="combobox"]` ancestor)
   *      declares `aria-controls` / `aria-owns`, only that popup element
   *      is searched. This is the WAI-ARIA contract for combobox-popup
   *      linkage and is authoritative when present.
   *   2. The trigger's own subtree — covers wrapper widgets (MUI
   *      Autocomplete, Ant Design Select) where the input is a child
   *      of the combobox-root.
   *   3. Any visible element with `role="listbox" | "dialog" | "menu" |
   *      "tree"` elsewhere in the document — popups rendered via portals
   *      (Radix, Headless UI, Shadcn).
   *
   * Critically, this **never walks up to ancestor `<div>`s** looking for
   * inputs. The previous implementation did, which on deeply-nested
   * layouts (e.g. e-commerce results pages) could easily match the
   * top-nav search bar or a newsletter signup instead of the dropdown's
   * own filter input.
   */
  private async focusDropdownPopupInput(clickX: number, clickY: number): Promise<boolean> {
    return await this.page.evaluate(
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
          (trigger.closest('[role="combobox"], [role="listbox"]') as HTMLElement | null) ?? trigger;

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
  private async trySetNativeSelectValue(clickX: number, clickY: number, value: string): Promise<boolean> {
    return await this.page.evaluate(
      ({ x, y, val }: { x: number; y: number; val: string }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!hit) return false;
        const sel = (hit.closest?.('select') ?? hit.querySelector?.('select')) as HTMLSelectElement | null;
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
  private async clickLocator(
    locator: import('playwright').Locator,
    options: { timeout?: number } = {}
  ): Promise<void> {
    try {
      await locator.click(options);
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (/intercepts pointer events|intercept.*pointer events/i.test(msg)) {
        this.warn(2, `[Act] Pointer-intercept detected — retrying via DOM-level click`);
        await locator.evaluate((el: HTMLElement) => el.click());
        return;
      }
      throw err;
    }
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
  private async clickBestMatchingOption(value: string): Promise<boolean> {
    if (!value) return false;
    return await this.page.evaluate(
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
  private async isListboxPopoverVisible(): Promise<boolean> {
    const result = await this.page.evaluate(() => {
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

  private async ensurePopoverClosed(clickX: number, clickY: number): Promise<void> {
    await this.page.waitForTimeout(150);
    const stuck = await this.page.evaluate(
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
      await this.page.keyboard.press('Escape').catch(() => {});
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
    const hasConsentContext = state.elements.some(e =>
      /\b(cookies?|consent|gdpr|dsgvo|datenschutz|privacy|datenverarbeitung|privatsph[aä]re)\b/i.test(e.name)
    );
    if (hasConsentContext) {
      const MAX_CONSENT_BUTTON_LEN = 50;
      const acceptPattern =
        /^\s*(akzeptieren|accept( all| cookies)?|zustimmen|i ?agree|got it|verstanden|alle[s]? (akzeptieren|cookies? (akzeptieren|zulassen)?|annehmen)|allow all)\s*$/i;
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
          await this.performAction('click', cookieElement);
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
          catch { await this.clickLocator(locator, { timeout: 5000 }); }
        } else {
          await this.clickLocator(locator, { timeout: 5000 });
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
