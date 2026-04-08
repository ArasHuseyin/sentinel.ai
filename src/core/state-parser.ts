import type { CDPSession, Page } from 'playwright';

export interface UIElement {
  id: number;
  role: string;
  name: string;
  description?: string;
  boundingClientRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  attributes?: Record<string, string>;
  state?: {
    disabled?: boolean;
    hidden?: boolean;
    focused?: boolean;
    checked?: boolean | 'mixed';
  };
}

export interface SimplifiedState {
  url: string;
  title: string;
  elements: UIElement[];
}

const STATE_CACHE_TTL_MS = 500;

/**
 * Names that are too generic to uniquely identify an element.
 * When one of these is encountered, the parser tries to prefix it with
 * context from the nearest meaningful parent/ancestor.
 */
const GENERIC_NAMES = new Set([
  // German
  'mehr erfahren', 'weiter', 'klick hier', 'hier klicken', 'auswählen',
  'tarif auswählen', 'jetzt auswählen', 'jetzt wählen', 'wählen',
  'anzeigen', 'anmelden', 'bestätigen', 'abbrechen', 'schließen',
  'ja', 'nein', 'ok', 'button', 'link',
  // English
  'more info', 'details', 'next', 'next step', 'click here', 'select',
  'choose', 'show', 'hide', 'confirm', 'cancel', 'close', 'yes', 'no',
  'learn more', 'read more', 'view', 'open', 'submit',
]);

function isGenericName(name: string): boolean {
  return name.length < 3 || GENERIC_NAMES.has(name.toLowerCase().trim());
}

/** AOM roles that represent form inputs — used for the always-on fallback check */
const FORM_INPUT_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'searchbox']);

export class StateParser {
  private cachedState: SimplifiedState | null = null;
  private cacheTimestamp = 0;

  constructor(private page: Page, private cdp: CDPSession) {}

  invalidateCache() {
    this.cachedState = null;
    this.cacheTimestamp = 0;
  }

  async parse(): Promise<SimplifiedState> {
    const now = Date.now();
    if (this.cachedState && (now - this.cacheTimestamp) < STATE_CACHE_TTL_MS) {
      return this.cachedState;
    }

    const counter = { n: 0 };
    const { nodes } = await this.cdp.send('Accessibility.getFullAXTree');

    // ─── Build lookup maps ────────────────────────────────────────────────────
    const nodeMap = new Map<string, any>();
    const childrenMap = new Map<string, string[]>();
    const parentMap = new Map<string, string>(); // childId → parentId

    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
      if (node.childIds?.length) {
        childrenMap.set(node.nodeId, node.childIds);
        for (const childId of node.childIds) {
          parentMap.set(childId, node.nodeId);
        }
      }
    }

    // ─── Filter + parallel bounding-box fetch ─────────────────────────────────
    const interactiveNodes = nodes.filter(
      (node: any) => this.isInteractive(node) && node.backendDOMNodeId
    );

