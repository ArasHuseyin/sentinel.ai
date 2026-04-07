import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { UIElement } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { VisionGrounding } from '../core/vision-grounding.js';
import { withTimeout } from '../utils/with-timeout.js';
import { ActionError } from '../types/errors.js';

export interface ActOptions {
  variables?: Record<string, string>;
  retries?: number;
}

export interface ActionResult {
  success: boolean;
  message: string;
  action?: string;
}

type ActionType =
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

export class ActionEngine {
  constructor(
    private page: Page,
    private stateParser: StateParser,
    private gemini: LLMProvider,
    private visionGrounding?: VisionGrounding,
    private domSettleTimeoutMs = 3000
  ) {}

  async act(instruction: string, options?: ActOptions): Promise<ActionResult> {
    const resolvedInstruction = interpolateVariables(instruction, options?.variables);
    const state = await this.stateParser.parse();

    const prompt = `
      Current Page URL: ${state.url}
      Page Title: ${state.title}
      Instruction: "${resolvedInstruction}"

      Elements on page:
      ${JSON.stringify(state.elements.map(e => ({ id: e.id, role: e.role, name: e.name })), null, 2)}

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

    console.log(`[Act] ${actionLabel} → ${decision.reasoning}`);

    // Invalidate cache after action – state will change
    this.stateParser.invalidateCache();

    try {
      await this.performAction(decision.action, target, decision.value);
      await waitForPageSettle(this.page, this.domSettleTimeoutMs);
      return {
        success: true,
        message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''}`,
        action: actionLabel,
      };
    } catch (primaryError: any) {
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
            };
          }
        } catch (visionError: any) {
          console.warn(`[Act] Vision fallback failed: ${visionError.message}`);
        }
      }

      console.warn(`[Act] Primary action failed, trying semantic fallback... (${primaryError.message})`);
      try {
        await this.performSemanticFallback(decision.action, target, decision.value);
        await waitForPageSettle(this.page, this.domSettleTimeoutMs);
        return {
          success: true,
          message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''} (via fallback)`,
          action: actionLabel,
        };
      } catch (fallbackError: any) {
        return { success: false, message: `Action failed: ${fallbackError.message}`, action: actionLabel };
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
        await withTimeout(this.page.keyboard.type(value || ''), 10_000, `type into "${target.name}"`);
        break;

      case 'append':
        await withTimeout(this.page.mouse.click(cx, cy), 10_000, `focus "${target.name}"`);
        await withTimeout(this.page.keyboard.press('End'), 10_000, `move to end "${target.name}"`);
        await withTimeout(this.page.keyboard.type(value || ''), 10_000, `append to "${target.name}"`);
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
