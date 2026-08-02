import type { Page } from 'playwright';
import type { UIElement, PageRegion } from '../state-parser.js';
import { GENERIC_NAMES, isGenericName } from './generic-names.js';

/**
 * Disambiguation and layout pass, run once over the finished element list.
 *
 * Three jobs, batched into a single page.evaluate because each is a DOM read
 * per element and a round-trip per element would dominate parse time:
 *
 *  - **Context** for generically-named controls. Half the buttons on a page
 *    are called "Submit" or "Mehr"; the nearest labelled ancestor is what
 *    tells the planner which one it is looking at.
 *  - **Region** (header / nav / main / sidebar / footer), so an instruction
 *    about "the search box" can prefer the one in the content over the one in
 *    the site chrome.
 *  - **Validation errors** attached to a field, which is how a failed submit
 *    becomes actionable feedback instead of an unexplained no-op.
 *
 * Mutates `elements` in place — it is the parser's own freshly built array.
 */
export async function enrichAndDetectRegions(page: Page, elements: UIElement[]): Promise<void> {
  if (elements.length === 0) return;

  const genericNamesArray = [...GENERIC_NAMES];
  const genericIds = new Set(elements.filter(e => isGenericName(e.name)).map(e => e.id));

  const items = elements.map(e => ({
    id: e.id,
    x: e.boundingClientRect.x + e.boundingClientRect.width / 2,
    y: e.boundingClientRect.y + e.boundingClientRect.height / 2,
    needsContext: genericIds.has(e.id),
  }));

  const results: { id: number; context: string; region: string; error: string }[] = await page
    .evaluate(
      ({
        items,
        genericNames,
      }: {
        items: { id: number; x: number; y: number; needsContext: boolean }[];
        genericNames: string[];
      }) => {
        const genericSet = new Set(genericNames);
        function isGeneric(name: string): boolean {
          return name.length < 3 || genericSet.has(name.toLowerCase().trim());
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        function detectRegion(el: Element | null, x: number, y: number): string {
          if (!el) return positionalFallback(x, y);
          let node: Element | null = el;
          for (let depth = 0; depth < 15 && node; depth++) {
            const tag = node.tagName?.toLowerCase();
            const role = node.getAttribute('role');
            if (role === 'dialog' || role === 'alertdialog' || tag === 'dialog') return 'modal';
            if (
              role === 'menu' ||
              role === 'listbox' ||
              role === 'tooltip' ||
              role === 'popup' ||
              node.classList?.contains('popup') ||
              node.classList?.contains('dropdown') ||
              node.classList?.contains('popover')
            )
              return 'popup';
            if (tag === 'header' || role === 'banner') return 'header';
            if (tag === 'footer' || role === 'contentinfo') return 'footer';
            if (tag === 'nav' || role === 'navigation') return 'nav';
            if (tag === 'aside' || role === 'complementary') return 'sidebar';
            if (tag === 'main' || role === 'main') return 'main';
            node = node.parentElement;
          }
          return positionalFallback(x, y);
        }

        function positionalFallback(x: number, y: number): string {
          if (y < 60) return 'header';
          if (y > vh - 60) return 'footer';
          if (x < vw * 0.25 && vw > 600) return 'sidebar';
          return 'main';
        }

        function findContext(el: Element): string {
          let container: Element | null = el.parentElement;
          for (let depth = 0; depth < 8 && container; depth++) {
            const dataContext =
              container.getAttribute('data-name') ??
              container.getAttribute('data-provider') ??
              container.getAttribute('data-title') ??
              container.getAttribute('aria-label') ??
              '';
            if (dataContext.length > 2 && dataContext.length < 80 && !isGeneric(dataContext)) {
              return dataContext;
            }

            const imgAlt = (() => {
              for (const img of Array.from(container!.querySelectorAll('img[alt]'))) {
                const imgEl = img as HTMLImageElement;
                if (imgEl.offsetParent === null) continue;
                const alt = imgEl.alt.replace(/\s+/g, ' ').trim();
                if (
                  alt.length > 1 &&
                  alt.length < 60 &&
                  !isGeneric(alt) &&
                  !/[/\\]|icon|logo|check|image|photo|pic|banner|avatar/i.test(alt)
                )
                  return alt;
              }
              return '';
            })();

            const heading =
              Array.from(container.querySelectorAll('h1, h2, h3, h4, strong, b')).find(
                h => (h as HTMLElement).offsetParent !== null
              ) ?? null;
            const headingText = heading?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

            const extraParts: string[] = [];
            for (const p of Array.from(container.querySelectorAll('p'))) {
              if ((p as HTMLElement).offsetParent === null) continue;
              const t = p.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (
                t.length > 2 &&
                t.length < 60 &&
                !isGeneric(t) &&
                t !== headingText &&
                !headingText.includes(t)
              ) {
                extraParts.push(t);
                if (extraParts.length >= 2) break;
              }
            }

            for (const node of Array.from(container.querySelectorAll('span, div'))) {
              if (node.children.length > 0) continue;
              if ((node as HTMLElement).offsetParent === null) continue;
              const t = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (
                t.length > 2 &&
                t.length < 35 &&
                !isGeneric(t) &&
                t !== headingText &&
                !headingText.includes(t) &&
                !extraParts.includes(t)
              ) {
                extraParts.push(t);
                if (extraParts.length >= 3) break;
              }
            }

            const parts = [
              ...(imgAlt && imgAlt !== headingText ? [imgAlt] : []),
              ...(headingText ? [headingText] : []),
              ...extraParts,
            ];
            const contextText = parts.join(' | ');

            if (contextText.length > 2 && contextText.length < 120 && !isGeneric(contextText)) {
              return contextText;
            }

            container = container.parentElement;
          }
          return '';
        }

        // Find validation errors for form fields via ARIA attributes and DOM proximity.
        // Uses W3C standards (aria-invalid, aria-errormessage, aria-describedby, role="alert")
        // and structural patterns (nearby elements with error/invalid classes).
        function findError(el: Element | null): string {
          if (!el) return '';

          // 1. aria-invalid on the element or its parent
          let node: Element | null = el;
          for (let d = 0; d < 3 && node; d++) {
            if (node.getAttribute('aria-invalid') === 'true') {
              // Look for the error message via aria-errormessage or aria-describedby
              const errId =
                node.getAttribute('aria-errormessage') ?? node.getAttribute('aria-describedby');
              if (errId) {
                const errEl = document.getElementById(errId);
                if (errEl) return errEl.textContent?.trim().slice(0, 100) || '';
              }
            }
            node = node.parentElement;
          }

          // 2. Nearby sibling/parent with error class or role="alert"
          let container: Element | null = el.closest('div') ?? el.parentElement;
          for (let d = 0; d < 4 && container; d++) {
            const errEl = container.querySelector(
              '[role="alert"], [class*="error"], [class*="Error"], ' +
                '[class*="invalid"], [class*="Invalid"], [class*="errorMessage"], ' +
                '[class*="validation"], [class*="Validation"]'
            );
            if (errEl && errEl.textContent?.trim()) {
              const text = errEl.textContent.trim().slice(0, 100);
              if (text.length > 2) return text;
            }
            container = container.parentElement;
          }

          return '';
        }

        return items.map(({ id, x, y, needsContext }) => {
          const vpX = x - window.scrollX;
          const vpY = y - window.scrollY;
          const el = document.elementFromPoint(vpX, vpY);
          return {
            id,
            context: needsContext && el ? findContext(el) : '',
            region: detectRegion(el, vpX, vpY),
            error: el ? findError(el) : '',
          };
        });
      },
      { items, genericNames: genericNamesArray }
    )
    .catch(() => [] as { id: number; context: string; region: string; error: string }[]);

  const resultMap = new Map(results.map(r => [r.id, r]));
  for (const el of elements) {
    const data = resultMap.get(el.id);
    if (!data) continue;
    if (data.context) el.name = `${data.context}: ${el.name}`;
    if (data.region) el.region = data.region as PageRegion;
    if (data.error) el.error = data.error;
  }
}
