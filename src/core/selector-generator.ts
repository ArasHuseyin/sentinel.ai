import type { Page } from 'playwright';
import type { UIElement } from './state-parser.js';

// ─── Slugify ──────────────────────────────────────────────────────────────────

/** Words that carry no identifying meaning for a selector key. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'with', 'into', 'on', 'in', 'to', 'for',
  'and', 'or', 'at', 'of', 'from', 'by',
]);

/**
 * Converts a natural-language instruction into a short camelCase key
 * suitable for use in the `selectors` map of `AgentResult`.
 *
 * @example
 * slugifyInstruction('Click the login button') // → 'clickLoginButton'
 * slugifyInstruction('Fill email field')        // → 'fillEmailField'
 * slugifyInstruction('Submit form')             // → 'submitForm'
 */
export function slugifyInstruction(instruction: string): string {
  const words = instruction
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOP_WORDS.has(w))
    .slice(0, 4); // keep at most 4 meaningful words

  if (words.length === 0) return 'element';

  return words
    .map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join('');
}

// ─── Selector generation ──────────────────────────────────────────────────────

/**
 * Attempts to derive the most stable CSS selector for the DOM element
 * currently at the centre of `target`'s bounding box.
 *
 * Priority order:
 *  1. Testing attributes (`data-testid`, `data-cy`, `data-test`, `data-qa`)
 *  2. Non-generated `id`
 *  3. `name` attribute on form controls
 *  4. `input[type][placeholder]` for text inputs
 *  5. `aria-label`
 *  6. `[role]:has-text(...)` for ARIA-roled elements
 *  7. `tag:has-text(...)` for buttons, links, labels
 *
 * Returns `null` when no element is found at the coordinates or when all
 * strategies fail — callers should treat a null result as "no selector
 * available" and omit the entry rather than throwing.
 */
export async function generateSelector(
  page: Page,
  target: UIElement
): Promise<string | null> {
  const cx = target.boundingClientRect.x + target.boundingClientRect.width / 2;
  const cy = target.boundingClientRect.y + target.boundingClientRect.height / 2;

  try {
    return await page.evaluate(
      ({ x, y }: { x: number; y: number }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!hit) return null;

        /** Escape double-quotes in text for safe use inside `has-text("…")`. */
        const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        /** Check one element for stable selector strategies. */
        function tryElement(el: HTMLElement): string | null {
          // 1. Testing attributes — universally accepted stable selectors
          for (const attr of ['data-testid', 'data-cy', 'data-test', 'data-qa', 'data-id']) {
            const val = el.getAttribute(attr);
            if (val) return `[${attr}="${CSS.escape(val)}"]`;
          }

          // 2. id — skip auto-generated values (UUIDs, pure numbers, long hashes)
          const id = el.getAttribute('id');
          if (
            id &&
            id.length > 0 &&
            id.length < 60 &&
            !/^\d/.test(id) &&                        // must not start with a digit
            !/[a-f0-9]{8}-[a-f0-9]{4}/.test(id) &&   // not a UUID
            !/^[a-f0-9]{16,}$/.test(id)               // not a long hex hash
          ) {
            return `#${CSS.escape(id)}`;
          }

          // 3. name attribute on form controls
          const nameAttr = el.getAttribute('name');
          const tag = el.tagName.toLowerCase();
          if (nameAttr && ['input', 'select', 'textarea', 'button'].includes(tag)) {
            return `${tag}[name="${CSS.escape(nameAttr)}"]`;
          }

          // 4. input[type][placeholder] — uniquely identifies most text inputs
          if (tag === 'input') {
            const type = el.getAttribute('type') ?? 'text';
            const placeholder = el.getAttribute('placeholder');
            if (placeholder) return `input[type="${type}"][placeholder="${CSS.escape(placeholder)}"]`;
            if (type !== 'text') return `input[type="${type}"]`;
          }

          // 5. aria-label
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;

          // 6. ARIA role + text
          const roleAttr = el.getAttribute('role');
          const text = el.textContent?.trim().slice(0, 40) ?? '';
          if (roleAttr && text) return `[role="${roleAttr}"]:has-text("${escapeText(text)}")`;

          // 7. Tag + text for buttons, links, labels
          if (['button', 'a', 'label'].includes(tag) && text) {
            return `${tag}:has-text("${escapeText(text)}")`;
          }

          return null;
        }

        // Walk up the DOM from the innermost hit element.
        // elementFromPoint returns the deepest child (e.g. <span> inside <button>),
        // so we traverse ancestors until we find one with a stable selector.
        let current: HTMLElement | null = hit;
        while (current && current !== document.body) {
          const sel = tryElement(current);
          if (sel !== null) return sel;
          current = current.parentElement;
        }

        return null;
      },
      { x: cx, y: cy }
    );
  } catch {
    return null;
  }
}
