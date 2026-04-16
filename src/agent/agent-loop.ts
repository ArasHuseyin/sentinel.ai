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
 * Used for both detection (has-blocker check) and fingerprinting (attempt
 * throttle). Multi-lingual on purpose — this is not a site-specific hack,
 * it's universal consent-banner vocabulary.
 */
const COOKIE_BLOCKER_PATTERN =
  /cookie|consent|accept|akzeptieren|zustimmen|agree|got it|verstanden|gdpr|datenschutz|privacy/i;

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

  /** Returns true if the current page state contains a cookie banner or modal overlay. */
  private hasBlocker(state: SimplifiedState): boolean {
    const hasCookieCta = state.elements.some(e =>
      (e.role === 'button' || e.role === 'link') && COOKIE_BLOCKER_PATTERN.test(e.name)
    );
    const hasModal = state.elements.some(e => e.region === 'modal' || e.region === 'popup');
    return hasCookieCta || hasModal;
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
    const stepEvents: AgentStepEvent[] = [];
    const collectedSelectors: Record<string, string> = {};
    this.memory.clear();
    this.recoveryAttempts.clear();

    this.logger.info(`🎯 Goal: "${goal}" (max ${maxSteps} steps)`, { goal, maxSteps });

    let stepNumber = 0;
    let consecutiveFailures = 0;
    let extractedData: any = undefined;

    while (stepNumber < maxSteps) {
      stepNumber++;
      this.logger.info(`📍 Step ${stepNumber}/${maxSteps}`, { stepNumber, maxSteps });

      // 1. Parse current state
      this.stateParser.invalidateCache();
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
            // Scroll to top after blocker removal — the main content/form
            // is almost always at the top of the page after overlays are gone.
            if (this.page) {
              await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
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

              if (isFillLike) {
                // For fill/select actions: check if any element value changed
                const valuesBefore = state.elements.filter(e => e.value !== undefined).map(e => `${e.name}=${e.value}`).join('|');
                const valuesAfter = stateAfter.elements.filter(e => e.value !== undefined).map(e => `${e.name}=${e.value}`).join('|');
                if (valuesBefore === valuesAfter) {
                  this.logger.warn(`Fill/select action reported success but no input values changed — treating as failed`);
                  span.setAttributes({ 'sentinel.success': false });
                  return { success: false, message: `${r.message} (but no input values changed)`, action: r.action ?? planned.instruction };
                }
              } else {
                // For click actions: check multiple signals for state change.
                // The old check was too strict (exact element-name match) and
                // missed visual-only changes like focus shifts, tab selections,
                // and attribute changes that don't alter element names.
                const urlChanged = state.url !== stateAfter.url;
                const titleChanged = state.title !== stateAfter.title;
                const countChanged = state.elements.length !== stateAfter.elements.length;

                // Build compact fingerprints of both states for comparison.
                // Includes name, role, region, value, and key state flags.
                const fingerprint = (els: typeof state.elements) =>
                  els.map(e => `${e.role}|${e.name}|${e.region ?? ''}|${e.value ?? ''}|${e.error ?? ''}|${e.state?.focused ? 'F' : ''}${e.state?.checked ?? ''}${e.state?.disabled ? 'D' : ''}`).join('\n');

                const unchanged = !urlChanged && !titleChanged && !countChanged &&
                  fingerprint(state.elements) === fingerprint(stateAfter.elements);

                if (unchanged) {
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

      // 5. Record in memory
      this.memory.add({
        stepNumber,
        instruction: planned.instruction,
        action: result.action ?? planned.instruction,
        success: result.success,
        pageUrl: state.url,
        pageTitle: state.title,
        timestamp: Date.now(),
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

        // Exact instruction match = loop (regardless of target)
        const exactLoop = new Set(recentHistory.map(s => s.instruction)).size === 1;

        if (exactLoop || targetLoop) {
          this.logger.warn(
            `❌ Aborting: instruction loop detected — "${recentHistory[0]?.instruction}" repeated 3 times without progress.`,
            { loopInstruction: recentHistory[0]?.instruction }
          );
          break;
        }
      }
    }

    // 6. Final reflection – did we actually achieve the goal?
    this.stateParser.invalidateCache();
    const finalState = await this.stateParser.parse();
    let goalAchieved = false;
    try {
      goalAchieved = await this.planner.reflect(goal, this.memory, finalState);
    } catch {
      goalAchieved = false;
    }

    const message = goalAchieved
      ? `Goal achieved in ${stepNumber} step(s).`
      : `Agent stopped after ${stepNumber} step(s) without fully achieving the goal.`;

    this.logger.info(`${goalAchieved ? '✅' : '⚠️ '} ${message}`, { goalAchieved });

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
