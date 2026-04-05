import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { UIElement } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';

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
 * Waits for the page to settle after an action.
 */
async function waitForPageSettle(page: Page, timeout = 3000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {
    // Page might be a SPA that never fully idles – that is OK
  });
}

export class ActionEngine {
  constructor(
    private page: Page,
    private stateParser: StateParser,
    private gemini: LLMProvider
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
      - "hover": move mouse over an element
      - "press": press a keyboard key or shortcut (requires "value", e.g. "Enter", "Escape", "Tab", "Control+a")
      - "select": select an option from a <select> dropdown (requires "value" = option text or value)
      - "scroll-down": scroll the page down (elementId optional, use 0 if no specific element)
      - "scroll-up": scroll the page up (elementId optional, use 0 if no specific element)
      - "scroll-to": scroll to bring a specific element into view (requires elementId)

      If the action is "fill", "press", or "select", provide the "value" field.
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
            'fill', 'hover', 'press', 'select',
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
      await waitForPageSettle(this.page);
      return {
        success: true,
        message: `Successfully performed ${decision.action}${target ? ` on "${target.name}"` : ''}`,
        action: actionLabel,
      };
    } catch (primaryError: any) {
      console.warn(`[Act] Primary action failed, trying semantic fallback... (${primaryError.message})`);
      try {
        await this.performSemanticFallback(decision.action, target, decision.value);
        await waitForPageSettle(this.page);
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
    // Scroll actions that don't need a target element
    if (action === 'scroll-down' && !target) {
      await this.page.evaluate(() => window.scrollBy(0, 600));
      return;
    }
    if (action === 'scroll-up' && !target) {
      await this.page.evaluate(() => window.scrollBy(0, -600));
      return;
    }

    if (!target) throw new Error('No target element provided for action: ' + action);

    const { x, y, width, height } = target.boundingClientRect;
    const cx = x + width / 2;
    const cy = y + height / 2;

    switch (action) {
      case 'click':
        await this.page.mouse.click(cx, cy);
        break;

      case 'double-click':
        await this.page.mouse.dblclick(cx, cy);
        break;

      case 'right-click':
        await this.page.mouse.click(cx, cy, { button: 'right' });
        break;

      case 'fill':
        await this.page.mouse.click(cx, cy, { clickCount: 3 });
        await this.page.keyboard.type(value || '');
        break;

      case 'hover':
        await this.page.mouse.move(cx, cy);
        break;

      case 'press':
        // Focus the element first, then press the key
        await this.page.mouse.click(cx, cy);
        await this.page.keyboard.press(value || 'Enter');
        break;

      case 'select':
        // Use Playwright's selectOption via coordinate-based locator
        await this.page.mouse.click(cx, cy);
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

  private async performSemanticFallback(
    action: ActionType,
    target: UIElement | null,
    value?: string
  ): Promise<void> {
    // Page-level scroll fallback
    if (action === 'scroll-down' && !target) {
      await this.page.keyboard.press('PageDown');
      return;
    }
    if (action === 'scroll-up' && !target) {
      await this.page.keyboard.press('PageUp');
      return;
    }

    if (!target) throw new Error('No target element for semantic fallback: ' + action);

    const locator = this.page.locator(
      `[role="${target.role}"]`,
      target.name ? { hasText: target.name } : undefined
    ).first();

    switch (action) {
      case 'click':
        await locator.click({ timeout: 5000 });
        break;

      case 'double-click':
        await locator.dblclick({ timeout: 5000 });
        break;

      case 'right-click':
        await locator.click({ button: 'right', timeout: 5000 });
        break;

      case 'fill':
        await locator.click({ clickCount: 3, timeout: 5000 });
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
