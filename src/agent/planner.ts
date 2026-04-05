import type { LLMProvider } from '../utils/llm-provider.js';
import type { SimplifiedState } from '../core/state-parser.js';
import type { AgentMemory } from './memory.js';

export interface PlannedStep {
  instruction: string;
  reasoning: string;
  isGoalComplete: boolean;
}

/**
 * Uses Gemini to plan the next action step based on the current page state and history.
 */
export class Planner {
  constructor(private gemini: LLMProvider) {}

  async planNextStep(
    goal: string,
    state: SimplifiedState,
    memory: AgentMemory
  ): Promise<PlannedStep> {
    const prompt = `
You are an autonomous browser agent. Your goal is: "${goal}"

Current page:
- URL: ${state.url}
- Title: ${state.title}
- Interactive elements: ${JSON.stringify(
      state.elements.slice(0, 40).map(e => ({ id: e.id, role: e.role, name: e.name })),
      null,
      2
    )}

Steps taken so far:
${memory.getSummary()}

Based on the current page state and history, decide the SINGLE next action to take.
If the goal is already fully achieved based on the history and current page, set isGoalComplete to true.
If you are stuck (same action repeated 3+ times without progress), try a different approach.

Respond with:
- instruction: a clear natural language instruction for the next action (e.g. "Click the search button", "Fill 'laptop' into the search field", "Scroll down to see more results")
- reasoning: why this is the right next step
- isGoalComplete: true only if the goal has been fully achieved
    `;

    const schema = {
      type: 'object',
      properties: {
        instruction: { type: 'string' },
        reasoning: { type: 'string' },
        isGoalComplete: { type: 'boolean' },
      },
      required: ['instruction', 'reasoning', 'isGoalComplete'],
    };

    return await this.gemini.generateStructuredData<PlannedStep>(prompt, schema);
  }

  async reflect(goal: string, memory: AgentMemory, finalState: SimplifiedState): Promise<boolean> {
    const prompt = `
You are an autonomous browser agent evaluating whether a goal has been achieved.

Goal: "${goal}"

Current page:
- URL: ${finalState.url}
- Title: ${finalState.title}

Steps taken:
${memory.getSummary()}

Has the goal been fully and successfully achieved? Answer with a single boolean.
    `;

    const schema = {
      type: 'object',
      properties: {
        goalAchieved: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['goalAchieved', 'reason'],
    };

    const result = await this.gemini.generateStructuredData<{
      goalAchieved: boolean;
      reason: string;
    }>(prompt, schema);

    return result.goalAchieved;
  }
}
