/**
 * Drift-check: `pattern-signature-browser.ts` duplicates the logic of
 * `pattern-signature.ts` because Playwright's `page.evaluate` can't ship
 * closure references. Any divergence between the two implementations
 * would silently corrupt the pattern cache (Node-side lookup computes
 * one hash, browser-side populates another — eternal misses).
 *
 * This test fails the build on any drift: both implementations are run
 * against the same synthetic-DOM fixtures and their outputs compared
 * byte-for-byte.
 */
import { describe, it, expect } from '@jest/globals';
import { computeFingerprint, type PatternFingerprint } from '../core/pattern-signature.js';
import { computeFingerprintsBrowserSide } from '../core/pattern-signature-browser.js';

// ─── Minimal DOM mock (mirrors pattern-signature.test.ts) ───────────────────

type ElSpec = {
  tag?: string;
  role?: string;
  attrs?: Record<string, string>;
  classes?: string[];
  children?: any[];
  type?: string;
  id?: string;
  href?: string;
};

function makeDoc() {
  const byId = new Map<string, any>();
  return {
    getElementById(id: string) { return byId.get(id) ?? null; },
    register(el: any): void {
      const id = el.getAttribute?.('id');
      if (id) byId.set(id, el);
      for (const c of el.children ?? []) this.register(c);
    },
  };
}

function makeEl(spec: ElSpec, doc?: any): any {
  const attrs: Record<string, string> = { ...(spec.attrs ?? {}) };
  if (spec.role) attrs.role = spec.role;
  if (spec.id) attrs.id = spec.id;
  if (spec.href) attrs.href = spec.href;
  if (spec.classes?.length) attrs.class = spec.classes.join(' ');

  const children = spec.children ?? [];
  const el: any = {
    tagName: (spec.tag ?? 'div').toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
    parentElement: null,
    type: spec.type,
    getAttribute(name: string): string | null { return attrs[name] ?? null; },
    hasAttribute(name: string): boolean { return name in attrs; },
    get ownerDocument() { return doc; },
  };
  for (const child of children) child.parentElement = el;
  doc?.register?.(el);
  return el;
}

/**
 * Invoke the browser-side function from Node by injecting stub `window`
 * and `document` globals. The window stub covers scroll/viewport refs
 * the script uses for document→viewport coordinate conversion; the
 * document stub provides `elementFromPoint` (always returning the mock)
 * and `getElementById` for aria-controls resolution.
 */
