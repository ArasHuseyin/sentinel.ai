import type { Page } from 'playwright';
import { StateParser } from '../core/state-parser.js';
import type { LLMProvider, SchemaInput } from '../utils/llm-provider.js';
import { filterRelevantElements } from './act.js';
import { z } from 'zod';

const MAX_PAGE_TEXT_CHARS = 8000;

/**
 * Minimum string length to validate against the page corpus. Short strings
 * (1-4 chars) are noise-prone — "15", "EN", "de" can legitimately appear on
 * any page unrelated to the instruction — so they don't count for/against
 * the grounding score.
 */
const GROUNDING_MIN_STRING_LEN = 5;

/**
 * Minimum number of extracted strings before we trust the grounding ratio.
 * Below this count the denominator is too small for a reliable signal.
 */
const GROUNDING_MIN_STRING_COUNT = 3;

/**
 * Fraction of extracted strings that must appear in the page corpus for
 * the response to be treated as grounded. 0.3 means: at least 30 % of
 * scoreable strings must be traceable to page text or AOM element names.
 * Below that the result is almost certainly fabricated from prior knowledge.
 */
const GROUNDING_MIN_MATCH_RATIO = 0.3;

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

STRICT GROUNDING RULES — these override everything else:
1. Every value you emit MUST be traceable to specific content in the supplied AOM elements or visible page text. Never draw on prior knowledge, training data, or general assumptions about the site or topic.
2. If the page clearly does NOT contain the requested data (redirected homepage, empty results, login wall, error page, mismatched URL), return the schema shape with null / empty string / empty array values — whichever the schema accepts. Do NOT fabricate plausible-looking data to fill the shape.
3. Before returning any field value, ask yourself: "can I point at the exact substring in the supplied context?" — if not, the value is null or empty.
4. When a list is requested and fewer real matches exist than the instruction asks for, return only the matches you can ground. An instruction for "top 5" on a page with only 2 matching items returns an array of length 2, not 5.

Return ONLY the JSON matching the provided schema — no prose, no explanations, no markdown code fences.`;

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

    const result = await this.gemini.generateStructuredData<T>(prompt, schema, {
      systemInstruction: EXTRACT_SYSTEM_INSTRUCTION,
    });

    // Post-extract grounding filter: if none of the string values in the
    // returned object appear in the page text or AOM element names, Gemini
    // hallucinated (seen on redirected/homepage CodePen, Amazon fallback etc.).
    // This is a last line of defense after the prompt-level STRICT GROUNDING
    // rules — Gemini sometimes ignores anti-hallucination instructions when
    // the schema strongly suggests a non-empty shape.
    return groundingFilter(result, pageText, filteredElements);
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

// ─── Post-extract grounding filter ────────────────────────────────────────────

/**
 * Walks an extracted result and collects every string leaf. Used by the
 * grounding filter to score how much of the LLM's output is actually present
 * in the page corpus.
 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

/**
 * Returns the same-shape value with all leaf strings blanked, arrays emptied,
 * and numbers/booleans zeroed. Used when a result is detected as ungrounded —
 * we preserve the expected schema shape (so zod/JSON-schema validation
 * downstream doesn't crash) while signalling "nothing extracted".
 */
function emptyLike<T>(value: T): T {
  if (Array.isArray(value)) return [] as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v)) out[k] = [];
      else if (typeof v === 'string') out[k] = '';
      else if (typeof v === 'number') out[k] = 0;
      else if (typeof v === 'boolean') out[k] = false;
      else if (v === null || v === undefined) out[k] = null;
      else out[k] = emptyLike(v);
    }
    return out as T;
  }
  return value;
}

type ExtractElement = { role: string; name: string; value?: string };

/**
 * Deterministic grounding check. Counts how many scoreable strings from the
 * LLM's response can be located (as case-insensitive substrings) in the page
 * text or the AOM element names/values the LLM was given. If fewer than
 * `GROUNDING_MIN_MATCH_RATIO` of scoreable strings match AND there are at
 * least `GROUNDING_MIN_STRING_COUNT` of them, the response is treated as
 * hallucinated and replaced with an empty-shape equivalent.
 *
 * This fires AFTER the LLM has run, so it's a safety net — the prompt-level
 * grounding rules handle the cooperative case, this handles the case where
 * Gemini ignores those rules.
 */
function groundingFilter<T>(result: T, pageText: string, elements: ExtractElement[]): T {
  const strings: string[] = [];
  collectStrings(result, strings);

  const corpus = [
    pageText,
    ...elements.map(e => `${e.name} ${e.value ?? ''}`),
  ].join(' ').toLowerCase();

  let scoreable = 0;
  let matches = 0;
  for (const raw of strings) {
    const s = raw.trim().toLowerCase();
    if (s.length < GROUNDING_MIN_STRING_LEN) continue;
    scoreable++;
    // Match on first 40 chars — enough to catch verbatim content while
    // tolerating punctuation/whitespace normalization differences between
    // what the LLM emitted and what innerText returned.
    const probe = s.slice(0, Math.min(40, s.length));
    if (corpus.includes(probe)) matches++;
  }

  if (scoreable >= GROUNDING_MIN_STRING_COUNT) {
    const ratio = matches / scoreable;
    if (ratio < GROUNDING_MIN_MATCH_RATIO) {
      console.warn(
        `[Extract] Ungrounded response filtered: ${matches}/${scoreable} strings found in page corpus (ratio ${ratio.toFixed(2)} < ${GROUNDING_MIN_MATCH_RATIO}). Returning empty-shape.`
      );
      return emptyLike(result);
    }
  }

  return result;
}

