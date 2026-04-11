import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { LLMProvider, SchemaInput } from '../utils/llm-provider.js';
import { z } from 'zod';

const MAX_PAGE_TEXT_CHARS = 8000;

export class ExtractionEngine {
  constructor(
    private page: Page,
    private stateParser: StateParser,
    private gemini: LLMProvider
  ) {}

  async extract<T>(instruction: string, schema: SchemaInput<T>): Promise<T> {
    // Run AOM parse and innerText capture in parallel
    const [aomState, pageText] = await Promise.all([
      this.stateParser.parse(),
      this.getPageText(),
    ]);

    const prompt = `
      Extract structured data from a web page according to the instruction: "${instruction}"
      
      Page URL: ${aomState.url}
      Page Title: ${aomState.title}
      
      --- INTERACTIVE ELEMENTS (AOM, id | role | name | region) ---
      ${aomState.elements.map(e => `${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}${e.value !== undefined ? ` | value="${e.value}"` : ''}`).join('\n')}
      
      --- VISIBLE PAGE TEXT ---
      ${pageText}
      
      Return ONLY the requested JSON. Do not include explanations.
    `;

    return await this.gemini.generateStructuredData<T>(prompt, schema);
  }

  private async getPageText(): Promise<string> {
    try {
      const text: string = await this.page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, svg, [aria-hidden="true"]').forEach(el => el.remove());
        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
      });
      return text.length > MAX_PAGE_TEXT_CHARS
        ? text.slice(0, MAX_PAGE_TEXT_CHARS) + '... [truncated]'
        : text;
    } catch {
      return '[Could not extract page text]';
    }
  }
}
