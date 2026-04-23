import type { Page } from 'playwright';
import type { ActionEngine } from '../api/act.js';
import type { ExtractionEngine } from '../api/extract.js';
import type { StateParser, SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { VisionGrounding } from '../core/vision-grounding.js';
import { slugifyInstruction } from '../core/selector-generator.js';
import { AgentMemory } from './memory.js';
import { Planner } from './planner.js';
import { withSpan } from '../utils/telemetry.js';
import { generateTOTP } from '../utils/totp.js';
import { ConsoleLogger, type Logger } from '../utils/logger.js';

/** Returns a key derived from `slug` that does not yet exist in `map`. */
function uniqueKey(slug: string, map: Record<string, unknown>): string {
  if (!(slug in map)) return slug;
  let n = 2;
  while (`${slug}${n}` in map) n++;
  return `${slug}${n}`;
}

export interface AgentRunOptions {
  maxSteps?: number;
  onStep?: (step: AgentStepEvent) => void;
  /**
   * Hard wall-clock cap in milliseconds. Checked at the start of each step; if
   * exceeded the loop exits cleanly with whatever progress was made rather than
   * pushing past an external deadline and logging contradictory "Goal achieved"
   * messages. When omitted, only `maxSteps` bounds the run.
   */
  timeoutMs?: number;
}

export interface AgentStepEvent {
  stepNumber: number;
  type: 'act' | 'extract';
  instruction: string;
  reasoning: string;
  success: boolean;
  pageUrl: string;
  pageTitle: string;
  data?: any;
}

export interface AgentResult {
  success: boolean;
  goalAchieved: boolean;
  totalSteps: number;
  message: string;
  history: AgentStepEvent[];
  data?: any;
  /**
   * Stable CSS selectors for each element the agent interacted with,
   * keyed by a camelCase slug of the instruction.
   * Only populated for successful `act` steps where a selector could be derived.
   *
   * @example
   * { clickLoginButton: 'button[data-testid="login"]', fillEmailField: '#email' }
   */
  selectors?: Record<string, string>;
}

/**
 * Autonomous multi-step agent loop.
 * Implements a Plan → Execute → Verify → Reflect cycle.
 */
/** Threshold above which the planner gets a visual page description. */
const VISION_ELEMENT_THRESHOLD = 100;

/**
 * Keywords that identify cookie-consent / GDPR / privacy CTA elements.
 * Used for fingerprinting blocker-recovery attempts (throttle). Multi-
 * lingual on purpose — universal consent-banner vocabulary.
 */
const COOKIE_BLOCKER_PATTERN =
  /cookie|consent|accept|akzeptieren|zustimmen|agree|got it|verstanden|gdpr|datenschutz|privacy/i;

/**
 * Strong accept-intent keywords — a CTA carrying one of these in a
 * prominent (non-footer, non-nav) position is almost certainly a
 * dismiss button for an overlay the state-parser didn't classify as
 * modal. Narrower than COOKIE_BLOCKER_PATTERN: the latter matches
 * "Hinweise zu Cookies" / "Privacy policy" footer links, which are
 * navigation, not blockers.
 */
const ACCEPT_INTENT_PATTERN =
  /akzeptieren|accept all|accept cookies|zustimmen|^i agree|got it|verstanden/i;

/** Max `tryRecoverFromBlocker` calls per distinct blocker fingerprint. */
const MAX_RECOVERY_ATTEMPTS_PER_STATE = 2;

export class AgentLoop {
  private planner: Planner;
  private memory: AgentMemory;
  private logger: Logger;
  /** Per-run counter of recovery attempts keyed by blocker-state fingerprint. */
  private recoveryAttempts = new Map<string, number>();

  private mfaConfig: { type: 'totp'; secret: string; digits?: number; period?: number } | undefined;

  constructor(
    private actionEngine: ActionEngine,
    private extractionEngine: ExtractionEngine,
    private stateParser: StateParser,
    private gemini: LLMProvider,
    private page?: Page,
    private visionGrounding?: VisionGrounding,
    plannerLLM?: LLMProvider,
    mfaConfig?: { type: 'totp'; secret: string; digits?: number; period?: number },
    logger?: Logger
  ) {
    this.planner = new Planner(plannerLLM ?? gemini);
    this.memory = new AgentMemory(20);
    this.mfaConfig = mfaConfig;
    this.logger = (logger ?? new ConsoleLogger(1)).child('Agent');
  }

  /**
   * Returns true if the current page state contains an actual blocking
   * overlay (modal/popup) OR a prominent accept-style CTA outside the
   * footer/nav.
   *
   * Why this is stricter than a plain cookie-keyword match: many sites
   * — Amazon, most large shops, any GDPR-compliant site — carry a
   * footer link like "Hinweise zu Cookies", "Privacy policy", or
   * "Cookie preferences" that matches `/cookie|privacy|datenschutz/i`.
   * The previous check treated these as blockers and ran recovery on
   * every single step, even though no banner was present. That
   * repeatedly triggered Pattern 2 (widget remover), which on Amazon
   * wipes 17+ legitimate `a-overlay-*` framework nodes each step and
   * destabilises the entire run.
   *
   * New rule:
   *  1. A modal/popup region must exist (state-parser's classification
   *     of overlays), OR
   *  2. A button/link with strong accept-intent (`akzeptieren`,
   *     `accept all`, `got it`, …) must exist outside the footer and
   *     nav regions. Catches banners the parser didn't classify but
   *     excludes footer cookie-policy links (their names rarely match
   *     accept-intent).
   */
  private hasBlocker(state: SimplifiedState): boolean {
    // Don't treat an intentionally-opened listbox/menu popover as a blocker —
    // it's the user's own interaction state (the planner just clicked a
    // combobox to see options). Running recovery on it would dismiss the
    // popover right before the next step tries to pick an option from it.
    const hasOpenListbox = state.elements.some(e =>
      (e.role === 'listbox' || e.role === 'option' || e.role === 'menuitem') &&
      (e.region === 'popup' || e.region === 'modal')
    );
    if (hasOpenListbox) return false;

    // A popup/modal region only counts as a blocker when it contains at
    // least one interactive control. Purely informational banners (delivery
    // toasts, "we ship to X" notices, status indicators) have no buttons or
    // inputs and cannot be dismissed — pressing Escape or removing the
    // widget would only close OUR own popovers on subsequent steps.
    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'textbox', 'combobox', 'searchbox',
      'checkbox', 'radio', 'switch', 'menuitem', 'tab',
    ]);
    const hasInteractiveModal = state.elements.some(e =>
      (e.region === 'modal' || e.region === 'popup') &&
      INTERACTIVE_ROLES.has(e.role)
    );
    if (hasInteractiveModal) return true;

    // Standalone accept/consent control — cookie banners sometimes aren't
    // regioned as modal but their accept button is still prominent.
    return state.elements.some(e =>
      (e.role === 'button' || e.role === 'link') &&
      ACCEPT_INTENT_PATTERN.test(e.name) &&
      e.region !== 'footer' &&
      e.region !== 'nav'
    );
  }

  /**
   * Stable fingerprint of the current blocker state. Identical fingerprints
   * across two parses mean recovery did not clear the blocker — at which
   * point further attempts are futile and we stop trying. Different
   * fingerprints (e.g. after a navigation introduces a new consent banner)
   * reset the attempt counter naturally.
   */
  private blockerFingerprint(state: SimplifiedState): string {
    const names = state.elements
      .filter(e => COOKIE_BLOCKER_PATTERN.test(e.name) || e.region === 'modal' || e.region === 'popup')
      .map(e => `${e.role}:${e.name}`)
      .sort()
      .slice(0, 10);
    return `${state.url}|${names.join('|')}`;
  }

  async run(goal: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const maxSteps = options.maxSteps ?? 15;
    const timeoutMs = options.timeoutMs;
    const startTime = Date.now();
    const stepEvents: AgentStepEvent[] = [];
    const collectedSelectors: Record<string, string> = {};
    let timedOut = false;
    this.memory.clear();
    this.recoveryAttempts.clear();

    this.logger.info(
      `🎯 Goal: "${goal}" (max ${maxSteps} steps${timeoutMs ? `, ${Math.round(timeoutMs / 1000)}s budget` : ''})`,
      { goal, maxSteps, ...(timeoutMs ? { timeoutMs } : {}) }
    );

    let stepNumber = 0;
    let consecutiveFailures = 0;
    let extractedData: any = undefined;

    while (stepNumber < maxSteps) {
      // Timeout guard: check before each step. Exits cleanly so the caller gets
      // an honest "stopped due to timeout" message instead of a late "Goal
      // achieved" log racing with an external wrapper's FAIL.
      if (timeoutMs !== undefined && Date.now() - startTime >= timeoutMs) {
        this.logger.warn(
          `⏱️  Timeout budget exceeded (${Math.round(timeoutMs / 1000)}s) — aborting after ${stepNumber} step(s).`,
          { elapsedMs: Date.now() - startTime, timeoutMs, stepNumber }
        );
        timedOut = true;
        break;
      }
      stepNumber++;
      this.logger.info(`📍 Step ${stepNumber}/${maxSteps}`, { stepNumber, maxSteps });

      // 1. Parse current state. Don't force-invalidate the cache here — the
      //    state-parser's 2s TTL already guards freshness, and any DOM-mutating
      //    action in act.ts explicitly invalidates post-action. Skipping the
      //    invalidate lets consecutive fast steps reuse the post-verification
      //    parse (~50–150ms saved per step). If the previous parse is older
      //    than the TTL the parser re-fetches automatically, so correctness
      //    is preserved.
      let state = await this.stateParser.parse();

      // 1b. Proactive blocker dismissal — state-based, not step-based.
      //     Run whenever a cookie banner or modal is detected, but throttle
      //     to MAX_RECOVERY_ATTEMPTS_PER_STATE per distinct blocker
      //     fingerprint. This covers late-appearing banners (login walls,
      //     dynamic GDPR popovers, step-N-triggered promos) while still
      //     bounding the loop if a banner resists dismissal.
      if (this.hasBlocker(state)) {
        const fp = this.blockerFingerprint(state);
        const attempts = this.recoveryAttempts.get(fp) ?? 0;
        if (attempts < MAX_RECOVERY_ATTEMPTS_PER_STATE) {
          this.recoveryAttempts.set(fp, attempts + 1);
          const recovered = await this.actionEngine.tryRecoverFromBlocker(state);
          if (recovered) {
            // Scroll to top after blocker removal — the main content/form is
            // almost always at the top of the page after overlays are gone.
            // Guard: skip if a listbox/menu popover is currently visible.
            // Scrolling closes most custom dropdowns (position-recalc or
            // explicit `window.scroll` listeners), and the next step's
            // interaction needs the popover to stay open.
            if (this.page) {
              const popoverOpen = await this.page.evaluate(() => {
                const nodes = document.querySelectorAll(
                  '[role="option"], [role="listbox"], [role="menu"]'
                );
                for (const n of Array.from(nodes) as HTMLElement[]) {
                  if (n.offsetParent !== null) {
                    const r = n.getBoundingClientRect();
                    if (r.width >= 1 && r.height >= 1) return true;
                  }
                }
                return false;
              }).catch(() => false);
              if (!popoverOpen) {
                await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
              }
            }
            this.stateParser.invalidateCache();
            state = await this.stateParser.parse();
          }
        } else {
          this.logger.debug(
            `Skipping blocker recovery — already attempted ${attempts}× for this state`,
            { fingerprint: fp, attempts }
          );
        }
      }

      // 2. Plan next step — add visual context for complex pages
      let pageDescription: string | undefined;
      if (this.visionGrounding && this.page && state.elements.length > VISION_ELEMENT_THRESHOLD) {
        try {
          const screenshot = await this.visionGrounding.takeScreenshot(this.page);
          pageDescription = await this.visionGrounding.describeScreen(screenshot);
        } catch {
          // Vision failed — proceed without visual context
        }
      }

      // Generate TOTP code if MFA is configured — inject into goal so planner can use it
      let effectiveGoal = goal;
      if (this.mfaConfig?.type === 'totp') {
        const code = generateTOTP(this.mfaConfig.secret, this.mfaConfig.digits, this.mfaConfig.period);
        effectiveGoal = `${goal}\n\nIMPORTANT: If you see a 2FA/verification code/OTP field, fill it with: ${code}`;
      }

      let planned;
      try {
        planned = await this.planner.planNextStep(effectiveGoal, state, this.memory, pageDescription);
      } catch (err: any) {
        this.logger.warn(`Planner error: ${err.message}`, { error: err.message });
        break;
      }

      this.logger.notice(`💭 Plan: "${planned.instruction}" — ${planned.reasoning}`, {
        instruction: planned.instruction,
        reasoning: planned.reasoning,
      });

      // 3. Check if goal is already complete
      if (planned.isGoalComplete) {
        // If the planner marks goal complete AND plans an extraction,
        // execute the extraction before stopping — the data is part of the goal.
        if (planned.type === 'extract') {
          if (extractedData !== undefined) {
            // Already extracted in a previous step — reuse, don't call LLM again
            this.logger.info(`✅ Goal complete (extraction already done).`);
          } else {
            this.logger.info(`✅ Goal complete — executing final extraction.`);
            try {
              const extracted = await this.extractionEngine.extract(
                planned.instruction, planned.extractionSchema as any
              );
              extractedData = extracted;
              this.logger.info(`📊 Extracted: ${JSON.stringify(extracted).slice(0, 500)}`, { extracted });
            } catch (err: any) {
              this.logger.warn(`Extraction failed: ${err.message}`, { error: err.message });
            }
          }
        } else {
          this.logger.info(`✅ Goal marked complete by planner.`);
        }
        const event: AgentStepEvent = {
          stepNumber,
          type: planned.type ?? 'act',
          instruction: planned.instruction,
          reasoning: planned.reasoning,
          success: true,
          pageUrl: state.url,
          pageTitle: state.title,
          ...(extractedData !== undefined ? { data: extractedData } : {}),
        };
        stepEvents.push(event);
        options.onStep?.(event);
        return {
          success: true,
          goalAchieved: true,
          totalSteps: stepNumber,
          message: `Goal achieved in ${stepNumber} step(s).`,
          history: stepEvents,
          ...(extractedData !== undefined ? { data: extractedData } : {}),
          ...(Object.keys(collectedSelectors).length > 0 ? { selectors: collectedSelectors } : {}),
        };
      }

      // 4. Execute the planned step
      const stepType = planned.type ?? 'act';
      let result: { success: boolean; message: string; action?: string; selector?: string };
      let stepData: any = undefined;

      if (stepType === 'extract') {
        result = await withSpan('sentinel.agent.step', {
          'sentinel.step':        stepNumber,
          'sentinel.type':        'extract',
          'sentinel.instruction': planned.instruction,
          'sentinel.url':         state.url,
        }, async (span) => {
          try {
            const schema = planned.extractionSchema ?? { type: 'object' };
            const extracted = await this.extractionEngine.extract(planned.instruction, schema);
            extractedData = extracted;
            stepData = extracted;
            this.logger.info(`📊 Extracted: ${JSON.stringify(extracted).slice(0, 500)}`, { extracted });
            span.setAttributes({ 'sentinel.success': true });
            return { success: true, message: `Extracted data: ${JSON.stringify(extracted).slice(0, 200)}`, action: `extract: ${planned.instruction}` };
          } catch (err: any) {
            span.setAttributes({ 'sentinel.success': false });
            return { success: false, message: err.message, action: `extract: ${planned.instruction}` };
          }
        });
      } else {
        result = await withSpan('sentinel.agent.step', {
          'sentinel.step':        stepNumber,
          'sentinel.type':        'act',
          'sentinel.instruction': planned.instruction,
          'sentinel.url':         state.url,
        }, async (span) => {
          try {
            const r = await this.actionEngine.act(planned.instruction);

            // Post-action verification: if act() reports success, check that
            // the page actually changed. Catches false-positives from semantic
            // fallback where the locator "clicks" but nothing happens.
            if (r.success && !/scroll/i.test(r.action ?? '')) {
              this.stateParser.invalidateCache();
              const stateAfter = await this.stateParser.parse();

              const isFillLike = /fill|append|press|type|select/i.test(r.action ?? '');

              // Structural progress signals — shared by click AND fill/select.
              // Computing these unconditionally lets fill/select accept any
              // observable change (navigation, list refresh, focus shift) as
              // success, not only a value-diff. Crucial for selects that trigger
              // page transitions or AJAX list updates without writing back to
              // the bound input element.
              const urlChanged = state.url !== stateAfter.url;
              const titleChanged = state.title !== stateAfter.title;
              const countChanged = state.elements.length !== stateAfter.elements.length;

              const fingerprintLine = (e: typeof state.elements[number]) =>
                `${e.role}|${e.name}|${e.region ?? ''}|${e.value ?? ''}|${e.error ?? ''}|${e.state?.focused ? 'F' : ''}${e.state?.checked ?? ''}${e.state?.disabled ? 'D' : ''}`;

              // Count element-level fingerprint diffs by index. A single diff is
              // usually incidental noise (ad re-render, live counter, animated label);
              // a real click typically moves focus AND toggles target state, or opens
              // a menu that adds rows — both produce ≥2 diffs (or trigger count change).
              const beforeLines = state.elements.map(fingerprintLine);
              const afterLines = stateAfter.elements.map(fingerprintLine);
              let diffCount = 0;
              const maxLen = Math.max(beforeLines.length, afterLines.length);
              for (let i = 0; i < maxLen; i++) {
                if (beforeLines[i] !== afterLines[i]) diffCount++;
              }

              // Also accept interactive-state flips regardless of count — those are
              // direct interaction signals (focus move, checkbox toggle, disable).
              let interactionFlip = false;
              const minLen = Math.min(state.elements.length, stateAfter.elements.length);
              for (let i = 0; i < minLen; i++) {
                const b = state.elements[i]?.state;
                const a = stateAfter.elements[i]?.state;
                if (b?.focused !== a?.focused || b?.checked !== a?.checked || b?.disabled !== a?.disabled) {
                  interactionFlip = true;
                  break;
                }
              }

              const structuralChange = urlChanged || titleChanged || countChanged || interactionFlip || diffCount >= 2;

              if (isFillLike) {
                // Value-diff is the strongest signal for fill/select, but not the
                // only one: selects that submit a form or trigger AJAX may leave
                // the input value unchanged while still producing real progress.
                // Accept either signal.
                const valuesBefore = state.elements.filter(e => e.value !== undefined).map(e => `${e.name}=${e.value}`).join('|');
                const valuesAfter = stateAfter.elements.filter(e => e.value !== undefined).map(e => `${e.name}=${e.value}`).join('|');
                const valueChanged = valuesBefore !== valuesAfter;
                if (!valueChanged && !structuralChange) {
                  this.logger.warn(`Fill/select action reported success but page state and input values unchanged — treating as failed`);
                  span.setAttributes({ 'sentinel.success': false });
                  return { success: false, message: `${r.message} (but page state and input values unchanged)`, action: r.action ?? planned.instruction };
                }
              } else {
                // Click: structural change is the only signal available.
                if (!structuralChange) {
                  this.logger.warn(`Action reported success but page state unchanged — treating as failed`);
                  span.setAttributes({ 'sentinel.success': false });
                  return { success: false, message: `${r.message} (but page state unchanged)`, action: r.action ?? planned.instruction };
                }
              }
            }

            // Collect selector from successful act steps
            if (r.success && r.selector) {
              const slug = slugifyInstruction(planned.instruction);
              collectedSelectors[uniqueKey(slug, collectedSelectors)] = r.selector;
            }
            span.setAttributes({
              'sentinel.success': r.success,
              ...(r.selector ? { 'sentinel.selector': r.selector } : {}),
            });
            return r;
          } catch (err: any) {
            span.setAttributes({ 'sentinel.success': false });
            return { success: false, message: err.message, action: planned.instruction };
          }
        });
      }

      const event: AgentStepEvent = {
        stepNumber,
        type: stepType,
        instruction: planned.instruction,
        reasoning: planned.reasoning,
        success: result.success,
        pageUrl: state.url,
        pageTitle: state.title,
        ...(stepData !== undefined ? { data: stepData } : {}),
      };
      stepEvents.push(event);
      options.onStep?.(event);

      // 5. Record in memory. For extract steps, include the extracted data so
      // the planner can see what's already known and mark the goal complete
      // instead of re-extracting the same content under varying field names.
      this.memory.add({
        stepNumber,
        instruction: planned.instruction,
        action: result.action ?? planned.instruction,
        success: result.success,
        pageUrl: state.url,
        pageTitle: state.title,
        timestamp: Date.now(),
        ...(stepType === 'extract' && stepData !== undefined ? { data: stepData } : {}),
      });

      if (!result.success) {
        consecutiveFailures++;
        this.logger.warn(`Step failed (${consecutiveFailures} consecutive): ${result.message}`, {
          consecutiveFailures, message: result.message,
        });
        if (consecutiveFailures >= 3) {
          this.logger.warn(`❌ Aborting: 3 consecutive failures.`);
          break;
        }
      } else {
        consecutiveFailures = 0;
      }

      // Instruction-loop detection: same TARGET element acted on 3 times
      // in a row without progress indicates the planner is stuck.
      // Uses the actual target element name (not the full instruction text)
      // to avoid false positives when different fields have similar instructions.
      const recentHistory = this.memory.getHistory().slice(-3);
      if (recentHistory.length === 3) {
        // Extract target element + action type from the action string
        const extractTarget = (s: string) => {
          const match = s.match(/on\s+"([^"]+)"/i) ?? s.match(/"([^"]+)"/);
          return match?.[1]?.toLowerCase() ?? '';
        };
        const extractAction = (s: string) => {
          const match = s.match(/^(\w+)\s/);
          return match?.[1]?.toLowerCase() ?? s.toLowerCase();
        };

        // Same action + same target 3 times = loop
        const actionTargets = recentHistory.map(s => `${extractAction(s.action)}:${extractTarget(s.action)}`);
        const targetLoop = actionTargets[0] !== ':' && new Set(actionTargets).size === 1;

        // Same TARGET 3 times regardless of action alternation. Catches the
        // click→select→click→select… pattern on a stuck dropdown that `targetLoop`
        // misses (its Set has size > 1 because actions differ). We additionally
        // require at least one failed step in the window so genuine multi-step
        // interactions on the same element (focus + fill + press) aren't blocked.
        const targetsOnly = recentHistory.map(s => extractTarget(s.action));
        const anyFailed = recentHistory.some(s => !s.success);
        const stuckOnTarget =
          targetsOnly[0] !== '' &&
          new Set(targetsOnly).size === 1 &&
          anyFailed;

        // Exact instruction match = loop (regardless of target)
        const exactLoop = new Set(recentHistory.map(s => s.instruction)).size === 1;

        // Extract-loop: three consecutive extract steps returning semantically
        // identical data. The planner tends to rephrase the schema with new
        // field names (`confirmation_message` → `confirmation_text` → …) which
        // defeats `exactLoop`, but the payload text stays the same. Compare the
        // concatenated string values of each object to catch this class of loop.
        const extractDataFingerprint = (data: unknown): string | null => {
          if (data === undefined || data === null) return null;
          if (typeof data === 'string') return data.trim().toLowerCase();
          if (typeof data === 'object') {
            // Concatenate the *values* (not keys) so differently-named fields
            // with the same content produce the same fingerprint.
            const values = Object.values(data as Record<string, unknown>)
              .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
              .join('|')
              .trim()
              .toLowerCase();
            return values.length > 0 ? values : null;
          }
          return JSON.stringify(data).trim().toLowerCase();
        };
        const extractFingerprints = recentHistory.map(s => extractDataFingerprint(s.data));
        const extractLoop =
          extractFingerprints.every(fp => fp !== null) &&
          new Set(extractFingerprints).size === 1;

        if (exactLoop || targetLoop || extractLoop || stuckOnTarget) {
          const reason = extractLoop
            ? 'extract loop detected — same data returned 3 times under varying schemas'
            : stuckOnTarget
              ? `stuck on target "${targetsOnly[0]}" — 3 actions on same element with at least one failure`
              : `instruction loop detected — "${recentHistory[0]?.instruction}" repeated 3 times without progress`;
          this.logger.warn(`❌ Aborting: ${reason}.`, {
            loopInstruction: recentHistory[0]?.instruction,
            extractLoop,
            stuckOnTarget,
          });
          break;
        }
      }
    }

    // 6. Final reflection – did we actually achieve the goal? Skip the reflect
    // LLM call entirely on timeout: reflect needs a real signal to be meaningful,
    // and logging a late "Goal achieved" after an external wrapper has already
    // reported FAIL is worse than a clean timeout message.
    let goalAchieved = false;
    if (!timedOut) {
      this.stateParser.invalidateCache();
      const finalState = await this.stateParser.parse();
      try {
        goalAchieved = await this.planner.reflect(goal, this.memory, finalState);
      } catch {
        goalAchieved = false;
      }
    }

    const message = timedOut
      ? `Agent stopped after ${stepNumber} step(s) due to timeout.`
      : goalAchieved
        ? `Goal achieved in ${stepNumber} step(s).`
        : `Agent stopped after ${stepNumber} step(s) without fully achieving the goal.`;

    this.logger.info(`${goalAchieved ? '✅' : '⚠️ '} ${message}`, { goalAchieved, ...(timedOut ? { timedOut: true } : {}) });

    return {
      success: goalAchieved,
      goalAchieved,
      totalSteps: stepNumber,
      message,
      history: stepEvents,
      ...(extractedData !== undefined ? { data: extractedData } : {}),
      ...(Object.keys(collectedSelectors).length > 0 ? { selectors: collectedSelectors } : {}),
    };
  }
}
