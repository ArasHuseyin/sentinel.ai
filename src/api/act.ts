import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { UIElement } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';

export interface ActOptions {
  variables?: Record<string, string>;
  retries?: number;
}

export interface ActionResult {
  success: boolean;
  message: string;
  action?: string;
}

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
    private gemini: GeminiService
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
      
      Select the ID of the element to interact with and the action to perform (click, fill, hover).
      If the action is "fill", provide the value to fill.
      Provide clear reasoning for your choice.
    `;

    const schema = {
      type: 'object',
      properties: {
        elementId: { type: 'number' },
        action: { type: 'string', enum: ['click', 'fill', 'hover'] },
        value: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['elementId', 'action', 'reasoning'],
    };

    const decision = await this.gemini.generateStructuredData<{
      elementId: number;
      action: 'click' | 'fill' | 'hover';
      value?: string;
      reasoning: string;
    }>(prompt, schema);

    const target = state.elements.find(e => e.id === decision.elementId);
    if (!target) {
      return { success: false, message: `Could not find element with ID ${decision.elementId}` };
    }

    const actionLabel = `${decision.action} on "${target.name}" (${target.role})`;
    console.log(`[Act] ${actionLabel} → ${decision.reasoning}`);

    // Invalidate cache after action – state will change
    this.stateParser.invalidateCache();

    try {
      await this.performAction(decision.action, target, decision.value);
      await waitForPageSettle(this.page);
      return {
        success: true,
        message: `Successfully performed ${decision.action} on "${target.name}"`,
        action: actionLabel,
      };
    } catch (primaryError: any) {
      console.warn(`[Act] Coordinate action failed, trying semantic fallback... (${primaryError.message})`);
      try {
        await this.performSemanticFallback(decision.action, target, decision.value);
        await waitForPageSettle(this.page);
        return {
          success: true,
          message: `Successfully performed ${decision.action} on "${target.name}" (via fallback)`,
          action: actionLabel,
        };
      } catch (fallbackError: any) {
        return { success: false, message: `Action failed: ${fallbackError.message}`, action: actionLabel };
      }
    }
  }

  private async performAction(
    action: 'click' | 'fill' | 'hover',
    target: UIElement,
    value?: string
  ): Promise<void> {
    const { x, y, width, height } = target.boundingClientRect;
    const cx = x + width / 2;
    const cy = y + height / 2;

    if (action === 'click') {
      await this.page.mouse.click(cx, cy);
    } else if (action === 'fill') {
      await this.page.mouse.click(cx, cy, { clickCount: 3 });
      await this.page.keyboard.type(value || '');
    } else if (action === 'hover') {
      await this.page.mouse.move(cx, cy);
    }
  }

  private async performSemanticFallback(
    action: 'click' | 'fill' | 'hover',
    target: UIElement,
    value?: string
  ): Promise<void> {
    const locator = this.page.locator(
      `[role="${target.role}"]`,
      target.name ? { hasText: target.name } : undefined
    ).first();

    if (action === 'click') {
      await locator.click({ timeout: 5000 });
    } else if (action === 'fill') {
      await locator.click({ clickCount: 3, timeout: 5000 });
      await locator.pressSequentially(value || '', { delay: 30 });
    } else if (action === 'hover') {
      await locator.hover({ timeout: 5000 });
    }
  }
}
