import { jest, describe, it, expect } from '@jest/globals';
import { Verifier } from '../reliability/verifier.js';
import type { SimplifiedState } from '../core/state-parser.js';
import type { LLMProvider } from '../utils/llm-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<SimplifiedState> = {}): SimplifiedState {
  return {
    url: 'https://example.com',
    title: 'Example',
    elements: [],
    ...overrides,
  };
}

function makeMockLLM(response: { success: boolean; confidence: number; explanation: string }): LLMProvider {
  return {
    generateStructuredData: jest.fn(async () => response) as any,
    generateText: jest.fn(async () => ''),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Verifier', () => {
  it('auto-succeeds when URL changes (fast path)', async () => {
    const llm = makeMockLLM({ success: false, confidence: 0, explanation: 'should not be called' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const before = makeState({ url: 'https://example.com/login' });
    const after = makeState({ url: 'https://example.com/dashboard' });

    const result = await verifier.verifyAction('Click login button', before, after);

    expect(result.success).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(llm.generateStructuredData).not.toHaveBeenCalled();
  });

  it('calls LLM when URL stays the same', async () => {
    const llm = makeMockLLM({ success: true, confidence: 0.85, explanation: 'Form was submitted' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const before = makeState({ elements: [] });
    const after = makeState({ elements: [{ id: 0, role: 'alert', name: 'Success!', boundingClientRect: { x: 0, y: 0, width: 100, height: 30 } }] });

    const result = await verifier.verifyAction('Submit form', before, after);

    expect(llm.generateStructuredData).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.confidence).toBe(0.85);
    expect(result.message).toBe('Form was submitted');
  });

  it('returns failure when LLM says action failed', async () => {
    const llm = makeMockLLM({ success: false, confidence: 0.3, explanation: 'Nothing changed' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const state = makeState();
    const result = await verifier.verifyAction('Click invisible button', state, state);

    expect(result.success).toBe(false);
    expect(result.confidence).toBe(0.3);
  });

  it('always sets done: true', async () => {
    const llm = makeMockLLM({ success: true, confidence: 0.9, explanation: 'OK' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const state = makeState();
    const result = await verifier.verifyAction('Any action', state, state);

    expect(result.done).toBe(true);
  });

  it('passes action description and page context to LLM prompt', async () => {
    // Use identical states (same URL, title, elements) so all fast paths are skipped
    // and the LLM slow path is reached.
    const llm = makeMockLLM({ success: true, confidence: 0.8, explanation: 'Done' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const sameState = makeState({ url: 'https://example.com', title: 'Stable Page' });

    await verifier.verifyAction('Fill in email', sameState, sameState);

    expect(llm.generateStructuredData).toHaveBeenCalledTimes(1);
    const promptArg = ((llm.generateStructuredData as jest.Mock).mock.calls[0] as any[])[0] as string;
    expect(promptArg).toContain('Fill in email');
    expect(promptArg).toContain('Stable Page');
  });

  // ─── New fast paths ────────────────────────────────────────────────────────

  it('auto-succeeds when page title changes (fast path)', async () => {
    const llm = makeMockLLM({ success: false, confidence: 0, explanation: 'should not be called' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const before = makeState({ title: 'Home' });
    const after = makeState({ title: 'Dashboard' });

    const result = await verifier.verifyAction('Click Dashboard link', before, after);

    expect(result.success).toBe(true);
    expect(result.confidence).toBe(0.90);
    expect(llm.generateStructuredData).not.toHaveBeenCalled();
  });

  it('auto-succeeds when element count increases by more than 3 (fast path)', async () => {
    const makeElements = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: i,
        role: 'button',
        name: `El ${i}`,
        boundingClientRect: { x: 0, y: 0, width: 10, height: 10 },
      }));

    const llm = makeMockLLM({ success: false, confidence: 0, explanation: 'should not be called' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const before = makeState({ elements: makeElements(3) });
    const after  = makeState({ elements: makeElements(8) }); // delta = 5 > 3

    const result = await verifier.verifyAction('Open dropdown', before, after);

    expect(result.success).toBe(true);
    expect(result.confidence).toBe(0.88);
    expect(llm.generateStructuredData).not.toHaveBeenCalled();
  });

  it('auto-succeeds when element count decreases by more than 3 (fast path)', async () => {
    const makeElements = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: i,
        role: 'button',
        name: `El ${i}`,
        boundingClientRect: { x: 0, y: 0, width: 10, height: 10 },
      }));

    const llm = makeMockLLM({ success: false, confidence: 0, explanation: 'should not be called' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const before = makeState({ elements: makeElements(8) });
    const after  = makeState({ elements: makeElements(3) }); // delta = 5 > 3

    const result = await verifier.verifyAction('Close modal', before, after);

    expect(result.success).toBe(true);
    expect(result.confidence).toBe(0.88);
    expect(llm.generateStructuredData).not.toHaveBeenCalled();
  });

  it('falls through to LLM when element delta is exactly 3 (not >3)', async () => {
    const makeElements = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: i,
        role: 'button',
        name: `El ${i}`,
        boundingClientRect: { x: 0, y: 0, width: 10, height: 10 },
      }));

    const llm = makeMockLLM({ success: true, confidence: 0.75, explanation: 'OK' });
    const verifier = new Verifier({} as any, {} as any, llm);

    const before = makeState({ elements: makeElements(5) });
    const after  = makeState({ elements: makeElements(8) }); // delta = 3, not > 3

    await verifier.verifyAction('Minor change', before, after);

    expect(llm.generateStructuredData).toHaveBeenCalledTimes(1);
  });

  it('returns unverified success (confidence 0.5) when LLM throws', async () => {
    const llm: LLMProvider = {
      generateStructuredData: jest.fn(async () => { throw new Error('Rate limit 429'); }) as any,
      generateText: jest.fn(async () => ''),
    };
    const verifier = new Verifier({} as any, {} as any, llm);

    const state = makeState();
    const result = await verifier.verifyAction('Click button', state, state);

    expect(result.success).toBe(true);
    expect(result.confidence).toBe(0.5);
    expect(result.message).toContain('Unverified');
  });

  it('does not throw when LLM throws — act() loop stays alive', async () => {
    const llm: LLMProvider = {
      generateStructuredData: jest.fn(async () => { throw new Error('Network error'); }) as any,
      generateText: jest.fn(async () => ''),
    };
    const verifier = new Verifier({} as any, {} as any, llm);

    const state = makeState();
    // Must resolve, not reject
    await expect(verifier.verifyAction('Click anything', state, state)).resolves.toBeDefined();
  });
});
