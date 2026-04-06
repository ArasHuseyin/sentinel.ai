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

export class StateParser {
  private elementCounter = 0;
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

    this.elementCounter = 0;
    const { nodes } = await this.cdp.send('Accessibility.getFullAXTree');

    // Build node maps for subtree text extraction
    const nodeMap = new Map<string, any>();
    const childrenMap = new Map<string, string[]>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
      if (node.childIds?.length) {
        childrenMap.set(node.nodeId, node.childIds);
      }
    }

    // Step 1: Filter interactive nodes synchronously (no I/O)
    const interactiveNodes = nodes.filter(
      (node: any) => this.isInteractive(node) && node.backendDOMNodeId
    );

    // Step 2: Fire ALL getBoxModel requests in parallel
    const boxModelResults = await Promise.allSettled(
      interactiveNodes.map((node: any) =>
        this.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })
      )
    );

    // Step 3: Build UIElement list from results
    const uiElements: UIElement[] = [];
    for (let i = 0; i < interactiveNodes.length; i++) {
      const node = interactiveNodes[i];
      const result = boxModelResults[i];

      if (!result || result.status === 'rejected') continue;

      const fulfilled = result as PromiseFulfilledResult<any>;
      const { model } = fulfilled.value;
      if (!model?.content || model.content.length < 8) continue;

      const subtextContext = node?.nodeId ? this.extractSubtreeText(node.nodeId, nodeMap, childrenMap) : '';
      const element = this.nodeToUIElement(node, subtextContext);
      if (!element) continue;

      const x = model.content[0]!;
      const y = model.content[1]!;
      const width = model.content[2]! - model.content[0]!;
      const height = model.content[7]! - model.content[1]!;

      element.boundingClientRect = { x, y, width, height };
      uiElements.push(element);
    }

    // DOM-Snapshot als Fallback wenn AOM zu wenige Elemente liefert (z.B. SPAs wie WhatsApp)
    if (uiElements.length < 5) {
      const domElements = await this.parseDOMSnapshot();
      const existingNames = new Set(uiElements.map(e => e.name));
      for (const el of domElements) {
        if (!existingNames.has(el.name)) {
          uiElements.push(el);
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

  private async parseDOMSnapshot(): Promise<UIElement[]> {
    const rawElements = await this.page.evaluate(() => {
      const results: any[] = [];
      const seen = new Set<string>();

      const candidates = Array.from(document.querySelectorAll(
        'a, button, input, select, textarea, [role], [data-testid], [title], [aria-label], [onclick]'
      ));

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

        const name =
          htmlEl.getAttribute('aria-label') ||
          htmlEl.getAttribute('title') ||
          htmlEl.getAttribute('data-testid') ||
          htmlEl.getAttribute('placeholder') ||
          htmlEl.textContent?.trim().slice(0, 80) ||
          '';

        if (!name) continue;

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
    });

    return rawElements.map((el: any) => ({
      id: this.elementCounter++,
      role: el.role,
      name: el.name,
      boundingClientRect: { x: el.x, y: el.y, width: el.width, height: el.height },
    }));
  }

  private isInteractive(node: any): boolean {
    const interactiveRoles = [
      // Standard form controls
      'button', 'link', 'textbox', 'checkbox', 'combobox',
      'listbox', 'menuitem', 'radio', 'searchbox', 'slider',
      'spinbutton', 'switch', 'tab', 'treeitem',
      // List-based UI (e.g. WhatsApp chat list items, dropdowns)
      'listitem', 'option', 'row', 'gridcell',
      // Custom interactive containers often used in SPAs
      'menuitemcheckbox', 'menuitemradio', 'columnheader',
    ];
    return interactiveRoles.includes(node.role?.value) && !node.ignored;
  }

  /**
   * Extracts all visible text from the AOM subtree of a node.
   * Generic – works for headings, paragraphs, spans, icons, etc.
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

  // Made synchronous – no async needed, no await inside
  private nodeToUIElement(node: any, subtextContext = ''): UIElement | null {
    const role = node.role?.value || 'unknown';
    const name = node.name?.value || '';
    const description = node.description?.value || '';

    // Priority: name → description → subtree text
    const effectiveName = name || description || subtextContext;

    // Skip completely nameless elements unless they are a textbox (always useful)
    if (!effectiveName && role !== 'textbox') return null;

    const state: NonNullable<UIElement['state']> = {};
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === 'disabled') state.disabled = prop.value.value;
        if (prop.name === 'hidden') state.hidden = prop.value.value;
        if (prop.name === 'focused') state.focused = prop.value.value;
        if (prop.name === 'checked') state.checked = prop.value.value;
      }
    }

    return {
      id: this.elementCounter++,
      role,
      name: effectiveName,
      description: description || (name ? subtextContext : ''),
      boundingClientRect: { x: 0, y: 0, width: 0, height: 0 },
      state,
    };
  }
}
