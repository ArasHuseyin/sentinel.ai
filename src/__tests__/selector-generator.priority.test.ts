import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { generateSelector } from '../core/selector-generator.js';
import type { UIElement } from '../core/state-parser.js';

// ─── DOM stub ─────────────────────────────────────────────────────────────────
//
// generateSelector's strategy ladder (test-id → id → name → placeholder →
// aria-label → role+text → tag+text, walking up ancestors) runs inside a
// page.evaluate callback. Executing that callback against a stub is the only
// way to assert the ordering without a live browser; the module sat at ~23%
// coverage with the ladder itself untested.

class StubEl {
  attrs: Record<string, string>;
  tagName: string;
  textContent: string;
  parentElement: StubEl | null = null;

  constructor(tag: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.textContent = text;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  withParent(parent: StubEl): this {
    this.parentElement = parent;
    return this;
  }
}

const BODY = new StubEl('body');

function installDom(hit: StubEl | null, scroll = { x: 0, y: 0 }) {
  const original = {
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    CSS: (globalThis as any).CSS,
  };

  const pointCalls: Array<{ x: number; y: number }> = [];
  (globalThis as any).document = {
    body: BODY,
    elementFromPoint: (x: number, y: number) => {
      pointCalls.push({ x, y });
      return hit;
    },
  };
  (globalThis as any).window = { scrollX: scroll.x, scrollY: scroll.y };
  // Minimal CSS.escape — enough for the identifiers these tests use.
  (globalThis as any).CSS = {
    escape: (s: string) => s.replace(/([ !"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, '\\$1'),
  };

  return {
    pointCalls,
    restore(): void {
      (globalThis as any).document = original.document;
      (globalThis as any).window = original.window;
      (globalThis as any).CSS = original.CSS;
    },
  };
}

const evaluatingPage = () => ({ evaluate: jest.fn(async (fn: any, arg: any) => fn(arg)) });

function target(overrides: Partial<UIElement> = {}): UIElement {
  return {
    id: 1,
    role: 'button',
    name: 'Submit',
    boundingClientRect: { x: 100, y: 200, width: 80, height: 40 },
    ...overrides,
  } as UIElement;
}

let dom: ReturnType<typeof installDom> | undefined;
afterEach(() => {
  dom?.restore();
  dom = undefined;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateSelector', () => {
  it('probes the centroid converted from document space to viewport space', async () => {
    // The AOM reports document-space coordinates, elementFromPoint takes
    // viewport-space. Getting this wrong silently probes the wrong element on
    // any scrolled page.
    dom = installDom(new StubEl('button', { 'data-testid': 'go' }, 'Go'), { x: 15, y: 300 });
    await generateSelector(evaluatingPage() as any, target());

    // centroid = (100 + 80/2, 200 + 40/2) = (140, 220); minus scroll → (125, -80)
    expect(dom.pointCalls[0]).toEqual({ x: 125, y: -80 });
  });

  it('prefers a testing attribute above everything else', async () => {
    const el = new StubEl(
      'button',
      { 'data-testid': 'checkout', id: 'checkout-btn', 'aria-label': 'Checkout' },
      'Checkout'
    );
    dom = installDom(el);
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      '[data-testid="checkout"]'
    );
  });

  it('falls back to a stable id when no testing attribute exists', async () => {
    dom = installDom(new StubEl('button', { id: 'submit-order' }, 'Order'));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      '#submit-order'
    );
  });

  it.each([
    ['a UUID', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
    ['a long hex hash', 'a1b2c3d4e5f6a7b8'],
    ['a digit-leading id', '123-panel'],
  ])('skips %s and keeps walking the ladder', async (_label, id) => {
    // Auto-generated ids change on every render; selecting on them produces a
    // cache entry that breaks on the next deploy.
    dom = installDom(new StubEl('button', { id, 'aria-label': 'StableLabel' }, 'x'));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      '[aria-label="StableLabel"]'
    );
  });

  it('uses name on form controls', async () => {
    dom = installDom(new StubEl('input', { name: 'email' }));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      'input[name="email"]'
    );
  });

  it('uses type + placeholder for unnamed text inputs', async () => {
    dom = installDom(new StubEl('input', { type: 'text', placeholder: 'Search products' }));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      'input[type="text"][placeholder="Search\\ products"]'
    );
  });

  it('uses type alone for non-text inputs without a placeholder', async () => {
    dom = installDom(new StubEl('input', { type: 'checkbox' }));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      'input[type="checkbox"]'
    );
  });

  it('combines role and text when only those are available', async () => {
    dom = installDom(new StubEl('div', { role: 'tab' }, '  Reviews  '));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      '[role="tab"]:has-text("Reviews")'
    );
  });

  it('escapes double quotes in has-text values', async () => {
    dom = installDom(new StubEl('button', {}, 'Say "hi"'));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      'button:has-text("Say \\"hi\\"")'
    );
  });

  it('truncates long text to 40 characters', async () => {
    const long = 'x'.repeat(60);
    dom = installDom(new StubEl('a', {}, long));
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      `a:has-text("${'x'.repeat(40)}")`
    );
  });

  it('walks up to an ancestor when the hit element itself has nothing stable', async () => {
    // elementFromPoint lands on the deepest node — typically a <span> inside a
    // <button>. Without the ancestor walk, every icon-in-button click would
    // fail to produce a selector.
    const button = new StubEl('button', { 'data-testid': 'save' }, 'Save');
    const span = new StubEl('span', {}, '').withParent(button);
    dom = installDom(span);

    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBe(
      '[data-testid="save"]'
    );
  });

  it('returns null when nothing in the ancestor chain is selectable', async () => {
    const wrapper = new StubEl('div', {}, '').withParent(BODY);
    const inner = new StubEl('span', {}, '').withParent(wrapper);
    dom = installDom(inner);

    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBeNull();
  });

  it('returns null when nothing is under the point', async () => {
    dom = installDom(null);
    await expect(generateSelector(evaluatingPage() as any, target())).resolves.toBeNull();
  });

  it('returns null instead of throwing when evaluate rejects', async () => {
    const page = {
      evaluate: jest.fn(async () => {
        throw new Error('context destroyed');
      }),
    };
    await expect(generateSelector(page as any, target())).resolves.toBeNull();
  });
});
