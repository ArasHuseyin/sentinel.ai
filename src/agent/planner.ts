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
- Interactive elements, sorted top-to-bottom:
${(() => {
  const sorted = filterRelevantElements(state.elements, goal, 50).slice().sort((a, b) => a.boundingClientRect.y - b.boundingClientRect.y);
  const FORM_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'listbox', 'radio', 'checkbox', 'slider', 'switch', 'datepicker', 'timepicker']);
  const formFields = sorted.filter(e => FORM_ROLES.has(e.role));
  const others = sorted.filter(e => !FORM_ROLES.has(e.role));
  const fmtEl = (e: typeof sorted[0], prefix = '') => `${prefix}${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}${e.value !== undefined ? ` | value="${e.value}"` : ''}${e.error ? ` | ⚠ "${e.error}"` : ''}`;
  const fmt = (e: typeof sorted[0]) => fmtEl(e);
  const sections: string[] = [];
  if (formFields.length > 0) {
    // Mark the first UNFILLED form field as the next target.
    // Fields with values are already filled — skip them for the >> marker.
    // A field is "unfilled" if it has no value or its value matches a placeholder pattern.
    const isUnfilled = (e: typeof formFields[0]) =>
      e.value === undefined || e.value === '' ||
      /auswählen|select|choose|bitte|please|suchen|search/i.test(e.value);
    const firstUnfilledIdx = formFields.findIndex(isUnfilled);
    const fieldLines = formFields.map((e) => {
      return isUnfilled(e) ? fmtEl(e, '○ ') : fmtEl(e, '● ');
    });
    sections.push(`Form fields (● = filled, ○ = empty — fill empty fields relevant to the goal, skip irrelevant ones):\n${fieldLines.join('\n')}`);
    // When form fields exist, only show buttons NEAR the form (likely submit/proceed).
    // Buttons far above or far below the form area are hidden to prevent the LLM
    // from clicking irrelevant navigation buttons instead of filling the form.
    // This is position-based, not language-based — works on any website.
    const minFormY = formFields[0]!.boundingClientRect.y;
    const maxFormY = Math.max(...formFields.map(e => e.boundingClientRect.y + e.boundingClientRect.height));
    const formHeight = maxFormY - minFormY;
    const margin = Math.max(formHeight, 300);
    const nearbyButtons = others.filter(e => {
      const btnY = e.boundingClientRect.y;
      return btnY >= minFormY - 50 && btnY <= maxFormY + margin;
    });
    if (nearbyButtons.length > 0) sections.push(`Nearby buttons:\n${nearbyButtons.map(fmt).join('\n')}`);
  } else {
    if (others.length > 0) sections.push(`Interactive elements:\n${others.map(fmt).join('\n')}`);
  }
  return sections.join('\n\n');
})()}

Steps taken so far:
${memory.getSummary()}

Rules:
- If the current URL already matches the goal topic (e.g. you're on an insurance page and the goal is insurance), you are already on the right page — do NOT click navigation links. Instead, interact with the form/content directly.
- If form fields are listed in the "Form fields" section above, fill the ones relevant to the goal BEFORE clicking any buttons. Fill top-to-bottom, one at a time. Skip optional or irrelevant fields.
- Buttons that display a current value (like a brand name, category, or date) next to a label are dropdown selectors — click them to open the dropdown and change the value.
- Many forms are multi-step: after filling all visible fields, click the submit/next/proceed button to advance. The remaining fields will appear on the next page.
- Never type URLs into search fields. You are already on the correct page — use the search and form fields for their intended purpose.
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
