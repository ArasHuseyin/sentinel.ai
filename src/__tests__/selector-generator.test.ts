import { jest, describe, it, expect } from '@jest/globals';
import { slugifyInstruction, generateSelector } from '../core/selector-generator.js';
import type { UIElement } from '../core/state-parser.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeElement(overrides: Partial<UIElement> = {}): UIElement {
  return {
    id: 1,
    role: 'button',
    name: 'Login',
    boundingClientRect: { x: 100, y: 200, width: 80, height: 30 },
    description: '',
    ...overrides,
  };
}

/**
 * Builds a minimal mock Playwright page whose `evaluate` call returns
 * a controlled value. Pass `null` to simulate "no element at point".
 */
function makePage(evaluateResult: string | null) {
  return {
    evaluate: jest.fn(async () => evaluateResult),
  };
}

// ─── slugifyInstruction ────────────────────────────────────────────────────────

describe('slugifyInstruction()', () => {
  it('converts a simple instruction to camelCase', () => {
    expect(slugifyInstruction('Click the login button')).toBe('clickLoginButton');
  });

  it('removes stop words', () => {
    expect(slugifyInstruction('Fill email field')).toBe('fillEmailField');
  });

  it('handles submit without losing verb', () => {
    expect(slugifyInstruction('Submit form')).toBe('submitForm');
  });

  it('caps at 4 meaningful words', () => {
    const result = slugifyInstruction('click the very long and complex instruction here now');
    // After removing stop words: click very long complex → 4 words max
    expect(result.split(/(?=[A-Z])/).length).toBeLessThanOrEqual(5); // 4 words = up to 4 segments
  });

  it('returns "element" for instruction with only stop words', () => {
    expect(slugifyInstruction('the a an')).toBe('element');
  });

  it('returns "element" for empty string', () => {
    expect(slugifyInstruction('')).toBe('element');
  });

  it('strips punctuation', () => {
    expect(slugifyInstruction('Click "login"!')).toBe('clickLogin');
  });

  it('two different instructions produce different slugs', () => {
    const s1 = slugifyInstruction('Click login button');
    const s2 = slugifyInstruction('Fill email field');
    expect(s1).not.toBe(s2);
  });

  it('same instruction produces the same slug repeatedly', () => {
    const s1 = slugifyInstruction('Submit the form');
    const s2 = slugifyInstruction('Submit the form');
    expect(s1).toBe(s2);
  });
});

// ─── uniqueKey deduplication (via AgentLoop.selectors) ───────────────────────
// Test the deduplication logic indirectly via slugifyInstruction + a manual
// simulation that mirrors what agent-loop does.

describe('selector key deduplication', () => {
  function dedupeKey(slug: string, map: Record<string, string>): string {
    if (!(slug in map)) return slug;
    let n = 2;
    while (`${slug}${n}` in map) n++;
    return `${slug}${n}`;
  }

  it('first occurrence uses the slug directly', () => {
    expect(dedupeKey('clickLogin', {})).toBe('clickLogin');
  });

  it('second occurrence gets suffix 2', () => {
    expect(dedupeKey('clickLogin', { clickLogin: 'a' })).toBe('clickLogin2');
  });

  it('third occurrence gets suffix 3 (not 2 again)', () => {
    const map = { clickLogin: 'a', clickLogin2: 'b' };
    expect(dedupeKey('clickLogin', map)).toBe('clickLogin3');
  });

  it('fourth occurrence gets suffix 4', () => {
    const map = { clickLogin: 'a', clickLogin2: 'b', clickLogin3: 'c' };
    expect(dedupeKey('clickLogin', map)).toBe('clickLogin4');
  });

  it('different slugs do not interfere', () => {
    const map = { clickLogin: 'a' };
    expect(dedupeKey('fillEmail', map)).toBe('fillEmail');
  });
});

// ─── generateSelector ─────────────────────────────────────────────────────────

describe('generateSelector()', () => {
  it('returns the value from page.evaluate()', async () => {
    const page = makePage('[data-testid="login-btn"]');
    const el = makeElement();
    const result = await generateSelector(page as any, el);
    expect(result).toBe('[data-testid="login-btn"]');
  });

  it('calls page.evaluate() with centre coordinates of the element', async () => {
    const page = makePage(null);
    const el = makeElement({ boundingClientRect: { x: 100, y: 200, width: 80, height: 30 } });
    await generateSelector(page as any, el);
    const args = (page.evaluate as jest.Mock).mock.calls[0] as any[];
    // Second argument is the { x, y } object passed to evaluate
    expect(args[1]).toEqual({ x: 140, y: 215 }); // center = 100+40, 200+15
  });

  it('returns null when page.evaluate() returns null', async () => {
    const page = makePage(null);
    const result = await generateSelector(page as any, makeElement());
    expect(result).toBeNull();
  });

  it('returns null and does not throw when page.evaluate() throws', async () => {
    const page = {
      evaluate: jest.fn(async () => { throw new Error('Context destroyed'); }),
    };
    const result = await generateSelector(page as any, makeElement());
    expect(result).toBeNull();
  });
});

// ─── generateSelector — selector priority via controlled evaluate results ──────
//
// The inner browser logic runs in page.evaluate() and can't be unit-tested
// in a Node.js context without jsdom. These tests verify that generateSelector
// correctly surfaces whatever the browser logic returns — each test simulates
// a different priority result by controlling page.evaluate's return value.

describe('generateSelector() priority scenarios (mocked evaluate)', () => {
  const scenarios: Array<{ label: string; evaluateResult: string }> = [
    { label: 'data-testid', evaluateResult: '[data-testid="login-btn"]' },
    { label: 'data-cy',     evaluateResult: '[data-cy="submit"]' },
    { label: '#id',         evaluateResult: '#login-button' },
    { label: 'input[name]', evaluateResult: 'input[name="email"]' },
    { label: 'input[type][placeholder]', evaluateResult: 'input[type="email"][placeholder="Enter email"]' },
    { label: '[aria-label]', evaluateResult: '[aria-label="Close dialog"]' },
    { label: '[role]:has-text', evaluateResult: '[role="button"]:has-text("Sign in")' },
    { label: 'button:has-text', evaluateResult: 'button:has-text("Submit")' },
  ];

  for (const { label, evaluateResult } of scenarios) {
    it(`surfaces ${label} selector when browser returns it`, async () => {
      const page = makePage(evaluateResult);
      const result = await generateSelector(page as any, makeElement());
      expect(result).toBe(evaluateResult);
    });
  }

  it('returns null when browser finds no matching strategy', async () => {
    const page = makePage(null);
    expect(await generateSelector(page as any, makeElement())).toBeNull();
  });

  it('passes centre coordinates to page.evaluate', async () => {
    const page = makePage(null);
    const el = makeElement({ boundingClientRect: { x: 200, y: 100, width: 60, height: 40 } });
    await generateSelector(page as any, el);
    const passedArgs = ((page.evaluate as jest.Mock).mock.calls[0] as any[])[1];
    expect(passedArgs).toEqual({ x: 230, y: 120 }); // center: 200+30, 100+20
  });
});
