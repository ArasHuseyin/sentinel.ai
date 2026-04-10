import type { LLMProvider } from '../utils/llm-provider.js';
import type { SimplifiedState } from '../core/state-parser.js';
import type { AgentMemory } from './memory.js';
import { filterRelevantElements } from '../api/act.js';

export interface PlannedStep {
  type: 'act' | 'extract';
  instruction: string;
  reasoning: string;
  isGoalComplete: boolean;
  extractionSchema?: Record<string, any>;
}

/**
 * Uses Gemini to plan the next action step based on the current page state and history.
 */
export class Planner {
  constructor(private gemini: LLMProvider) {}

  async planNextStep(
    goal: string,
    state: SimplifiedState,
    memory: AgentMemory,
    pageDescription?: string
  ): Promise<PlannedStep> {
    const prompt = `
You are an autonomous browser agent. Your goal is: "${goal}"

Current page:
- URL: ${state.url}
- Title: ${state.title}${pageDescription ? `\n- Visual layout: ${pageDescription}` : ''}
- Interactive elements (id | role | name | region):
${filterRelevantElements(state.elements, goal, 50).map(e => `${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}`).join('\n')}

Steps taken so far:
${memory.getSummary()}

Rules:
- If the current URL already matches the goal topic (e.g. you're on an insurance page and the goal is insurance), you are already on the right page — do NOT click navigation links. Instead, interact with the form/content directly.
- If form fields (textbox, combobox, searchbox, spinbutton) are visible, fill them BEFORE clicking other buttons. Forms should be completed top-to-bottom, then submitted.
- Buttons that display a current value (like a brand name, category, or date) next to a label are dropdown selectors — click them to open the dropdown and change the value.
- Only click navigation buttons/links if no relevant form fields or dropdown selectors are present.
- If a previous step failed or had no effect, try a completely different approach — do NOT repeat the same action.
- If the goal is already fully achieved based on the history and current page, set isGoalComplete to true.

Decide the SINGLE next step to take.

Respond with:
- type: "act" for browser actions (click, fill, scroll, etc.), "extract" for extracting structured data from the current page
- instruction: a clear natural language instruction for the next action (e.g. "Click the search button", "Fill 'laptop' into the search field") or extraction (e.g. "Get all product names and prices")
- reasoning: why this is the right next step
- isGoalComplete: true only if the goal has been fully achieved
- extractionSchema: (optional, only when type is "extract") a JSON schema object describing the structure of data to extract
    `;

    const schema = {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['act', 'extract'] },
        instruction: { type: 'string' },
        reasoning: { type: 'string' },
        isGoalComplete: { type: 'boolean' },
        extractionSchema: { type: 'object' },
      },
      required: ['type', 'instruction', 'reasoning', 'isGoalComplete'],
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
