import type { UIElement } from '../../core/state-parser.js';

/** Common stop words that should not be used for relevance matching. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'on',
  'in',
  'to',
  'at',
  'of',
  'by',
  'is',
  'it',
  'or',
  'as',
  'do',
  'if',
  'no',
  'up',
  'so',
  'my',
  'we',
  'be',
  'am',
]);

/**
 * Tokenises a string into lowercase words (≥ 2 chars) for relevance scoring.
 * Filters out common stop words that cause false-positive substring matches.
 */
function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
    ),
  ];
}

/** Keywords that identify overlay/blocker elements that should never be filtered out. */
const BLOCKER_KEYWORDS = /cookie|consent|akzeptieren|accept all|datenschutz|privacy|zustimmen/i;

/**
 * Filters `elements` down to at most `maxCount` entries, keeping those whose
 * role+name overlap most with the instruction. When the page has ≤ maxCount
 * elements the list is returned unchanged. Elements with a relevance score of 0
 * fill remaining slots in their original order (stable sort).
 */
export function filterRelevantElements(elements: UIElement[], instruction: string, maxCount: number): UIElement[] {
  if (elements.length <= maxCount) return elements;

  const tokens = tokenize(instruction);
  if (tokens.length === 0) return elements.slice(0, maxCount);

  // Always-keep: form fields, nearby buttons, and cookie/blocker elements.
  // Form fields are the primary interaction targets — dropping them because their
  // label doesn't keyword-match the (possibly different-language) goal is a bug.
  // Buttons near form fields (submit/proceed) must also be kept — they're the
  // natural next action after filling the form.
  const FORM_ROLES = new Set([
    'textbox',
    'combobox',
    'searchbox',
    'spinbutton',
    'listbox',
    'radio',
    'checkbox',
    'slider',
    'switch',
    'datepicker',
    'timepicker',
    'file',
  ]);
  const alwaysKeep: typeof elements = [];
  const rest: typeof elements = [];
  for (const el of elements) {
    if (FORM_ROLES.has(el.role) || ((el.role === 'button' || el.role === 'link') && BLOCKER_KEYWORDS.test(el.name))) {
      alwaysKeep.push(el);
    } else {
      rest.push(el);
    }
  }

  // Also keep buttons/links that are positionally near form fields (submit buttons).
  // Submit buttons are almost always directly below the form — preserving them
  // ensures the LLM can submit after filling, regardless of button label language.
  const formEls = alwaysKeep.filter(e => FORM_ROLES.has(e.role));
  if (formEls.length > 0) {
    const formYs = formEls.map(e => e.boundingClientRect.y);
    const minFormY = Math.min(...formYs);
    const maxFormY = Math.max(...formEls.map(e => e.boundingClientRect.y + e.boundingClientRect.height));
    const margin = Math.max(maxFormY - minFormY, 300);

    for (let i = rest.length - 1; i >= 0; i--) {
      const el = rest[i]!;
      if (
        (el.role === 'button' || el.role === 'link') &&
        el.boundingClientRect.y >= minFormY - 50 &&
        el.boundingClientRect.y <= maxFormY + margin
      ) {
        alwaysKeep.push(el);
        rest.splice(i, 1);
      }
    }
  }

  const scored = rest.map(el => {
    const text = `${el.role} ${el.name}`.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    let score = 0;
    for (const token of tokens) {
      if (text.includes(token)) score++;
    }
    return { el, score };
  });

  // Stable sort: higher score first, original order preserved for ties
  scored.sort((a, b) => b.score - a.score);
  const remaining = maxCount - alwaysKeep.length;
  return [...alwaysKeep, ...scored.slice(0, Math.max(0, remaining)).map(s => s.el)];
}
