import { describe, it, expect } from '@jest/globals';
import {
  formatAriaFingerprint,
  resolveRole,
  collectAriaFingerprintInputs,
  computeAriaFingerprint,
  computeLibrarySignature,
  computeTopologyHash,
  computeFingerprint,
  LIBRARY_PREFIXES,
} from '../core/pattern-signature.js';

// ─── Minimal Element mock ────────────────────────────────────────────────────
// The signature module treats its input as a plain Element. In Node tests
// (no jsdom), we synthesise just enough of the interface for it to walk.

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
    getElementById(id: string) {
      return byId.get(id) ?? null;
    },
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
    getAttribute(name: string): string | null {
      return attrs[name] ?? null;
    },
    hasAttribute(name: string): boolean {
      return name in attrs;
    },
    get ownerDocument() { return doc; },
  };
  for (const child of children) child.parentElement = el;
  doc?.register?.(el);
  return el;
}

// ─── Layer 1: ARIA fingerprint ──────────────────────────────────────────────

describe('formatAriaFingerprint (pure)', () => {
  it('returns empty string when role is empty', () => {
    expect(formatAriaFingerprint('', ['aria-expanded'], ['option'])).toBe('');
  });

  it('composes role | aria-keys | descendants in canonical order', () => {
    const fp = formatAriaFingerprint('combobox', ['aria-expanded', 'aria-controls'], ['listbox', 'option']);
    expect(fp).toBe('combobox|aria-controls,aria-expanded|listbox,option');
  });

  it('dedupes and sorts both aria keys and descendants', () => {
    const fp1 = formatAriaFingerprint('combobox', ['aria-b', 'aria-a', 'aria-a'], ['x', 'y', 'x']);
    const fp2 = formatAriaFingerprint('combobox', ['aria-a', 'aria-b'], ['y', 'x']);
    expect(fp1).toBe(fp2);
  });

  it('handles empty aria / descendant arrays', () => {
    expect(formatAriaFingerprint('button', [], [])).toBe('button||');
  });
});

describe('resolveRole', () => {
  it('returns explicit role when set', () => {
    const el = makeEl({ tag: 'div', role: 'combobox' });
    expect(resolveRole(el)).toBe('combobox');
  });

  it('implies button role from <button>', () => {
    expect(resolveRole(makeEl({ tag: 'button' }))).toBe('button');
  });

  it('implies link role from <a href>', () => {
    expect(resolveRole(makeEl({ tag: 'a', href: '/x' }))).toBe('link');
  });

  it('returns empty for <a> without href', () => {
    expect(resolveRole(makeEl({ tag: 'a' }))).toBe('');
  });

  it('implies textbox from input[type=text]', () => {
    expect(resolveRole(makeEl({ tag: 'input', type: 'text' }))).toBe('textbox');
  });

  it('implies slider from input[type=range]', () => {
    expect(resolveRole(makeEl({ tag: 'input', type: 'range' }))).toBe('slider');
  });

  it('implies checkbox from input[type=checkbox]', () => {
    expect(resolveRole(makeEl({ tag: 'input', type: 'checkbox' }))).toBe('checkbox');
  });

  it('returns empty for random element', () => {
    expect(resolveRole(makeEl({ tag: 'span' }))).toBe('');
  });

  it('prefers explicit role over implied', () => {
    const el = makeEl({ tag: 'input', type: 'text', role: 'combobox' });
    expect(resolveRole(el)).toBe('combobox');
  });
});

describe('collectAriaFingerprintInputs', () => {
  it('filters out aria-label / aria-labelledby / aria-describedby noise', () => {
    const el = makeEl({
      role: 'combobox',
      attrs: {
        'aria-label': 'search',
        'aria-labelledby': 'l1',
        'aria-describedby': 'd1',
        'aria-expanded': 'false',
        'aria-controls': 'popup1',
      },
    });
    const { ariaAttrKeys } = collectAriaFingerprintInputs(el);
    expect(ariaAttrKeys.sort()).toEqual(['aria-controls', 'aria-expanded']);
  });

  it('collects descendant roles (bounded)', () => {
    const option = makeEl({ role: 'option' });
    const listbox = makeEl({ role: 'listbox', children: [option] });
    const el = makeEl({ role: 'combobox', children: [listbox] });
    const { descendantRolePattern } = collectAriaFingerprintInputs(el);
    expect(descendantRolePattern).toContain('listbox');
    expect(descendantRolePattern).toContain('option');
  });

  it('follows aria-controls to linked popup (ctrl: prefix)', () => {
    const doc = makeDoc();
    const option = makeEl({ role: 'option' }, doc);
    const listbox = makeEl({ id: 'popup1', role: 'listbox', children: [option] }, doc);
    const el = makeEl({
      role: 'combobox',
      attrs: { 'aria-controls': 'popup1' },
    }, doc);
    // Manually register the linked listbox so getElementById resolves it
    doc.register(listbox);
    const { descendantRolePattern } = collectAriaFingerprintInputs(el);
    expect(descendantRolePattern).toContain('ctrl:listbox');
    expect(descendantRolePattern).toContain('ctrl:option');
  });

  it('skips own role from descendant pattern (no combobox-in-combobox)', () => {
    const nested = makeEl({ role: 'combobox' }); // own role repeated
    const other = makeEl({ role: 'textbox' });
    const el = makeEl({ role: 'combobox', children: [nested, other] });
    const { descendantRolePattern } = collectAriaFingerprintInputs(el);
    expect(descendantRolePattern).toContain('textbox');
    expect(descendantRolePattern).not.toContain('combobox');
  });
});

