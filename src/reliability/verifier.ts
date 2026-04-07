import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';

export interface VerificationResult {
  done: boolean;
  success: boolean;
  message: string;
  confidence: number;
}

/** Returns a short, meaningful summary of a state for comparison */
function summarizeState(state: SimplifiedState): object {
  // Collect which elements are currently checked (radio/checkbox selections)
  const checkedElements = state.elements
    .filter(e => e.state?.checked === true || e.state?.checked === 'mixed')
    .map(e => `${e.role}: ${e.name}`);

  // Track the currently focused element (indicates text-entry happened)
  const focusedElement = state.elements.find(e => e.state?.focused)?.name ?? null;

  return {
    url: state.url,
    title: state.title,
    elementCount: state.elements.length,
    // Top-25 element names for semantic diff
    elementNames: state.elements.slice(0, 25).map(e => `${e.role}: ${e.name}`),
    // State snapshots — detects radio/checkbox selection and focus changes
    checkedElements,
    focusedElement,
  };
}

export class Verifier {
  constructor(
    private page: Page,
    private stateParser: StateParser,
    private gemini: LLMProvider
  ) {}

  async verifyAction(
    action: string,
    stateBefore: SimplifiedState,
    stateAfter: SimplifiedState
  ): Promise<VerificationResult> {

    // ── Fast path 1: URL changed → navigation → very likely success ───────────
    if (stateBefore.url !== stateAfter.url) {
      console.log(`[Verifier] URL changed: ${stateBefore.url} → ${stateAfter.url}. Auto-success.`);
      return {
        done: true,
        success: true,
        message: `Page navigated to ${stateAfter.url}`,
        confidence: 0.95,
      };
    }

    // ── Fast path 2: Page title changed ───────────────────────────────────────
    if (stateBefore.title !== stateAfter.title) {
      console.log(`[Verifier] Title changed: "${stateBefore.title}" → "${stateAfter.title}". Auto-success.`);
      return {
        done: true,
        success: true,
        message: `Page title changed to "${stateAfter.title}"`,
        confidence: 0.90,
      };
    }

    // ── Fast path 3: Radio/checkbox selection changed ─────────────────────────
    // Clicking a radio button or checkbox doesn't change the element list,
    // but it does change the `checked` state — detect that explicitly.
    const beforeChecked = stateBefore.elements
      .filter(e => e.state?.checked === true || e.state?.checked === 'mixed')
      .map(e => e.name)
      .sort()
      .join('\0');
    const afterChecked = stateAfter.elements
      .filter(e => e.state?.checked === true || e.state?.checked === 'mixed')
      .map(e => e.name)
      .sort()
      .join('\0');

    if (beforeChecked !== afterChecked) {
      console.log(`[Verifier] Checked state changed. Auto-success.`);
      return {
        done: true,
        success: true,
        message: 'Checkbox/radio selection changed',
        confidence: 0.92,
      };
    }

    // ── Slow path: LLM semantic verification ─────────────────────────────────
    const prompt = `
      I performed an action on a web page: "${action}"

      State BEFORE the action:
      ${JSON.stringify(summarizeState(stateBefore), null, 2)}

      State AFTER the action:
      ${JSON.stringify(summarizeState(stateAfter), null, 2)}

      Based on the semantic differences between these states (URL, title, element changes,
      checked/focused state), did the action achieve its intended goal?
      Rate your confidence between 0.0 and 1.0.
    `;

    const schema = {
      type: "object",
      properties: {
        success: { type: "boolean" },
        confidence: { type: "number" },
        explanation: { type: "string" }
      },
      required: ["success", "confidence", "explanation"]
    };

    try {
      const result = await this.gemini.generateStructuredData<{
        success: boolean;
        confidence: number;
        explanation: string;
      }>(prompt, schema);

      return {
        done: true,
        success: result.success,
        message: result.explanation,
        confidence: result.confidence,
      };
    } catch (err: any) {
      // LLM error (rate limit, network, etc.) — don't crash the whole act() call.
      console.warn(`[Verifier] LLM verification failed: ${err.message}. Returning unverified result.`);
      return {
        done: true,
        success: true,
        message: 'Unverified (LLM error during verification)',
        confidence: 0.5,
      };
    }
  }
}
