import type { ActionEngine } from '../api/act.js';
import type { ExtractionEngine } from '../api/extract.js';
import type { StateParser } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';
import { AgentMemory } from './memory.js';
import { Planner } from './planner.js';

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
}

/**
 * Autonomous multi-step agent loop.
 * Implements a Plan → Execute → Verify → Reflect cycle.
 */
export class AgentLoop {
  private planner: Planner;
  private memory: AgentMemory;

  constructor(
    private actionEngine: ActionEngine,
    private extractionEngine: ExtractionEngine,
    private stateParser: StateParser,
    private gemini: LLMProvider
  ) {
    this.planner = new Planner(gemini);
    this.memory = new AgentMemory(20);
  }

  async run(goal: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const maxSteps = options.maxSteps ?? 15;
    const stepEvents: AgentStepEvent[] = [];
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

      // 2. Plan next step
      let planned;
      try {
        planned = await this.planner.planNextStep(goal, state, this.memory);
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
        };
      }

      // 4. Execute the planned step
      const stepType = planned.type ?? 'act';
      let result;
      let stepData: any = undefined;

      if (stepType === 'extract') {
        try {
          const schema = planned.extractionSchema ?? { type: 'object' };
          const extracted = await this.extractionEngine.extract(planned.instruction, schema);
          extractedData = extracted;
          stepData = extracted;
          result = { success: true, message: `Extracted data: ${JSON.stringify(extracted).slice(0, 200)}`, action: `extract: ${planned.instruction}` };
        } catch (err: any) {
          result = { success: false, message: err.message, action: `extract: ${planned.instruction}` };
        }
      } else {
        try {
          result = await this.actionEngine.act(planned.instruction);
        } catch (err: any) {
          result = { success: false, message: err.message, action: planned.instruction };
        }
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

      // Instruction-loop detection: same instruction attempted 3 times in a row
      // (regardless of success/failure) indicates the planner is stuck.
      const recentHistory = this.memory.getHistory().slice(-3);
      if (
        recentHistory.length === 3 &&
        new Set(recentHistory.map(s => s.instruction)).size === 1
      ) {
        console.error(
          `[Agent] ❌ Aborting: instruction loop detected — ` +
          `"${recentHistory[0]?.instruction}" repeated 3 times without progress.`
        );
        break;
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
    };
  }
}
