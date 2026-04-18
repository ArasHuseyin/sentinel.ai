/**
 * Three-layer widget fingerprinting for the pattern store.
 *
 *   Layer 1 — ARIA fingerprint (primary, universal)
 *     Deterministic hash of role + aria-attribute-keys + descendant-role-pattern.
 *     Matches ANY widget that exposes the same ARIA shape regardless of
 *     underlying library or styling. This is the load-bearing layer — it
 *     transfers learned interactions across sites that use different
 *     libraries but share widget semantics.
 *
 *   Layer 2 — Library signature (optimization)
 *     Class-prefix heuristic that identifies well-known component libraries.
 *     NOT required for matching — the ARIA layer already covers anything
 *     ARIA-compliant. Serves as a faster, more specific cache key when the
 *     widget is wrapped in a recognised library's classes.
 *
 *   Layer 3 — Topology hash (fallback for non-ARIA)
 *     Bounded structural hash (tags + input types + depth) of the widget
 *     subtree. Doesn't carry semantics, but uniquely fingerprints widgets
 *     that lack ARIA — common in inhouse component libraries that never
 *     added accessibility attributes.
 *
 * Design note: library names live ONLY in the LIBRARY_PREFIXES data table.
 * No downstream code branches on library identity — the signature is just
 * a cache key. This respects the universal-solutions rule: the cache gets
 * a faster hit for known libs, but nothing else changes.
 */

// ─── Layer 1: ARIA fingerprint ──────────────────────────────────────────────

/**
 * ARIA attributes that encode runtime state or user-visible text rather
 * than widget capability. Excluded from the fingerprint because they
 * change between identical widgets (e.g. every combobox has a different
 * `aria-label`, but all share the same `aria-controls` capability).
 */
export const ARIA_NOISE = new Set([
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-valuenow',
  'aria-valuetext',
  'aria-activedescendant',
  'aria-owns',
]);

/**
 * Pure function (easy to unit test): formats the canonical fingerprint
 * string from already-collected primitives. Sorting + dedup make the
 * output order-independent so two identical widgets always hash equal.
 */
export function formatAriaFingerprint(
  role: string,
  ariaAttrKeys: string[],
  descendantRolePattern: string[]
): string {
  if (!role) return '';
  const ariaPart = [...new Set(ariaAttrKeys)].sort().join(',');
  const descPart = [...new Set(descendantRolePattern)].sort().join(',');
  return `${role}|${ariaPart}|${descPart}`;
}

/**
 * Implied ARIA roles for common native elements. Browsers compute these
 * automatically in the accessibility tree; we replicate the minimum set
 * needed for fingerprinting. Absent from this map = no implied role, and
 * the element contributes `''` to the fingerprint (i.e. won't match).
 */
const IMPLIED_ROLES: Record<string, (el: Element) => string> = {
  'BUTTON': () => 'button',
  'A': (el) => el.hasAttribute('href') ? 'link' : '',
  'SELECT': () => 'combobox',
  'TEXTAREA': () => 'textbox',
  'INPUT': (el) => {
    const type = ((el as HTMLInputElement).type ?? '').toLowerCase();
    switch (type) {
      case 'button': case 'submit': case 'reset': case 'image': return 'button';
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'range': return 'slider';
      case 'number': return 'spinbutton';
      case 'search': return 'searchbox';
      case 'text': case 'email': case 'password': case 'tel': case 'url': case '': return 'textbox';
      default: return 'textbox';
    }
  },
};

export function resolveRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.trim().toLowerCase();
  const implied = IMPLIED_ROLES[el.tagName];
  return implied ? implied(el) : '';
}

/**
 * DOM-touching function. Collects the three primitives the ARIA
 * fingerprint needs from a live `Element`. Pulls in `aria-controls`
 * targets so popup-connected widgets (combobox → listbox, button →
 * menu) carry their connected structure in the fingerprint.
 */
