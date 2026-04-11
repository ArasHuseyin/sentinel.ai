import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';

export interface ObserveResult {
  description: string;
  selector?: string;
  method?: 'click' | 'fill' | 'hover' | 'select' | 'check' | 'press';
  arguments?: string[];
}

export class ObservationEngine {
  constructor(
    private page: Page,
    private stateParser: StateParser,
    private gemini: LLMProvider
  ) {}

  async observe(instruction?: string): Promise<ObserveResult[]> {
    const fullState = await this.stateParser.parse();

    const focusHint = instruction
      ? `Focus specifically on: "${instruction}"`
      : 'List all possible interactions a user can take on this page.';

    const prompt = `
      You are a web observation agent analyzing interactive elements on a page.
      ${focusHint}

      URL: ${fullState.url}
      Title: ${fullState.title}

      Interactive Elements (AOM, id | role | name | region):
      ${fullState.elements.map(e => `${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}${e.value !== undefined ? ` | value="${e.value}"` : ''}`).join('\n')}

      Return a list of possible actions. For each action provide:
      - description: what the action does (human-readable)
      - selector: CSS or role-based selector if determinable (optional)
      - method: the interaction method (click, fill, hover, select, check, press)
      - arguments: any arguments needed (e.g. text to fill) (optional)
    `;

    const schema = {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              selector: { type: 'string' },
              method: { type: 'string', enum: ['click', 'fill', 'hover', 'select', 'check', 'press'] },
              arguments: { type: 'array', items: { type: 'string' } },
            },
            required: ['description', 'method'],
          },
        },
      },
      required: ['actions'],
    };

    const result = await this.gemini.generateStructuredData<{ actions: ObserveResult[] }>(prompt, schema);
    return result.actions;
  }
}
