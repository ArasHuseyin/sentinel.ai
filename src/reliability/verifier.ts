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
  return {
    url: state.url,
    title: state.title,
    elementCount: state.elements.length,
    // Include top-25 element names for semantic diff (not just count)
    elementNames: state.elements.slice(0, 25).map(e => `${e.role}: ${e.name}`),
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

    // Fast path: URL changed → navigation happened → very likely success
    if (stateBefore.url !== stateAfter.url) {
      console.log(`[Verifier] URL changed: ${stateBefore.url} → ${stateAfter.url}. Auto-success.`);
      return {
        done: true,
        success: true,
        message: `Page navigated to ${stateAfter.url}`,
        confidence: 0.95,
      };
    }

    const prompt = `
      I performed an action on a web page: "${action}"
      
      State BEFORE the action:
      ${JSON.stringify(summarizeState(stateBefore), null, 2)}
      
      State AFTER the action:
      ${JSON.stringify(summarizeState(stateAfter), null, 2)}
      
      Based on the semantic differences between these states (URL, title, element changes),
      did the action achieve its intended goal?
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
  }
}
