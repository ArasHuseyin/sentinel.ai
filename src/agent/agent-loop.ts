import type { Page } from 'playwright';
import type { ActionEngine } from '../api/act.js';
import type { ExtractionEngine } from '../api/extract.js';
import type { StateParser } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import type { VisionGrounding } from '../core/vision-grounding.js';
import { slugifyInstruction } from '../core/selector-generator.js';
import { AgentMemory } from './memory.js';
import { Planner } from './planner.js';
import { withSpan } from '../utils/telemetry.js';

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

export class AgentLoop {
  private planner: Planner;
  private memory: AgentMemory;

  constructor(
    private actionEngine: ActionEngine,
    private extractionEngine: ExtractionEngine,
    private stateParser: StateParser,
    private gemini: LLMProvider,
    private page?: Page,
    private visionGrounding?: VisionGrounding
  ) {
    this.planner = new Planner(gemini);
    this.memory = new AgentMemory(20);
  }

  async run(goal: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const maxSteps = options.maxSteps ?? 15;
    const stepEvents: AgentStepEvent[] = [];
    const collectedSelectors: Record<string, string> = {};
    this.memory.clear();

    console.log(`[Agent] 🎯 Goal: "${goal}" (max ${maxSteps} steps)`);

    let stepNumber = 0;
    let consecutiveFailures = 0;
    let extractedData: any = undefined;

    while (stepNumber < maxSteps) {
      stepNumber++;
      console.log(`[Agent] 📍 Step ${stepNumber}/${maxSteps}`);

      // 1. Parse current state
      this.stateParser.invalidateCache();
      const state = await this.stateParser.parse();

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

      let planned;
      try {
        planned = await this.planner.planNextStep(goal, state, this.memory, pageDescription);
      } catch (err: any) {
        console.error(`[Agent] Planner error: ${err.message}`);
        break;
      }

      console.log(`[Agent] 💭 Plan: "${planned.instruction}" — ${planned.reasoning}`);

      // 3. Check if goal is already complete
      if (planned.isGoalComplete) {
        console.log(`[Agent] ✅ Goal marked complete by planner.`);
        const event: AgentStepEvent = {
          stepNumber,
          type: planned.type ?? 'act',
          instruction: planned.instruction,
          reasoning: planned.reasoning,
          success: true,
          pageUrl: state.url,
          pageTitle: state.title,
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
            if (r.success && !/scroll|fill|append|press|type|select/i.test(r.action ?? '')) {
              this.stateParser.invalidateCache();
              const stateAfter = await this.stateParser.parse();
              const unchanged =
                state.url === stateAfter.url &&
                state.title === stateAfter.title &&
                state.elements.length === stateAfter.elements.length &&
                state.elements.every((e, i) => e.name === stateAfter.elements[i]?.name);

              if (unchanged) {
                console.warn(`[Agent] ⚠️  Action reported success but page state unchanged — treating as failed`);
                span.setAttributes({ 'sentinel.success': false });
                return { success: false, message: `${r.message} (but page state unchanged)`, action: r.action ?? planned.instruction };
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
        console.warn(`[Agent] ⚠️  Step failed (${consecutiveFailures} consecutive): ${result.message}`);
        if (consecutiveFailures >= 3) {
          console.error(`[Agent] ❌ Aborting: 3 consecutive failures.`);
          break;
        }
      } else {
        consecutiveFailures = 0;
      }

      // Instruction-loop detection: same or semantically similar instruction
      // attempted 3 times in a row indicates the planner is stuck.
      const recentHistory = this.memory.getHistory().slice(-3);
      if (recentHistory.length === 3) {
        // Exact match
        const exactLoop = new Set(recentHistory.map(s => s.instruction)).size === 1;
        // Semantic match: normalize to lowercase core words, ignore phrasing differences
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß\s]/g, '').replace(/\s+/g, ' ').trim();
        const normalized = recentHistory.map(s => normalize(s.instruction));
        const semanticLoop = !exactLoop && new Set(normalized).size === 1;
        // Target match: same element targeted 3 times (extract element name from action string)
        const extractTarget = (s: string) => {
          const match = s.match(/on\s+"([^"]+)"/i) ?? s.match(/"([^"]+)"/);
          return match?.[1]?.toLowerCase() ?? '';
        };
        const targets = recentHistory.map(s => extractTarget(s.action));
        const targetLoop = !exactLoop && !semanticLoop
          && targets[0] !== '' && new Set(targets).size === 1;

        if (exactLoop || semanticLoop || targetLoop) {
          console.error(
            `[Agent] ❌ Aborting: instruction loop detected — ` +
            `"${recentHistory[0]?.instruction}" repeated 3 times without progress.`
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

    console.log(`[Agent] ${goalAchieved ? '✅' : '⚠️ '} ${message}`);

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
