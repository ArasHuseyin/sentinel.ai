import type { PatternFingerprint } from './pattern-signature.js';

/**
 * Self-contained fingerprint computation ready for injection into
 * `page.evaluate`. The function is intentionally closure-free: it
 * references only the `document` global (supplied by the browser
 * context at evaluate-time) and its own `targets` argument. No imports,
 * no outer-scope constants — because Playwright's `page.evaluate(fn)`
 * ships `fn.toString()` to the browser and any module-scope ref would
 * arrive as `undefined`.
 *
 * The logic duplicates `pattern-signature.ts` deliberately. The two are
 * kept in sync by `pattern-signature-browser.drift.test.ts`, which runs
 * both implementations against the same synthetic DOM fixtures and
 * fails the build on any divergence.
 *
 * All three fingerprint layers (aria / library / topology) are computed
 * in a single page.evaluate per call, one round-trip for N targets.
 */
export function computeFingerprintsBrowserSide(
  targets: Array<{ id: number; x: number; y: number }>
): Record<number, PatternFingerprint> {
  const ARIA_NOISE = new Set([
    'aria-label', 'aria-labelledby', 'aria-describedby',
    'aria-valuenow', 'aria-valuetext',
    'aria-activedescendant', 'aria-owns',
  ]);

  const LIBRARY_PREFIXES: Array<[string, string]> = [
    ['MuiBase', 'mui'],
    ['Mui', 'mui'],
    ['ant-', 'ant'],
    ['chakra-', 'chakra'],
    ['rs-', 'rsuite'],
    ['mat-', 'angular-material'],
    ['mat_', 'angular-material'],
    ['el-', 'element'],
    ['v-', 'vuetify'],
    ['q-', 'quasar'],
    ['rdx-', 'radix'],
    ['Polaris-', 'polaris'],
    ['bp4-', 'blueprint'],
    ['bp5-', 'blueprint'],
    ['Popover-', 'headlessui'],
  ];

  function resolveRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = ((el as HTMLInputElement).type ?? '').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  }

  function computeAriaFingerprint(el: Element): string {
    const role = resolveRole(el);
    if (!role) return '';

    const ariaKeys: string[] = [];
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('aria-') && !ARIA_NOISE.has(n)) ariaKeys.push(n);
    }

    const descendantRoles: string[] = [];
    const addRole = (node: Element, prefix = ''): void => {
      const r = resolveRole(node);
      if (r && r !== role) descendantRoles.push(prefix ? `${prefix}:${r}` : r);
    };

    const stack: Element[] = Array.from(el.children);
    let count = 0;
    while (stack.length > 0 && count < 40) {
      const node = stack.shift()!;
      count++;
      addRole(node);
      for (const c of Array.from(node.children)) stack.push(c);
    }

    const linked: string[] = [];
    const ctrl = el.getAttribute('aria-controls');
    if (ctrl) linked.push(ctrl);
    const owns = el.getAttribute('aria-owns');
    if (owns) linked.push(owns);
    for (const ids of linked) {
      for (const id of ids.split(/\s+/)) {
        const target = (el.ownerDocument ?? document).getElementById(id);
        if (!target) continue;
        addRole(target, 'ctrl');
        const linkedStack: Element[] = Array.from(target.children);
        let lc = 0;
        while (linkedStack.length > 0 && lc < 15) {
          const node = linkedStack.shift()!;
          lc++;
          addRole(node, 'ctrl');
          for (const c of Array.from(node.children)) linkedStack.push(c);
        }
      }
    }

    const uniqAria = Array.from(new Set(ariaKeys)).sort().join(',');
    const uniqDesc = Array.from(new Set(descendantRoles)).sort().join(',');
    return `${role}|${uniqAria}|${uniqDesc}`;
  }

  function computeLibrarySignature(el: Element): string | null {
    let current: Element | null = el;
    for (let d = 0; d < 6 && current; d++) {
      const classAttr = current.getAttribute('class');
      if (classAttr) {
        for (const cls of classAttr.split(/\s+/)) {
          if (!cls) continue;
          for (const [prefix, id] of LIBRARY_PREFIXES) {
            if (cls.startsWith(prefix)) {
              const rest = cls.slice(prefix.length);
              const m = rest.match(/^([A-Za-z]+)/);
              const component = m ? m[1]!.toLowerCase() : 'generic';
              return `${id}:${component}`;
            }
          }
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  function computeTopologyHash(el: Element): string {
    const parts: string[] = [];
    let count = 0;
    const walk = (node: Element, depth: number): void => {
      if (count >= 30 || depth > 4) return;
      count++;
      const tag = node.tagName.toLowerCase();
      const type = ((node as HTMLInputElement).type ?? '').toLowerCase();
      parts.push(type ? `${depth}:${tag}[${type}]` : `${depth}:${tag}`);
      for (const c of Array.from(node.children)) walk(c, depth + 1);
    };
    walk(el, 0);
    return parts.join('>');
  }

  const result: Record<number, PatternFingerprint> = {};
  // Targets arrive in document-space coordinates (state-parser pre-adds
  // window.scrollX/Y). `elementFromPoint` expects viewport-space, so we
  // subtract the current scroll offset. For targets that sit OUTSIDE the
  // viewport, `elementFromPoint` returns null regardless — we scroll them
  // into view temporarily so the hit test can resolve, then restore the
  // original scroll position so the observable DOM state is unchanged.
  const origScrollX = window.scrollX;
  const origScrollY = window.scrollY;
  try {
    for (const t of targets) {
      // Bring target into the viewport if needed (instant, no animation —
      // must complete before the next elementFromPoint call).
      const needsScroll =
        t.y - window.scrollY < 0 || t.y - window.scrollY > window.innerHeight ||
        t.x - window.scrollX < 0 || t.x - window.scrollX > window.innerWidth;
      if (needsScroll) {
        window.scrollTo({
          left: Math.max(0, t.x - window.innerWidth / 2),
          top: Math.max(0, t.y - window.innerHeight / 2),
          behavior: 'instant' as ScrollBehavior,
        });
      }
      const vx = t.x - window.scrollX;
      const vy = t.y - window.scrollY;
      const el = document.elementFromPoint(vx, vy) as Element | null;
      if (!el) continue;
      const aria = computeAriaFingerprint(el);
      const library = computeLibrarySignature(el);
      const topology = computeTopologyHash(el);
      const fp: PatternFingerprint = {};
      if (aria) fp.aria = aria;
      if (library) fp.library = library;
      if (topology) fp.topology = topology;
      result[t.id] = fp;
    }
  } finally {
    // Always restore — fingerprinting must be side-effect-free on the page.
    window.scrollTo({
      left: origScrollX, top: origScrollY,
      behavior: 'instant' as ScrollBehavior,
    });
  }
  return result;
}