    const boxModelResults = await Promise.allSettled(
      interactiveNodes.map((node: any) =>
        this.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })
      )
    );

    // ─── Build UIElement list ─────────────────────────────────────────────────
    const uiElements: UIElement[] = [];
    for (let i = 0; i < interactiveNodes.length; i++) {
      const node = interactiveNodes[i];
      const result = boxModelResults[i];

      if (!result || result.status === 'rejected') continue;

      const fulfilled = result as PromiseFulfilledResult<any>;
      const { model } = fulfilled.value;
      if (!model?.content || model.content.length < 8) continue;

      const subtextContext = node?.nodeId
        ? this.extractSubtreeText(node.nodeId, nodeMap, childrenMap)
        : '';

      const element = this.nodeToUIElement(node, subtextContext, parentMap, nodeMap, counter);
      if (!element) continue;

      const x = model.content[0]!;
      const y = model.content[1]!;
      const width = model.content[2]! - model.content[0]!;
      const height = model.content[7]! - model.content[1]!;

      element.boundingClientRect = { x, y, width, height };
      uiElements.push(element);
    }

    // ─── DOM Fallback 1: sparse AOM (< 5 elements) ───────────────────────────
    // Full DOM snapshot when AOM yields too few elements (SPAs, shadow DOM, etc.)
    if (uiElements.length < 5) {
      const domElements = await this.parseDOMSnapshot(counter);
      const existingNames = new Set(uiElements.map(e => e.name));
      for (const el of domElements) {
        if (!existingNames.has(el.name)) {
          uiElements.push(el);
        }
      }
    }

    // ─── DOM Enrichment: context for still-generic AOM element names ─────────
    // AOM ancestor-walking misses sibling-branch headings (e.g. a provider name
    // in an h4 that is a sibling of the button's ancestor, not a direct ancestor).
    // For every element still carrying a generic name, look up the real DOM node
    // via elementFromPoint and walk up to find a meaningful heading/label.
    const genericElements = uiElements.filter(e => isGenericName(e.name));
    if (genericElements.length > 0) {
      await this.enrichWithDOMContext(genericElements);
    }

    // ─── DOM Fallback 2: always-on form input check ───────────────────────────
    // Even when AOM returns many elements it can miss hidden/custom form fields.
    // If no textbox / combobox / spinbutton is present, query the DOM directly.
    const hasFormInputs = uiElements.some(e => FORM_INPUT_ROLES.has(e.role));
    if (!hasFormInputs) {
      const formElements = await this.parseFormElements(counter);
      const existingNames = new Set(uiElements.map(e => e.name));
      for (const el of formElements) {
        if (!existingNames.has(el.name) && el.name) {
          uiElements.push(el);
        }
      }
    }

    // ─── iframe Support ───────────────────────────────────────────────────────
    // Collect elements from same-origin iframes, offset to main-page coords.
    const frameElements = await this.parseFrameElements(counter);
    if (frameElements.length > 0) {
      const existingNames = new Set(uiElements.map(e => e.name));
      for (const el of frameElements) {
        if (!existingNames.has(el.name)) {
          uiElements.push(el);
          existingNames.add(el.name); // prevent cross-frame duplicates
        }
      }
    }

    const state: SimplifiedState = {
      url: this.page.url(),
      title: await this.page.title(),
      elements: uiElements,
    };

    this.cachedState = state;
    this.cacheTimestamp = Date.now();
    return state;
  }

  // ─── Private: DOM snapshot (sparse-AOM fallback) ─────────────────────────

  private async parseDOMSnapshot(counter: { n: number }): Promise<UIElement[]> {
    const genericNamesArray = [...GENERIC_NAMES];

    const rawElements = await this.page.evaluate((params: { genericNames: string[] }) => {
      const genericNamesSet = new Set(params.genericNames);

      function isGeneric(name: string): boolean {
        return name.length < 3 || genericNamesSet.has(name.toLowerCase().trim());
      }

      function getContextualName(el: Element, baseName: string): string {
        if (!isGeneric(baseName)) return baseName;
        let container: Element | null = el.parentElement;
        for (let depth = 0; depth < 6 && container; depth++) {
          const heading = container.querySelector(
            'h1, h2, h3, h4, strong, b, [class*="title"], [class*="name"], [class*="heading"]'
          );
          const contextText =
            container.getAttribute('data-name') ??
            container.getAttribute('data-provider') ??
            container.getAttribute('data-title') ??
            container.getAttribute('aria-label') ??
            heading?.textContent?.trim() ??
            '';
          if (contextText.length > 2 && contextText.length < 80 && !isGeneric(contextText)) {
            return `${contextText}: ${baseName}`;
          }
          container = container.parentElement;
        }
        return baseName;
      }

      const results: any[] = [];
      const seen = new Set<string>();

      // Shadow DOM: pierce all shadow roots recursively
      function queryShadowAll(selector: string, root: any): any[] {
        const found: any[] = Array.from(root.querySelectorAll(selector));
        for (const el of Array.from(root.querySelectorAll('*')) as any[]) {
          if (el.shadowRoot) found.push(...queryShadowAll(selector, el.shadowRoot));
        }
        return found;
      }

      const candidates = queryShadowAll(
        'a, button, input, select, textarea, [role], [data-testid], [title], [aria-label], [onclick]',
        document
      );

      const MAX_ELEMENTS = 200;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      for (const el of candidates) {
        if (results.length >= MAX_ELEMENTS) break;
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();

        if (rect.width < 5 || rect.height < 5) continue;
        if (rect.top < 0 || rect.left < 0) continue;
        if (rect.left >= viewportWidth || rect.top >= viewportHeight) continue;

        const rawName =
          htmlEl.getAttribute('aria-label') ||
          htmlEl.getAttribute('title') ||
          htmlEl.getAttribute('data-testid') ||
          htmlEl.getAttribute('placeholder') ||
          htmlEl.textContent?.trim().slice(0, 80) ||
          '';

        if (!rawName) continue;

        // Apply contextual naming: prefix with parent context for generic names
        const name = getContextualName(el, rawName);

        const key = `${name}|${Math.round(rect.x)}|${Math.round(rect.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          tag: htmlEl.tagName.toLowerCase(),
          role: htmlEl.getAttribute('role') || htmlEl.tagName.toLowerCase(),
          name,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }

      return results;
    }, { genericNames: genericNamesArray });

    return rawElements.map((el: any) => ({
      id: counter.n++,
      role: el.role,
      name: el.name,
      boundingClientRect: { x: el.x, y: el.y, width: el.width, height: el.height },
    }));
  }

  // ─── Private: targeted form-element query (always-on fallback) ────────────

  /**
   * Queries for visible form inputs that the AOM may have missed
   * (e.g. CSS-styled components, shadow-DOM-adjacent inputs, hidden-then-visible fields).
   * Only runs when no textbox/combobox/spinbutton was found via AOM.
   */
  private async parseFormElements(counter: { n: number }): Promise<UIElement[]> {
    const rawElements = await this.page.evaluate(() => {
      const results: any[] = [];
      const seen = new Set<string>();

      // Shadow DOM: pierce all shadow roots recursively
      function queryShadowAll(selector: string, root: any): any[] {
        const found: any[] = Array.from(root.querySelectorAll(selector));
        for (const el of Array.from(root.querySelectorAll('*')) as any[]) {
          if (el.shadowRoot) found.push(...queryShadowAll(selector, el.shadowRoot));
        }
        return found;
      }

      const candidates = queryShadowAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]),' +
        'select, textarea, [role="radio"], [role="checkbox"], [role="option"]',
        document
      );

      for (const el of candidates) {
        const htmlEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const rect = htmlEl.getBoundingClientRect();
        // Allow small elements (hidden radios can be 1×1) but skip truly zero-size
        if (rect.width === 0 && rect.height === 0) continue;

        const name =
          htmlEl.getAttribute('aria-label') ||
          htmlEl.getAttribute('placeholder') ||
          htmlEl.getAttribute('name') ||
          htmlEl.getAttribute('id') ||
          (htmlEl.labels && htmlEl.labels[0]?.textContent?.trim()) ||
          '';

        if (!name) continue;
        const key = `${name}|${Math.round(rect.x)}|${Math.round(rect.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Normalise type → semantic role
        const inputType = (htmlEl as HTMLInputElement).type ?? '';
        const roleAttr = htmlEl.getAttribute('role') ?? '';
        let role =
          roleAttr ||
          (inputType === 'radio' ? 'radio' :
           inputType === 'checkbox' ? 'checkbox' :
           inputType === 'email' || inputType === 'text' || inputType === 'password' || inputType === 'tel' ? 'textbox' :
           inputType === 'number' ? 'spinbutton' :
           inputType === 'search' ? 'searchbox' :
           htmlEl.tagName.toLowerCase() === 'select' ? 'combobox' :
           htmlEl.tagName.toLowerCase() === 'textarea' ? 'textbox' :
           'textbox');

        results.push({
          role,
          name,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }
      return results;
    });

    return rawElements.map((el: any) => ({
      id: counter.n++,
      role: el.role,
      name: el.name,
      boundingClientRect: { x: el.x, y: el.y, width: el.width, height: el.height },
    }));
  }

  // ─── Private: iframe element collection ──────────────────────────────────

  /**
   * Enumerates all non-main, same-origin frames and collects their interactive
   * elements. Coordinates are offset by the iframe's bounding rect so they map
   * to the main-page coordinate space. Cross-origin frames are skipped silently.
   */
  private async parseFrameElements(counter: { n: number }): Promise<UIElement[]> {
    const mainFrame = this.page.mainFrame();
    const result: UIElement[] = [];

    for (const frame of this.page.frames()) {
      if (frame === mainFrame) continue;

      try {
        const iframeEl = await frame.frameElement();
        if (!iframeEl) continue;
        const iframeRect = await iframeEl.boundingBox();
        if (!iframeRect || iframeRect.width < 1 || iframeRect.height < 1) continue;

        const rawElements = await frame.evaluate(() => {
          const results: any[] = [];
          const seen = new Set<string>();
          const candidates = Array.from(document.querySelectorAll(
            'a, button, input:not([type="hidden"]), select, textarea, [role], [aria-label], [data-testid]'
          ));
          const vw = window.innerWidth;
          const vh = window.innerHeight;

          for (const el of candidates) {
            const htmlEl = el as HTMLElement;
            const rect = htmlEl.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) continue;
            if (rect.left >= vw || rect.top >= vh) continue;

            const name =
              htmlEl.getAttribute('aria-label') ||
              htmlEl.getAttribute('title') ||
              htmlEl.getAttribute('data-testid') ||
              htmlEl.getAttribute('placeholder') ||
              (htmlEl.textContent?.trim().slice(0, 80) ?? '') ||
              '';

            if (!name) continue;
            const key = `${name}|${Math.round(rect.x)}|${Math.round(rect.y)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            results.push({
              role: htmlEl.getAttribute('role') || htmlEl.tagName.toLowerCase(),
              name,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            });
          }
          return results;
        });

        for (const el of rawElements) {
          result.push({
            id: counter.n++,
            role: el.role,
            name: `[frame] ${el.name}`,
            boundingClientRect: {
              x: el.x + iframeRect.x,
              y: el.y + iframeRect.y,
              width: el.width,
              height: el.height,
            },
          });
        }
      } catch {
        // Cross-origin iframe or detached frame — skip silently
      }
    }

    return result;
  }

  // ─── Private: DOM context enrichment for generic AOM names ───────────────

  /**
   * For elements whose AOM name is still generic (e.g. "Tarif auswählen"),
   * use elementFromPoint to locate the real DOM node and walk up the tree
   * looking for a meaningful sibling-branch heading (e.g. the provider name
   * in a card h4 that is not a direct ancestor of the button).
   *
   * This runs as a targeted pass — only for elements that need it — so the
   * performance impact is minimal.
   */
  private async enrichWithDOMContext(elements: UIElement[]): Promise<void> {
    const genericNamesArray = [...GENERIC_NAMES];

    const items = elements.map(e => ({
      id: e.id,
      x: e.boundingClientRect.x + e.boundingClientRect.width / 2,
      y: e.boundingClientRect.y + e.boundingClientRect.height / 2,
    }));

    const results: { id: number; context: string }[] = await this.page.evaluate(
      ({ items, genericNames }: {
        items: { id: number; x: number; y: number }[];
        genericNames: string[];
      }) => {
        const genericSet = new Set(genericNames);
        function isGeneric(name: string): boolean {
          return name.length < 3 || genericSet.has(name.toLowerCase().trim());
        }

        return items.map(({ id, x, y }) => {
          // CDP box-model coordinates are in layout (document) space;
          // elementFromPoint expects viewport-relative coords.
          const el = document.elementFromPoint(x - window.scrollX, y - window.scrollY);
          if (!el) return { id, context: '' };

          let container: Element | null = el.parentElement;
          for (let depth = 0; depth < 8 && container; depth++) {
            // Data attributes are the most explicit signal — use as-is
            const dataContext =
              container.getAttribute('data-name') ??
              container.getAttribute('data-provider') ??
              container.getAttribute('data-title') ??
              container.getAttribute('aria-label') ??
              '';
            if (dataContext.length > 2 && dataContext.length < 80 && !isGeneric(dataContext)) {
              return { id, context: dataContext };
            }

            // img[alt] is often the brand/provider name in card UIs (logos).
            // Skip hidden images and alts that look like file descriptions.
            const imgAlt = (() => {
              for (const img of Array.from(container.querySelectorAll('img[alt]'))) {
                const el = img as HTMLImageElement;
                if (el.offsetParent === null) continue;
                const alt = el.alt.replace(/\s+/g, ' ').trim();
                if (
                  alt.length > 1 && alt.length < 60 &&
                  !isGeneric(alt) &&
                  !/[/\\]|icon|logo|check|image|photo|pic|banner|avatar/i.test(alt)
                ) return alt;
              }
              return '';
            })();

            // Only consider visible headings — querySelector also matches elements
            // inside hidden popovers/modals (display:none) which would produce
            // wrong context. offsetParent === null for any display:none element.
            const heading = Array.from(
              container.querySelectorAll('h1, h2, h3, h4, strong, b')
            ).find(h => (h as HTMLElement).offsetParent !== null) ?? null;
            const headingText = heading?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

            // Collect up to 2 short, non-generic p texts that add new information.
            // Skip hidden elements (inside popovers, modals, tooltips).
            const extraParts: string[] = [];
            for (const p of Array.from(container.querySelectorAll('p'))) {
              if ((p as HTMLElement).offsetParent === null) continue;
              const t = p.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (
                t.length > 2 && t.length < 60 &&
                !isGeneric(t) &&
                t !== headingText &&
                !headingText.includes(t)
              ) {
                extraParts.push(t);
                if (extraParts.length >= 2) break;
              }
            }

            // Collect short leaf-span/leaf-div texts (badges, labels, tags).
            // Only visible leaf elements (no child elements).
            for (const node of Array.from(container.querySelectorAll('span, div'))) {
              if (node.children.length > 0) continue;
              if ((node as HTMLElement).offsetParent === null) continue;
              const t = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (
                t.length > 2 && t.length < 35 &&
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
              return { id, context: contextText };
            }

            container = container.parentElement;
          }
          return { id, context: '' };
        });
      },
      { items, genericNames: genericNamesArray }
    );

    const contextMap = new Map(results.map(r => [r.id, r.context]));
    for (const el of elements) {
      const context = contextMap.get(el.id);
      if (context) el.name = `${context}: ${el.name}`;
    }
  }

  // ─── Private: AOM helpers ─────────────────────────────────────────────────

  private isInteractive(node: any): boolean {
    const interactiveRoles = [
      'button', 'link', 'textbox', 'checkbox', 'combobox',
      'listbox', 'menuitem', 'radio', 'searchbox', 'slider',
      'spinbutton', 'switch', 'tab', 'treeitem',
      'listitem', 'option', 'row', 'gridcell',
      'menuitemcheckbox', 'menuitemradio', 'columnheader',
    ];
    return interactiveRoles.includes(node.role?.value) && !node.ignored;
  }

  /**
   * Extracts all visible text from the AOM subtree of a node (walks DOWN).
   * Returns a compact string (max 120 chars).
   */
  private extractSubtreeText(
    nodeId: string,
    nodeMap: Map<string, any>,
    childrenMap: Map<string, string[]>,
    depth = 0
  ): string {
    if (depth > 6) return '';
    const children = childrenMap.get(nodeId) || [];
    const parts: string[] = [];

    for (const childId of children) {
      const child = nodeMap.get(childId);
      if (!child || child.ignored) continue;
      const childName = child.name?.value?.trim();
      if (childName) {
        parts.push(childName);
      } else {
        const deeper = this.extractSubtreeText(childId, nodeMap, childrenMap, depth + 1);
        if (deeper) parts.push(deeper);
      }
    }

    return parts.join(' ').slice(0, 120);
  }

  /**
   * Walks UP the AOM tree to find the nearest ancestor with a meaningful,
   * non-generic name. Used to prefix generic button labels with context
   * (e.g. "Kelag: Tarif auswählen" instead of "Tarif auswählen").
   */
  private findAncestorContext(
    nodeId: string,
    parentMap: Map<string, string>,
    nodeMap: Map<string, any>,
    maxDepth = 6
  ): string {
    let currentId = parentMap.get(nodeId);
    for (let i = 0; i < maxDepth; i++) {
      if (!currentId) break;
      const parent = nodeMap.get(currentId);
      if (!parent || parent.ignored) {
        currentId = parentMap.get(currentId);
        continue;
      }
      const parentName = (parent.name?.value ?? '').trim();
      if (
        parentName &&
        parentName.length > 2 &&
        parentName.length < 80 &&
        !isGenericName(parentName)
      ) {
        return parentName;
      }
      currentId = parentMap.get(currentId);
    }
    return '';
  }

  private nodeToUIElement(
    node: any,
    subtextContext: string,
    parentMap: Map<string, string>,
    nodeMap: Map<string, any>,
    counter: { n: number }
  ): UIElement | null {
    const role = node.role?.value || 'unknown';
    const name = node.name?.value || '';
    const description = node.description?.value || '';

    // Priority: name → description → subtree text
    let effectiveName = name || description || subtextContext;

    // Skip completely nameless elements unless they are a textbox (always useful)
    if (!effectiveName && role !== 'textbox') return null;

    // ── Contextual naming ──────────────────────────────────────────────────
    // If the element's name is generic (e.g. "Tarif auswählen"), walk up the
    // AOM tree to find a meaningful ancestor name and prepend it as context.
    if (effectiveName && isGenericName(effectiveName)) {
      const ancestorContext = this.findAncestorContext(node.nodeId, parentMap, nodeMap);
      if (ancestorContext) {
        effectiveName = `${ancestorContext}: ${effectiveName}`;
      }
    }

    const state: NonNullable<UIElement['state']> = {};
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === 'disabled') state.disabled = prop.value.value;
        if (prop.name === 'hidden')   state.hidden   = prop.value.value;
        if (prop.name === 'focused')  state.focused  = prop.value.value;
        if (prop.name === 'checked')  state.checked  = prop.value.value;
      }
    }

    return {
      id: counter.n++,
      role,
      name: effectiveName,
      description: description || (name ? subtextContext : ''),
      boundingClientRect: { x: 0, y: 0, width: 0, height: 0 },
      state,
    };
  }
}