export function collectAriaFingerprintInputs(el: Element): {
  role: string;
  ariaAttrKeys: string[];
  descendantRolePattern: string[];
} {
  const role = resolveRole(el);
  const ariaAttrKeys = Array.from(el.attributes)
    .map(a => a.name.toLowerCase())
    .filter(n => n.startsWith('aria-') && !ARIA_NOISE.has(n));

  const descendantRolePattern: string[] = [];
  const addRole = (node: Element, prefix = ''): void => {
    const r = resolveRole(node);
    if (r && r !== role) descendantRolePattern.push(prefix ? `${prefix}:${r}` : r);
  };

  // Direct descendants (bounded)
  const MAX_DESCENDANTS = 40;
  let count = 0;
  const stack: Element[] = Array.from(el.children);
  while (stack.length > 0 && count < MAX_DESCENDANTS) {
    const node = stack.shift()!;
    count++;
    addRole(node);
    for (const child of Array.from(node.children)) stack.push(child);
  }

  // Follow aria-controls / aria-owns pointers so popup-controlled widgets
  // carry their linked structure (e.g. combobox controlling listbox).
  const linked = [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')]
    .filter(Boolean) as string[];
  for (const ids of linked) {
    for (const id of ids.split(/\s+/)) {
      const target = el.ownerDocument?.getElementById(id);
      if (!target) continue;
      addRole(target, 'ctrl');
      const MAX_LINKED = 15;
      let lc = 0;
      const linkedStack: Element[] = Array.from(target.children);
      while (linkedStack.length > 0 && lc < MAX_LINKED) {
        const node = linkedStack.shift()!;
        lc++;
        addRole(node, 'ctrl');
        for (const child of Array.from(node.children)) linkedStack.push(child);
      }
    }
  }

  return { role, ariaAttrKeys, descendantRolePattern };
}

export function computeAriaFingerprint(el: Element): string {
  const { role, ariaAttrKeys, descendantRolePattern } = collectAriaFingerprintInputs(el);
  return formatAriaFingerprint(role, ariaAttrKeys, descendantRolePattern);
}

// ─── Layer 2: library signature ─────────────────────────────────────────────

/**
 * Class-prefix → library-id map. Extensible data table; adding entries
 * only changes cache-key granularity, never runtime behavior.
 * Match logic: startsWith against any space-delimited class on an element
 * or any of its ancestors (bounded walk).
 */
export const LIBRARY_PREFIXES: ReadonlyArray<[prefix: string, id: string]> = [
  // Prefix ordering: more specific first (MuiBase before Mui)
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
  ['Popover-', 'headlessui'], // headless-ui generated classes tend to have these
];

/** Max ancestor levels walked to find a library-prefixed class. */
const LIBRARY_WALK_DEPTH = 6;

export function computeLibrarySignature(el: Element): string | null {
  let current: Element | null = el;
  for (let depth = 0; depth < LIBRARY_WALK_DEPTH && current; depth++) {
    const classAttr = current.getAttribute('class');
    if (classAttr) {
      // Test each class token against each prefix
      for (const cls of classAttr.split(/\s+/)) {
        if (!cls) continue;
        for (const [prefix, id] of LIBRARY_PREFIXES) {
          if (cls.startsWith(prefix)) {
            // Extract a component token from the rest of the class name
            // (e.g. "MuiSelect-root" → component="Select").
            const rest = cls.slice(prefix.length);
            const match = rest.match(/^([A-Za-z]+)/);
            const component = match ? match[1]!.toLowerCase() : 'generic';
            return `${id}:${component}`;
          }
        }
      }
    }
    current = current.parentElement;
  }
  return null;
}

// ─── Layer 3: topology hash ─────────────────────────────────────────────────

const TOPOLOGY_MAX_NODES = 30;
const TOPOLOGY_MAX_DEPTH = 4;

/**
 * Structural-only hash of the widget subtree. Captures tag + input-type +
 * depth; ignores classes, ids, text, inline styles. Two widgets with the
 * same DOM shape produce the same hash regardless of styling or content.
 *
 * Useful as a last-resort cache key for inhouse components that lack
 * both ARIA roles and recognised library classes.
 */
export function computeTopologyHash(el: Element): string {
  const parts: string[] = [];
  let count = 0;
  const walk = (node: Element, depth: number): void => {
    if (count >= TOPOLOGY_MAX_NODES || depth > TOPOLOGY_MAX_DEPTH) return;
    count++;
    const tag = node.tagName.toLowerCase();
    const type = ((node as HTMLInputElement).type ?? '').toLowerCase();
    parts.push(type ? `${depth}:${tag}[${type}]` : `${depth}:${tag}`);
    for (const child of Array.from(node.children)) {
      walk(child, depth + 1);
    }
  };
  walk(el, 0);
  return parts.join('>');
}

// ─── Combined fingerprint ───────────────────────────────────────────────────

export interface PatternFingerprint {
  aria?: string;
  library?: string;
  topology?: string;
}

/**
 * Computes all three layers for a single element. Any layer that yields
 * an empty string is dropped so callers can check `fp.aria` etc. as a
 * truthy existence test.
 */
export function computeFingerprint(el: Element): PatternFingerprint {
  const aria = computeAriaFingerprint(el);
  const library = computeLibrarySignature(el);
  const topology = computeTopologyHash(el);
  return {
    ...(aria ? { aria } : {}),
    ...(library ? { library } : {}),
    ...(topology ? { topology } : {}),
  };
}