describe('computeAriaFingerprint', () => {
  it('returns identical fingerprints for same ARIA shape', () => {
    const build = () => makeEl({
      role: 'combobox',
      attrs: { 'aria-expanded': 'false', 'aria-controls': 'l1' },
      children: [makeEl({ role: 'textbox' })],
    });
    expect(computeAriaFingerprint(build())).toBe(computeAriaFingerprint(build()));
  });

  it('discriminates different ARIA shapes', () => {
    const combo = makeEl({ role: 'combobox', attrs: { 'aria-expanded': 'false' } });
    const menu = makeEl({ role: 'menu', attrs: { 'aria-expanded': 'false' } });
    expect(computeAriaFingerprint(combo)).not.toBe(computeAriaFingerprint(menu));
  });

  it('ignores aria-label values (noise dropped)', () => {
    const a = makeEl({ role: 'button', attrs: { 'aria-label': 'Accept' } });
    const b = makeEl({ role: 'button', attrs: { 'aria-label': 'Cancel' } });
    expect(computeAriaFingerprint(a)).toBe(computeAriaFingerprint(b));
  });

  it('returns empty string for element without role or implied role', () => {
    expect(computeAriaFingerprint(makeEl({ tag: 'span' }))).toBe('');
  });
});

// ─── Layer 2: library signature ─────────────────────────────────────────────

describe('computeLibrarySignature', () => {
  it('detects mui from Mui* class', () => {
    const el = makeEl({ classes: ['MuiSelect-root'] });
    expect(computeLibrarySignature(el)).toBe('mui:select');
  });

  it('detects ant from ant- class', () => {
    const el = makeEl({ classes: ['ant-select', 'ant-select-focused'] });
    expect(computeLibrarySignature(el)).toBe('ant:select');
  });

  it('detects chakra from chakra- class', () => {
    const el = makeEl({ classes: ['chakra-menu__menu-list'] });
    const sig = computeLibrarySignature(el);
    expect(sig).toMatch(/^chakra:/);
  });

  it('walks up ancestors to find a prefixed class', () => {
    const inner = makeEl({ tag: 'span' });
    const middle = makeEl({ tag: 'div', children: [inner] });
    const outer = makeEl({ classes: ['MuiAutocomplete-root'], children: [middle] });
    void outer; // silence unused — parent chain is wired via makeEl side-effects
    expect(computeLibrarySignature(inner)).toBe('mui:autocomplete');
  });

  it('returns null when no library-prefixed class is found', () => {
    const el = makeEl({ classes: ['some-random-class'] });
    expect(computeLibrarySignature(el)).toBe(null);
  });

  it('prefers more specific prefix (MuiBase before Mui)', () => {
    // Current table order puts MuiBase first — this test locks in that ordering
    const el = makeEl({ classes: ['MuiBaseButton-root'] });
    expect(computeLibrarySignature(el)).toBe('mui:button');
  });

  it('LIBRARY_PREFIXES table has no empty prefix or id', () => {
    for (const [prefix, id] of LIBRARY_PREFIXES) {
      expect(prefix.length).toBeGreaterThan(0);
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

// ─── Layer 3: topology hash ─────────────────────────────────────────────────

describe('computeTopologyHash', () => {
  it('produces stable output across calls', () => {
    const build = () => makeEl({
      tag: 'div',
      children: [
        makeEl({ tag: 'input', type: 'text' }),
        makeEl({ tag: 'button' }),
      ],
    });
    expect(computeTopologyHash(build())).toBe(computeTopologyHash(build()));
  });

  it('distinguishes different structures', () => {
    const a = makeEl({ tag: 'div', children: [makeEl({ tag: 'input' })] });
    const b = makeEl({ tag: 'div', children: [makeEl({ tag: 'button' })] });
    expect(computeTopologyHash(a)).not.toBe(computeTopologyHash(b));
  });

  it('captures input types', () => {
    const dateInput = makeEl({ tag: 'input', type: 'date' });
    const textInput = makeEl({ tag: 'input', type: 'text' });
    expect(computeTopologyHash(dateInput)).not.toBe(computeTopologyHash(textInput));
  });

  it('ignores classes and ids (structural only)', () => {
    const plain = makeEl({ tag: 'div', children: [makeEl({ tag: 'span' })] });
    const styled = makeEl({
      tag: 'div',
      classes: ['some-class', 'another'],
      id: 'x',
      children: [makeEl({ tag: 'span', classes: ['c'] })],
    });
    expect(computeTopologyHash(plain)).toBe(computeTopologyHash(styled));
  });
});

// ─── Combined ───────────────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('returns all three layers for a full widget', () => {
    const el = makeEl({
      role: 'combobox',
      classes: ['MuiSelect-root'],
      attrs: { 'aria-expanded': 'false' },
      children: [makeEl({ role: 'textbox' })],
    });
    const fp = computeFingerprint(el);
    expect(fp.aria).toMatch(/^combobox\|/);
    expect(fp.library).toBe('mui:select');
    expect(fp.topology).toBeTruthy();
  });

  it('omits library layer when no library class is present', () => {
    const el = makeEl({
      role: 'combobox',
      attrs: { 'aria-expanded': 'false' },
    });
    const fp = computeFingerprint(el);
    expect(fp.aria).toBeTruthy();
    expect(fp.library).toBeUndefined();
    expect(fp.topology).toBeTruthy();
  });

  it('omits aria layer when element has no role', () => {
    const el = makeEl({ tag: 'span' });
    const fp = computeFingerprint(el);
    expect(fp.aria).toBeUndefined();
    expect(fp.topology).toBeTruthy();
  });
});
