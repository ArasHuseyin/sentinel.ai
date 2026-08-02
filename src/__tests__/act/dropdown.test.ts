import { jest, describe, it, expect, afterEach } from '@jest/globals';
import {
  clickBestMatchingOption,
  isListboxPopoverVisible,
  trySetNativeSelectValue,
} from '../../api/act/dropdown.js';

// ─── DOM stub ─────────────────────────────────────────────────────────────────
//
// The interesting logic in dropdown.ts (option scoring, wrapper drill-down,
// visibility filtering) lives inside page.evaluate callbacks. Those callbacks
// are ordinary functions, so we run them against a minimal DOM stub in Node
// rather than booting a browser — the alternative is leaving the module at
// ~5% coverage, which is what it was.

interface StubElementInit {
  role?: string;
  text?: string;
  ariaLabel?: string;
  ariaHidden?: boolean;
  ariaDisabled?: boolean;
  /** Zero-size elements are treated as not interactable. */
  size?: { width: number; height: number };
  /** null models a display:none ancestor. */
  offsetParent?: object | null;
  tag?: string;
  children?: StubElement[];
  /** Extra raw attributes, e.g. { href: '/sort?rating' }. */
  attrs?: Record<string, string>;
}

class StubElement {
  clicked = false;
  role: string | undefined;
  textContent: string;
  tag: string;
  children: StubElement[];
  private attrs: Record<string, string | undefined>;
  private size: { width: number; height: number };
  offsetParent: object | null;

  constructor(init: StubElementInit = {}) {
    this.role = init.role;
    this.textContent = init.text ?? '';
    this.tag = init.tag ?? 'div';
    this.children = init.children ?? [];
    this.size = init.size ?? { width: 100, height: 20 };
    this.offsetParent = init.offsetParent === undefined ? {} : init.offsetParent;
    this.attrs = {
      ...(init.role ? { role: init.role } : {}),
      ...(init.ariaLabel ? { 'aria-label': init.ariaLabel } : {}),
      ...(init.ariaHidden ? { 'aria-hidden': 'true' } : {}),
      ...(init.ariaDisabled ? { 'aria-disabled': 'true' } : {}),
      ...(init.attrs ?? {}),
    };
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  getBoundingClientRect() {
    return { width: this.size.width, height: this.size.height, x: 0, y: 0 };
  }

  /**
   * Supports only the selector shapes dropdown.ts actually passes: a bare tag
   * (`a`), a tag with an attribute predicate (`a[href]`), or a standalone
   * attribute predicate (`[role="option"]`, `[onclick]`).
   */
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (!s) return false;

      const attrMatch = /^([a-z]*)\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(s);
      if (attrMatch) {
        const [, tag, attr, expected] = attrMatch;
        if (tag && tag !== this.tag) return false;
        const actual = this.getAttribute(attr!);
        if (actual === null) return false;
        return expected === undefined || actual === expected;
      }
      return s === this.tag;
    });
  }

  querySelector(selector: string): StubElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
    }
    return null;
  }

  click(): void {
    this.clicked = true;
  }
}

function installDom(elements: { explicitOptions?: StubElement[]; structural?: StubElement[] }) {
  const original = (globalThis as any).document;
  (globalThis as any).document = {
    querySelectorAll: (selector: string) => {
      if (selector === '[role="option"]') return elements.explicitOptions ?? [];
      if (selector.includes('[role="listbox"]')) return elements.structural ?? [];
      return [];
    },
    elementFromPoint: () => null,
  };
  return () => {
    (globalThis as any).document = original;
  };
}

/** page mock that actually executes the browser-side callback. */
const evaluatingPage = () => ({
  evaluate: jest.fn(async (fn: any, arg: any) => fn(arg)),
});

let restoreDom: (() => void) | undefined;
afterEach(() => {
  restoreDom?.();
  restoreDom = undefined;
});

