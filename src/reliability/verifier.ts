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
    elementNames: state.elements.slice(0, 25).map(e => `${e.role}: ${e.name}${e.region ? ` [${e.region}]` : ''}`),
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
    stateAfter: SimplifiedState,
    userInstruction?: string
  ): Promise<VerificationResult> {
    // The submit-intent guard (in Fast Path 5) looks at the user's original
    // instruction, not the technical action label. "Search for X and submit"
    // is decomposed by the planner into a single fill action — the fill's
    // action label doesn't mention "submit", so relying on `action` alone
    // misses every real submit-then-autocomplete false positive.
    const intentString = userInstruction ?? action;

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

    // ── Submit-intent safeguard ───────────────────────────────────────────────
    // Actions that semantically require a server round-trip (search, submit,
    // press enter, go) almost always produce URL or title change on modern
    // consumer sites. If we reached this point — URL AND title both unchanged
    // — the submission did NOT fire. Any downstream fast-path signal (DOM
    // delta, focus change, checked toggle) is a side-effect of the partial
    // interaction (autocomplete opened, input focused), not evidence of
    // success. Skip straight to the LLM slow path so it can honestly read
    // the AOM diff.
    //
    // Root cause: the planner sometimes decomposes "search AND submit" into
    // a single fill, and the fill's side-effects (focus, autocomplete) fooled
    // every non-navigation fast-path into false-positive success on Amazon
    // and Wikipedia during live testing.
    const isSubmitIntent = /\b(submit|press\s+(?:enter|return)|send\s+search|search\s+for|navigate\s+to|go\s+to)\b/i.test(intentString);
    if (isSubmitIntent) {
      console.log(`[Verifier] Submit-intent action with no URL/title change — skipping non-navigation fast paths, going to LLM slow path`);
    }

    // ── Fast path 3: Scroll actions — AOM doesn't change on scroll ───────────
    // Scroll actions move the viewport but don't add/remove elements from the
    // accessibility tree, so the before/after state looks identical. The action
    // itself never throws, so treat scroll as always successful.
    const isScroll = /scroll/i.test(action);
    if (isScroll) {
      return {
        done: true,
        success: true,
        message: 'Scroll action executed',
        confidence: 0.95,
      };
    }

    // ── Fast path 4a: Click on checkbox/switch/radio → inherent toggle ──────
    // These roles define a toggle-on-click contract. If the click itself
    // didn't throw, the toggle happened — the DOM state change is guaranteed
    // by the ARIA spec. Re-verifying via AOM comparison is unreliable here
    // because many libraries (MUI, Ant, Chakra) place `checked` on a hidden
    // native input (role=presentation, excluded from AOM) rather than on the
    // visible wrapper that carries the ARIA role. Trusting the click avoids
    // false-negative retries that would un-toggle the element.
    const isToggleClick = /click/i.test(action) &&
      /\b(checkbox|switch|radio)\b/i.test(action);
    if (isToggleClick && !isSubmitIntent) {
      console.log(`[Verifier] Toggle-click on checkbox/switch/radio — auto-success.`);
      return {
        done: true,
        success: true,
        message: 'Checkbox/switch/radio toggle executed',
        confidence: 0.90,
      };
    }

    // ── Fast path 4b: Checked state change detected in AOM ──────────────────
    // Falls through here for non-click actions or roles we didn't special-case.
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

    if (beforeChecked !== afterChecked && !isSubmitIntent) {
      console.log(`[Verifier] Checked state changed. Auto-success.`);
      return {
        done: true,
        success: true,
        message: 'Checkbox/radio selection changed',
        confidence: 0.92,
      };
    }

    // ── Fast path 5: Significant element count change ─────────────────────────
    // If the number of interactive elements changed by ±5 or more, something
    // clearly happened (modal opened/closed, list loaded, etc.) — no need for LLM.
    //
    // False-positive guard 1: if the delta is small-to-medium (5-19) AND the
    // target element vanished from the new state without a URL/title change,
    // we likely hit an unrelated DOM update (analytics widget, notification
    // counter, lazy-loaded sidebar) rather than the intended interaction.
    // Fall through to semantic verification instead of claiming auto-success.
    // Huge deltas (≥ 20) are still auto-success — modal open, page transition.
    //
    // False-positive guard 2: for actions that semantically imply submission
    // (search, press enter, go, submit), a DOM delta dominated by `option`
    // role elements without a URL change almost always means an autocomplete
    // dropdown opened — the typing worked, but the submit did not fire. This
    // was the dominant failure mode in live testing (Amazon, Wikipedia search).
    // Fall through to LLM slow path, which can reason about whether the state
    // reflects the intended outcome.
    const elementDelta = Math.abs(stateAfter.elements.length - stateBefore.elements.length);
    if (elementDelta >= 5 && !isSubmitIntent) {
      const targetNameMatch = /"([^"]+)"/.exec(action);
      const targetName = targetNameMatch?.[1];
      const targetStillPresent = targetName
        ? stateAfter.elements.some(e => e.name === targetName)
        : true; // no target extracted — assume presence (can't check)

      const hugeDelta = elementDelta >= 20;

      if (hugeDelta || targetStillPresent) {
        console.log(`[Verifier] Element count changed by ${elementDelta} (${stateBefore.elements.length} → ${stateAfter.elements.length}). Auto-success.`);
        return {
          done: true,
          success: true,
          message: `DOM changed significantly (${elementDelta} elements ${stateAfter.elements.length > stateBefore.elements.length ? 'added' : 'removed'})`,
          confidence: 0.85,
        };
      } else {
        // Medium delta + target vanished → likely unrelated DOM update.
        // Fall through to focus check / semantic LLM verification.
        console.log(`[Verifier] Element delta ${elementDelta} but target "${targetName}" vanished — not auto-success, falling through`);
      }
    }

    // ── Fast path 6: Focused element changed ─────────────────────────────────
    // A focus change is strong evidence that a click/tab/fill action succeeded.
    // Guarded by !isSubmitIntent: for search-and-submit intents, focus moving
    // into the search box is the PARTIAL result (typing started), not success.
    const focusedBefore = stateBefore.elements.find(e => e.state?.focused)?.name ?? null;
    const focusedAfter  = stateAfter.elements.find(e => e.state?.focused)?.name ?? null;
    if (focusedBefore !== focusedAfter && !isSubmitIntent) {
      console.log(`[Verifier] Focused element changed: "${focusedBefore}" → "${focusedAfter}". Auto-success.`);
      return {
        done: true,
        success: true,
        message: `Focus moved to "${focusedAfter ?? 'none'}"`,
        confidence: 0.85,
      };
    }

    // ── Slow path: LLM semantic verification ─────────────────────────────────
    // The prompt distinguishes between the original user goal and the atomic
    // action the planner executed. Without that split, the LLM rates success
    // against the narrow action ("fill search box") and happily returns true
    // when the side-effects (input focused, autocomplete opened) match, even
    // when the broader user goal ("search AND submit") was not achieved.
    const userGoalBlock = userInstruction && userInstruction !== action
      ? `User's original goal: "${userInstruction}"\n      Atomic action executed: "${action}"`
      : `I performed an action on a web page: "${action}"`;

    const prompt = `
      ${userGoalBlock}

      State BEFORE the action:
      ${JSON.stringify(summarizeState(stateBefore), null, 2)}

      State AFTER the action:
      ${JSON.stringify(summarizeState(stateAfter), null, 2)}

      Based on the semantic differences between these states (URL, title, element changes,
      checked/focused state), did the action achieve the USER'S ORIGINAL GOAL — not merely
      the atomic action? For example, if the user wanted to "search and submit" but the
      state only shows autocomplete suggestions appeared (no URL/title change), the goal
      was NOT achieved. Rate your confidence between 0.0 and 1.0.
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
