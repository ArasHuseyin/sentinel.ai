import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { UIElement } from '../core/state-parser.js';
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
  | 'scroll-to';

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
          attributes: true,
          characterData: true,
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

/**
 * Tokenises a string into lowercase words (≥ 2 chars) for relevance scoring.
 */
function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2)
  )];
}

/**
 * Filters `elements` down to at most `maxCount` entries, keeping those whose
 * role+name overlap most with the instruction. When the page has ≤ maxCount
 * elements the list is returned unchanged. Elements with a relevance score of 0
 * fill remaining slots in their original order (stable sort).
 */
export function filterRelevantElements(
  elements: UIElement[],
  instruction: string,
  maxCount: number
): UIElement[] {
  if (elements.length <= maxCount) return elements;

  const tokens = tokenize(instruction);
  if (tokens.length === 0) return elements.slice(0, maxCount);

  const scored = elements.map(el => {
    const text = `${el.role} ${el.name}`
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s]/g, ' ');
    let score = 0;
    for (const token of tokens) {
      if (text.includes(token)) score++;
    }
    return { el, score };
  });

  // Stable sort: higher score first, original order preserved for ties
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map(s => s.el);
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
    private humanLike = false
  ) {}

  private log(level: 1 | 2 | 3, message: string): void {
    if (this.verbose >= level) console.log(message);
  }

  private warn(level: 1 | 2 | 3, message: string): void {
    if (this.verbose >= level) console.warn(message);
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

    const visibleElements = filterRelevantElements(state.elements, resolvedInstruction, this.maxElements);

    if (state.elements.length > visibleElements.length) {
      this.log(3, `[Act] chunk-processing: ${state.elements.length} → ${visibleElements.length} elements sent to LLM (instruction: "${resolvedInstruction}")`);
    }

    const prompt = `
      Current Page URL: ${state.url}
      Page Title: ${state.title}
      Instruction: "${resolvedInstruction}"

      Elements on page:
      ${JSON.stringify(visibleElements.map(e => ({ id: e.id, role: e.role, name: e.name })), null, 2)}

      Select the ID of the element to interact with and the action to perform.
      Available actions:
      - "click": single click on an element
      - "double-click": double click on an element
      - "right-click": right-click (context menu) on an element
      - "fill": type text into an input field (requires "value")
      - "append": add text to the end of an input field without clearing existing content (requires "value")
      - "hover": move mouse over an element
      - "press": press a keyboard key or shortcut (requires "value", e.g. "Enter", "Escape", "Tab", "Control+a")
      - "select": select an option from a <select> dropdown (requires "value" = option text or value)
      - "scroll-down": scroll the page down (elementId optional, use 0 if no specific element)
      - "scroll-up": scroll the page up (elementId optional, use 0 if no specific element)
      - "scroll-to": scroll to bring a specific element into view (requires elementId)

      If the action is "fill", "append", "press", or "select", provide the "value" field.
      For scroll actions without a target element, set elementId to 0.
      Provide clear reasoning for your choice.
    `;

    const schema = {
      type: 'object',
      properties: {
        elementId: { type: 'number' },
        action: {
          type: 'string',
          enum: [
            'click', 'double-click', 'right-click',
            'fill', 'append', 'hover', 'press', 'select',
            'scroll-down', 'scroll-up', 'scroll-to',
          ],
        },
        value: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['elementId', 'action', 'reasoning'],
    };

    const decision = await this.gemini.generateStructuredData<{
      elementId: number;
      action: ActionType;
      value?: string;
      reasoning: string;
    }>(prompt, schema);

    // Scroll actions without a target element are valid with elementId = 0
    const isScrollWithoutTarget =
      (decision.action === 'scroll-down' || decision.action === 'scroll-up') &&
      decision.elementId === 0;

    const target = isScrollWithoutTarget
      ? null
      : (state.elements.find(e => e.id === decision.elementId) ?? null);

    if (!isScrollWithoutTarget && !target) {
      return { success: false, message: `Could not find element with ID ${decision.elementId}` };
    }

    const actionLabel = target
      ? `${decision.action} on "${target.name}" (${target.role})`
      : `${decision.action} (page)`;

    this.log(1, `[Act] ${actionLabel}`);
    this.log(2, `[Act] reasoning: ${decision.reasoning}`);
    this.log(3, `[Act] decision: ${JSON.stringify({ elementId: decision.elementId, action: decision.action, value: decision.value, reasoning: decision.reasoning })}`);

    // Generate stable selector before action — DOM is still in pre-action state
    const selector = target ? (await generateSelector(this.page, target) ?? undefined) : undefined;

    // Invalidate cache after action – state will change
    this.stateParser.invalidateCache();

    try {
      await this.performAction(decision.action, target, decision.value);
      await waitForPageSettle(this.page, this.domSettleTimeoutMs);
      // ── Self-Healing Locator: populate cache on success ────────────────────
      if (this.locatorCache && target && !isScrollWithoutTarget) {
        this.locatorCache.set(state.url, resolvedInstruction, {
          action: decision.action,
          role: target.role,
          name: target.name,
          ...(decision.value !== undefined ? { value: decision.value } : {}),
        });
      }
      return {
        success: true,
        message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''}`,
        action: actionLabel,
        ...(selector !== undefined ? { selector } : {}),
      };
    } catch (primaryError: any) {
      const attempts: ActionAttempt[] = [
        { path: 'coordinate-click', error: primaryError.message },
      ];

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

      this.warn(2, `[Act] Primary action failed, trying semantic fallback... (${primaryError.message})`);
      try {
        await this.performSemanticFallback(decision.action, target, decision.value);
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
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
  }

  private async performAction(
    action: ActionType,
    target: UIElement | null,
    value?: string
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

    const { x, y, width, height } = target.boundingClientRect;
    const cx = x + width / 2;
    const cy = y + height / 2;

    // Viewport bounds check: if the element is outside the visible area, the
    // AOM bounding box is stale or the element hasn't been scrolled into view.
    // Throw immediately so the semantic fallback (which calls scrollIntoViewIfNeeded)
    // can handle it — cheaper than a misplaced click.
    const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
    if (cx < 0 || cy < 0 || cx > viewport.width || cy > viewport.height) {
      throw new ActionError(
        `Element "${target.name}" is outside viewport at (${cx.toFixed(0)}, ${cy.toFixed(0)}) — triggering scroll fallback`,
        { element: target.name, x: cx, y: cy }
      );
    }

    // Human-like: move mouse along a Bézier curve to the target, then pause briefly
    if (this.humanLike && (
      action === 'click' || action === 'double-click' || action === 'right-click' ||
      action === 'hover' || action === 'fill' || action === 'append'
    )) {
      const pos = await this.page.mouse.move(0, 0).then(() => ({ x: 0, y: 0 })).catch(() => ({ x: 0, y: 0 }));
      // Get current mouse position via evaluate (Playwright doesn't expose it directly)
      const cur = await this.page.evaluate(() => ({
        x: (window as any).__sentinelMouseX ?? 0,
        y: (window as any).__sentinelMouseY ?? 0,
      })).catch(() => ({ x: 0, y: 0 }));
      await moveMouse(this.page, cur.x, cur.y, cx, cy);
      // Track mouse position for next call
      await this.page.evaluate(
        ({ x, y }) => { (window as any).__sentinelMouseX = x; (window as any).__sentinelMouseY = y; },
        { x: cx, y: cy }
      ).catch(() => {});
      // Pre-click pause: 80–200 ms
      await this.page.waitForTimeout(80 + Math.round(Math.random() * 120));
    }

    switch (action) {
      case 'click':
        if (target.role === 'radio' || target.role === 'checkbox') {
          // CSS-styled radio/checkbox inputs are often visually replaced by a
          // <label> or <div>; the actual <input> is hidden (display:none / opacity:0).
          // Playwright's mouse.click on invisible inputs is unreliable — use JS instead.
          await this.page.evaluate(
            ({ x, y }: { x: number; y: number }) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null;
              if (!el) return;
              // Case 1: element wraps a hidden <input type="radio|checkbox">
              const hiddenInput = el.querySelector(
                'input[type="radio"], input[type="checkbox"]'
              ) as HTMLInputElement | null;
              if (hiddenInput) { hiddenInput.click(); return; }
              // Case 2: element is inside a <label> that controls a hidden input
              const label = el.closest('label') as HTMLLabelElement | null;
              if (label) { label.click(); return; }
              // Case 3: element itself is the best we can do
              el.click();
            },
            { x: cx, y: cy }
          );
        } else {
          await withTimeout(this.page.mouse.click(cx, cy), 10_000, `click "${target.name}"`);
        }
        break;

      case 'double-click':
        await withTimeout(this.page.mouse.dblclick(cx, cy), 10_000, `double-click "${target.name}"`);
        break;

      case 'right-click':
        await withTimeout(
          this.page.mouse.click(cx, cy, { button: 'right' }),
          10_000,
          `right-click "${target.name}"`
        );
        break;

      case 'fill':
        await withTimeout(this.page.mouse.click(cx, cy, { clickCount: 3 }), 10_000, `focus "${target.name}"`);
        if (this.humanLike) {
          await this.page.keyboard.type(value || '', { delay: 30 + Math.round(Math.random() * 50) });
        } else {
          await withTimeout(this.page.keyboard.type(value || ''), 10_000, `type into "${target.name}"`);
        }
        break;

      case 'append':
        await withTimeout(this.page.mouse.click(cx, cy), 10_000, `focus "${target.name}"`);
        await withTimeout(this.page.keyboard.press('End'), 10_000, `move to end "${target.name}"`);
        if (this.humanLike) {
          await this.page.keyboard.type(value || '', { delay: 30 + Math.round(Math.random() * 50) });
        } else {
          await withTimeout(this.page.keyboard.type(value || ''), 10_000, `append to "${target.name}"`);
        }
        break;

      case 'hover':
        await withTimeout(this.page.mouse.move(cx, cy), 10_000, `hover "${target.name}"`);
        break;

      case 'press':
        await withTimeout(this.page.mouse.click(cx, cy), 10_000, `focus "${target.name}"`);
        await withTimeout(
          this.page.keyboard.press(value || 'Enter'),
          10_000,
          `press "${value}" on "${target.name}"`
        );
        break;

      case 'select':
        await withTimeout(this.page.mouse.click(cx, cy), 10_000, `open select "${target.name}"`);
        await this.page.evaluate(
          ({ x, y, val }: { x: number; y: number; val: string }) => {
            const el = document.elementFromPoint(x, y) as HTMLSelectElement | null;
            if (el && el.tagName === 'SELECT') {
              const opt = Array.from(el.options).find(
                o => o.text === val || o.value === val
              );
              if (opt) {
                el.value = opt.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          },
          { x: cx, y: cy, val: value || '' }
        );
        break;

      case 'scroll-down':
        await this.page.evaluate(
          ({ x, y }: { x: number; y: number }) => {
            const el = document.elementFromPoint(x, y);
            if (el) el.scrollBy(0, 300);
          },
          { x: cx, y: cy }
        );
        break;

      case 'scroll-up':
        await this.page.evaluate(
          ({ x, y }: { x: number; y: number }) => {
            const el = document.elementFromPoint(x, y);
            if (el) el.scrollBy(0, -300);
          },
          { x: cx, y: cy }
        );
        break;

      case 'scroll-to':
        await this.page.evaluate(
          ({ x, y }: { x: number; y: number }) => {
            const el = document.elementFromPoint(x, y);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          },
          { x: cx, y: cy }
        );
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

  private async performSemanticFallback(
    action: ActionType,
    target: UIElement | null,
    value?: string
  ): Promise<void> {
    // Page-level scroll fallback — mouse.wheel is more reliable than PageDown
    // because it targets whichever element is under the cursor.
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
        if (target?.role === 'radio' || target?.role === 'checkbox') {
          // Playwright's check() handles hidden inputs by clicking their label —
          // more reliable than click() for CSS-styled form controls.
          try {
            await locator.check({ timeout: 5000 });
          } catch {
            await locator.click({ timeout: 5000 });
          }
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