function runBrowserSide(root: any, doc: any): PatternFingerprint | undefined {
  const prevWindow = (globalThis as any).window;
  const prevDoc = (globalThis as any).document;
  (globalThis as any).window = {
    scrollX: 0, scrollY: 0,
    innerWidth: 1024, innerHeight: 768,
    scrollTo: () => {},
  };
  (globalThis as any).document = {
    elementFromPoint: () => root,
    getElementById: (id: string) => doc?.getElementById?.(id) ?? null,
  };
  try {
    const result = computeFingerprintsBrowserSide([{ id: 1, x: 0, y: 0 }]);
    return result[1];
  } finally {
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
    if (prevDoc === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDoc;
  }
}

// ─── Parity fixtures: broad coverage of the three layers ────────────────────

interface Fixture {
  name: string;
  build: () => { el: any; doc: any };
}

const FIXTURES: Fixture[] = [
  {
    name: 'plain button (implied role)',
    build: () => {
      const doc = makeDoc();
      return { el: makeEl({ tag: 'button' }, doc), doc };
    },
  },
  {
    name: 'explicit-role combobox with aria + descendant listbox',
    build: () => {
      const doc = makeDoc();
      const listbox = makeEl({ role: 'listbox', children: [makeEl({ role: 'option' })] });
      const el = makeEl({
        role: 'combobox',
        attrs: { 'aria-expanded': 'false', 'aria-haspopup': 'listbox' },
        children: [listbox],
      }, doc);
      return { el, doc };
    },
  },
  {
    name: 'MUI-prefixed wrapper with nested input',
    build: () => {
      const doc = makeDoc();
      const input = makeEl({ tag: 'input', type: 'text' });
      const el = makeEl({
        classes: ['MuiAutocomplete-root'],
        children: [input],
      }, doc);
      return { el, doc };
    },
  },
  {
    name: 'input[type=range] native slider',
    build: () => {
      const doc = makeDoc();
      return { el: makeEl({ tag: 'input', type: 'range' }, doc), doc };
    },
  },
  {
    name: 'link without href (no implied role)',
    build: () => {
      const doc = makeDoc();
      return { el: makeEl({ tag: 'a' }, doc), doc };
    },
  },
  {
    name: 'ant-prefixed select with aria-controls → listbox',
    build: () => {
      const doc = makeDoc();
      const listbox = makeEl({
        id: 'popup-1',
        role: 'listbox',
        children: [makeEl({ role: 'option' }), makeEl({ role: 'option' })],
      }, doc);
      void listbox;
      const el = makeEl({
        classes: ['ant-select-selector'],
        role: 'combobox',
        attrs: { 'aria-controls': 'popup-1', 'aria-expanded': 'true' },
      }, doc);
      return { el, doc };
    },
  },
  {
    name: 'noise-heavy button (aria-label, aria-describedby must be filtered)',
    build: () => {
      const doc = makeDoc();
      const el = makeEl({
        tag: 'button',
        attrs: {
          'aria-label': 'Accept cookies',
          'aria-labelledby': 'lbl1',
          'aria-describedby': 'desc1',
          'aria-valuenow': '5',
          'aria-pressed': 'false', // real capability — should survive
        },
      }, doc);
      return { el, doc };
    },
  },
  {
    name: 'custom topology-only widget (no role, no library class)',
    build: () => {
      const doc = makeDoc();
      const el = makeEl({
        tag: 'div',
        children: [
          makeEl({ tag: 'div', children: [makeEl({ tag: 'input', type: 'email' })] }),
          makeEl({ tag: 'button' }),
        ],
      }, doc);
      return { el, doc };
    },
  },
  {
    name: 'chakra-prefixed menu button',
    build: () => {
      const doc = makeDoc();
      return { el: makeEl({ classes: ['chakra-menu__menu-button'], tag: 'button' }, doc), doc };
    },
  },
  {
    name: 'radix-prefixed dropdown',
    build: () => {
      const doc = makeDoc();
      return {
        el: makeEl({ classes: ['rdx-DropdownMenuContent'], role: 'menu' }, doc),
        doc,
      };
    },
  },
];

describe('pattern-signature-browser parity with Node module', () => {
  for (const fx of FIXTURES) {
    it(`matches for: ${fx.name}`, () => {
      const { el, doc } = fx.build();
      const fromNode = computeFingerprint(el);
      const fromBrowser = runBrowserSide(el, doc);

      // Normalise undefined-field omissions so toEqual is strict but
      // tolerant of "missing key" vs "undefined value" differences.
      const normalise = (fp: PatternFingerprint | undefined) => ({
        aria: fp?.aria,
        library: fp?.library,
        topology: fp?.topology,
      });

      expect(normalise(fromBrowser)).toEqual(normalise(fromNode));
    });
  }

  it('returns empty record when elementFromPoint resolves to nothing', () => {
    const prevWindow = (globalThis as any).window;
    const prevDoc = (globalThis as any).document;
    (globalThis as any).window = {
      scrollX: 0, scrollY: 0,
      innerWidth: 1024, innerHeight: 768,
      scrollTo: () => {},
    };
    (globalThis as any).document = {
      elementFromPoint: () => null,
      getElementById: () => null,
    };
    try {
      const result = computeFingerprintsBrowserSide([{ id: 1, x: 0, y: 0 }]);
      expect(result).toEqual({});
    } finally {
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
      if (prevDoc === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDoc;
    }
  });
});
