import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { LLMProvider, SchemaInput } from '../utils/llm-provider.js';
import { filterRelevantElements } from './act.js';
import { z } from 'zod';

const MAX_PAGE_TEXT_CHARS = 8000;

/**
 * Upper bound on AOM elements embedded in the extraction prompt.
 *
 * On a dense results page (Amazon search, category listings, docs sites)
 * the raw AOM can exceed 300 interactive elements — sending all of them
 * balloons the prompt to 30–40 KB and drives Gemini latency up
 * proportionally, with most of that context being irrelevant to the
 * extraction. 150 leaves room for ~20 product/list items at ~5–6 AOM
 * nodes each (title/price/rating/link/CTA) plus header/nav/form context,
 * while cutting prompt size by ~40–50 % on heavy pages. Pages with fewer
 * elements pass through unchanged (`filterRelevantElements` is a no-op
 * below the cap).
 */
const MAX_AOM_ELEMENTS = 150;

/**
 * Static system prefix for every extract call. Kept byte-for-byte stable
 * across calls so provider prompt caching (Gemini implicit cache,
 * Anthropic `cache_control`, OpenAI automatic cache) can reuse the
 * tokenised prefix. Only format/role guidance lives here — all dynamic
 * content (instruction, URL, AOM list, page text) stays in the user
 * prompt.
 */
const EXTRACT_SYSTEM_INSTRUCTION = `You are a data-extraction assistant for web pages.

For each request you will receive:
- An extraction instruction describing what data to return
- The page URL and title
- A list of interactive elements from the Accessibility Object Model (AOM), one per line in the format: \`id | role | name | region | value="..."\` (region and value are optional)
- The visible text content of the page (may be truncated)

Use both the interactive elements and the visible page text to infer the requested data. Return ONLY the JSON matching the provided schema — no prose, no explanations, no markdown code fences.`;

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

    // Relevance-filter AOM before prompting. Keeps form fields + blocker
    // CTAs unconditionally (same guarantees `act()` relies on), scores
    // the remainder against instruction tokens, and caps at
    // MAX_AOM_ELEMENTS. No-op when the page already has ≤ cap elements.
    const filteredElements = filterRelevantElements(aomState.elements, instruction, MAX_AOM_ELEMENTS);

    const prompt = `Instruction: "${instruction}"

Page URL: ${aomState.url}
Page Title: ${aomState.title}

--- INTERACTIVE ELEMENTS ---
${filteredElements.map(e => `${e.id} | ${e.role} | ${e.name}${e.region ? ` | ${e.region}` : ''}${e.value !== undefined ? ` | value="${e.value}"` : ''}`).join('\n')}

--- VISIBLE PAGE TEXT ---
${pageText}`;

    return await this.gemini.generateStructuredData<T>(prompt, schema, {
      systemInstruction: EXTRACT_SYSTEM_INSTRUCTION,
    });
  }

  /**
   * Captures the page's visible text for the extraction prompt.
   *
   * Uses `document.body.innerText` on the *live* DOM rather than
   * cloning. The browser maintains an internal layout cache for the
   * live tree, so `innerText` returns from that cache when layout is
   * fresh (sub-ms) and triggers at most a single reflow when it isn't.
   * The previous `cloneNode(true) + clone.innerText` path always paid
   * a fresh full-layout cost on the *detached* clone — on large pages
   * like Amazon search results (30–50 MB DOM) that was the dominant
   * extraction cost, 1–3 s per call.
   *
   * Script/style/noscript are excluded naturally — they carry a UA
   * `display:none` rule, so `innerText` already omits them. SVG text
   * and `aria-hidden` decorative labels may leak through as minor
   * noise; the LLM tolerates it and the simplicity beats maintaining
   * a parallel filter list. Truncation happens browser-side so the
   * serialised payload returned to Node stays bounded.
   */
  private async getPageText(): Promise<string> {
    try {
      return await this.page.evaluate((max: number) => {
        const raw = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
        return raw.length > max ? raw.slice(0, max) + '... [truncated]' : raw;
      }, MAX_PAGE_TEXT_CHARS);
    } catch {
      return '[Could not extract page text]';
    }
  }
}