const option = (text: string, extra: StubElementInit = {}) =>
  new StubElement({ role: 'option', text, ...extra });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('clickBestMatchingOption', () => {
  it('returns false for an empty value without touching the page', async () => {
    const page = evaluatingPage();
    await expect(clickBestMatchingOption(page as any, '')).resolves.toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('clicks the exact match over a merely-containing option', async () => {
    const exact = option('Rating');
    const longer = option('Rating: high to low');
    restoreDom = installDom({ explicitOptions: [longer, exact] });

    await expect(clickBestMatchingOption(evaluatingPage() as any, 'Rating')).resolves.toBe(true);
    expect(exact.clicked).toBe(true);
    expect(longer.clicked).toBe(false);
  });

  it('matches case- and punctuation-insensitively', async () => {
    const target = option('Preis: aufsteigend');
    restoreDom = installDom({ explicitOptions: [target] });

    await expect(
      clickBestMatchingOption(evaluatingPage() as any, 'preis aufsteigend')
    ).resolves.toBe(true);
    expect(target.clicked).toBe(true);
  });

  it('matches an abbreviated option against a longer requested value', async () => {
    // Amazon-style: the LLM asks for "Avg. Customer Review" but the option
    // text is the shorter "Customer Review".
    const target = option('Customer Review');
    restoreDom = installDom({ explicitOptions: [target] });

    await expect(
      clickBestMatchingOption(evaluatingPage() as any, 'Avg. Customer Review')
    ).resolves.toBe(true);
    expect(target.clicked).toBe(true);
  });

  it('prefers aria-label over textContent when both are present', async () => {
    const labelled = option('★★★★☆', { ariaLabel: 'Four stars and up' });
    restoreDom = installDom({ explicitOptions: [labelled] });

    await expect(
      clickBestMatchingOption(evaluatingPage() as any, 'Four stars and up')
    ).resolves.toBe(true);
    expect(labelled.clicked).toBe(true);
  });

  it('skips aria-hidden, aria-disabled and zero-size options', async () => {
    const hidden = option('Rating', { ariaHidden: true });
    const disabled = option('Rating', { ariaDisabled: true });
    const collapsed = option('Rating', { size: { width: 0, height: 0 } });
    const real = option('Rating');
    restoreDom = installDom({ explicitOptions: [hidden, disabled, collapsed, real] });

    await expect(clickBestMatchingOption(evaluatingPage() as any, 'Rating')).resolves.toBe(true);
    expect(real.clicked).toBe(true);
    expect(hidden.clicked).toBe(false);
    expect(disabled.clicked).toBe(false);
    expect(collapsed.clicked).toBe(false);
  });

  it('returns false when nothing scores above the threshold', async () => {
    restoreDom = installDom({ explicitOptions: [option('Bananas'), option('Oranges')] });

    await expect(clickBestMatchingOption(evaluatingPage() as any, 'Sort by rating')).resolves.toBe(
      false
    );
  });

  it('falls back to the structural pool only when no explicit option exists', async () => {
    const structural = new StubElement({ text: 'Rating', tag: 'li' });
    restoreDom = installDom({ explicitOptions: [], structural: [structural] });

    await expect(clickBestMatchingOption(evaluatingPage() as any, 'Rating')).resolves.toBe(true);
    expect(structural.clicked).toBe(true);
  });

  it('drills into the inner anchor of a wrapper instead of clicking the wrapper', async () => {
    // The regression this guards: synthetic .click() does not bubble down, so
    // clicking an <li> wrapper never reaches the handler bound to the inner
    // <a>, and the selection silently no-ops.
    const inner = new StubElement({ tag: 'a', text: 'Rating', attrs: { href: '/sort?by=rating' } });
    const wrapper = new StubElement({ tag: 'li', text: 'Rating', children: [inner] });
    restoreDom = installDom({ explicitOptions: [], structural: [wrapper] });

    await expect(clickBestMatchingOption(evaluatingPage() as any, 'Rating')).resolves.toBe(true);
    expect(inner.clicked).toBe(true);
    expect(wrapper.clicked).toBe(false);
  });

  it('clicks a matched [role="option"] directly without drilling further', async () => {
    const inner = new StubElement({ tag: 'a', text: 'inner' });
    const opt = option('Rating', { children: [inner] });
    restoreDom = installDom({ explicitOptions: [opt] });

    await expect(clickBestMatchingOption(evaluatingPage() as any, 'Rating')).resolves.toBe(true);
    expect(opt.clicked).toBe(true);
    expect(inner.clicked).toBe(false);
  });

  it('resolves false instead of throwing when evaluate rejects', async () => {
    const page = {
      evaluate: jest.fn(async () => {
        throw new Error('context destroyed');
      }),
    };
    await expect(clickBestMatchingOption(page as any, 'Rating')).resolves.toBe(false);
  });
});

describe('isListboxPopoverVisible', () => {
  it('is true when a laid-out option is present', async () => {
    restoreDom = installDom({ explicitOptions: [option('Rating')] });
    await expect(isListboxPopoverVisible(evaluatingPage() as any)).resolves.toBe(true);
  });

  it('is false when every option is hidden, detached or zero-size', async () => {
    restoreDom = installDom({
      explicitOptions: [
        option('a', { ariaHidden: true }),
        option('b', { offsetParent: null }),
        option('c', { size: { width: 0, height: 0 } }),
      ],
    });
    await expect(isListboxPopoverVisible(evaluatingPage() as any)).resolves.toBe(false);
  });

  it('is false when no options exist at all', async () => {
    restoreDom = installDom({ explicitOptions: [] });
    await expect(isListboxPopoverVisible(evaluatingPage() as any)).resolves.toBe(false);
  });

  it('coerces a non-boolean evaluate result to false', async () => {
    // A mock or an odd serialization must never be read as "popover is open" —
    // that would skip the open-click and leave the dropdown shut.
    const page = { evaluate: jest.fn(async () => 'yes' as unknown) };
    await expect(isListboxPopoverVisible(page as any)).resolves.toBe(false);
  });

  it('is false when evaluate rejects', async () => {
    const page = {
      evaluate: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    await expect(isListboxPopoverVisible(page as any)).resolves.toBe(false);
  });
});

describe('trySetNativeSelectValue', () => {
  it('returns false when no element is under the click point', async () => {
    restoreDom = installDom({});
    await expect(trySetNativeSelectValue(evaluatingPage() as any, 10, 10, 'Rating')).resolves.toBe(
      false
    );
  });

  it('resolves false instead of throwing when evaluate rejects', async () => {
    const page = {
      evaluate: jest.fn(async () => {
        throw new Error('detached');
      }),
    };
    await expect(trySetNativeSelectValue(page as any, 1, 1, 'x')).resolves.toBe(false);
  });
});
