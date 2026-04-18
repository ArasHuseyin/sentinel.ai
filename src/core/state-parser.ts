import type { CDPSession, Frame, Page } from 'playwright';
import { computeFingerprintsBrowserSide } from './pattern-signature-browser.js';
import type { PatternFingerprint } from './pattern-signature.js';

export type PageRegion = 'header' | 'nav' | 'sidebar' | 'main' | 'footer' | 'modal' | 'popup';

/** Roles whose current input value should be tracked. */
const VALUE_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'listbox', 'slider']);

export interface UIElement {
  id: number;
  role: string;
  name: string;
  description?: string;
  region?: PageRegion;
  /** Current value of input/select/combobox elements. Only set for form fields. */
  value?: string;
  /** Validation error message from the form (aria-invalid, nearby error elements). */
  error?: string;
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
  /**
   * Opaque frame identifier. Present only when the element lives inside an
   * iframe; absent for top-level document elements. Use
   * `StateParser.getFrame(frameId)` to resolve the Playwright `Frame` object
   * for cross-frame action routing.
   */
  frameId?: string;
  /** URL of the frame's document. Diagnostic hint for the LLM / logs. */
  frameUrl?: string;
}

export interface SimplifiedState {
  url: string;
  title: string;
  elements: UIElement[];
}

const STATE_CACHE_TTL_MS = 2000;

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

/** Dedup key: name + position (rounded to 50px grid to tolerate layout shifts). */
function dedupKey(el: UIElement): string {
  const gx = Math.round(el.boundingClientRect.x / 50) * 50;
  const gy = Math.round(el.boundingClientRect.y / 50) * 50;
  return `${el.name}|${gx}|${gy}`;
}

/** AOM roles that represent form inputs — used for the always-on fallback check */
const FORM_INPUT_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'searchbox']);

export class StateParser {
  private cachedState: SimplifiedState | null = null;
  private cacheTimestamp = 0;
  /**
   * Frame registry populated during each `parse()` cycle. Maps opaque
   * `frameId` strings to live Playwright `Frame` objects so that
   * `ActionEngine` can route actions into the correct context when the
   * selected element lives inside an `<iframe>`. The map is cleared and
   * repopulated every parse — entries are short-lived and must be resolved
   * immediately after parsing, not reused across navigations.
   */
  private frameRegistry = new Map<string, Frame>();

  constructor(private page: Page, private cdp: CDPSession) {}

  invalidateCache() {
    this.cachedState = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Resolves a `frameId` produced by the parser back to its Playwright
   * `Frame` object. Returns `undefined` if the registry is stale or the
   * frame has been detached since the last parse.
   */
  getFrame(frameId: string): Frame | undefined {
    return this.frameRegistry.get(frameId);
  }

  /**
   * Computes a three-layer widget fingerprint for each target position
   * in a single browser round-trip. Fingerprints are looked up in the
   * `PatternCache` to decide whether an LLM call can be skipped.
   *
   * Positions come from each `UIElement.boundingClientRect` centroid.
   * Targets whose `elementFromPoint(x,y)` resolves to nothing are
   * silently dropped from the returned map.
   *
   * Returns a Map keyed by the caller-supplied `id` for fast lookup
   * against the original `UIElement.id`.
   */
  async computeTargetFingerprints(
    targets: Array<{ id: number; x: number; y: number }>
  ): Promise<Map<number, PatternFingerprint>> {
    if (targets.length === 0) return new Map();
    const raw = await this.page.evaluate(computeFingerprintsBrowserSide, targets)
      .catch(() => ({} as Record<number, PatternFingerprint>));
    const out = new Map<number, PatternFingerprint>();
    for (const [k, v] of Object.entries(raw)) {
      out.set(Number(k), v);
    }
    return out;
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

      // Skip zero/tiny AOM elements — hidden dropdown containers, collapsed panels, etc.
      if (width < 2 || height < 2) continue;

      element.boundingClientRect = { x, y, width, height };
      uiElements.push(element);
    }

    // ─── DOM Fallback 1: sparse or off-screen AOM ─────────────────────────
    // Full DOM snapshot when AOM yields too few elements OR when all AOM
    // elements are outside the visible viewport (React SPAs with custom
    // components that use tabindex="-1" or CSS-hidden form controls).
    const viewport = this.page.viewportSize?.() ?? { width: 1920, height: 1080 };
    const scrollPos = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      .catch(() => ({ x: 0, y: 0 }));
    const sx = scrollPos?.x ?? 0;
    const sy = scrollPos?.y ?? 0;

    const visibleAOM = uiElements.filter(e => {
      const vpX = (e.boundingClientRect.x + e.boundingClientRect.width / 2) - sx;
      const vpY = (e.boundingClientRect.y + e.boundingClientRect.height / 2) - sy;
      return vpX >= 0 && vpY >= 0 && vpX <= viewport.width && vpY <= viewport.height;
    });
    const needsDOMFallback = uiElements.length < 5 || visibleAOM.length === 0;

    if (needsDOMFallback) {
      const domElements = await this.parseDOMSnapshot(counter);
      const existingKeys = new Set(uiElements.map(e => dedupKey(e)));
      for (const el of domElements) {
        const key = dedupKey(el);
        if (!existingKeys.has(key)) {
          uiElements.push(el);
          existingKeys.add(key);
        }
      }
    }

    // ─── Parallel element discovery ────────────────────────────────────────
    // Form inputs, contenteditable divs, and iframe elements are all
    // independent queries — run them concurrently to cut parse latency.
    const hasFormInputs = uiElements.some(e => FORM_INPUT_ROLES.has(e.role));
    const [formElements, editableElements, frameElements] = await Promise.all([
      hasFormInputs ? Promise.resolve([]) : this.parseFormElements(counter),
      this.parseContentEditableElements(counter),
      this.parseFrameElements(counter),
    ]);

    // Merge discovered elements, deduplicating by name + position
    const existingKeys = new Set(uiElements.map(e => dedupKey(e)));
    for (const el of formElements) {
      const key = dedupKey(el);
      if (el.name && !existingKeys.has(key)) {
        uiElements.push(el);
        existingKeys.add(key);
      }
    }
    for (const el of editableElements) {
      const key = dedupKey(el);
      if (el.name && !existingKeys.has(key)) {
        uiElements.push(el);
        existingKeys.add(key);
      }
    }
    for (const el of frameElements) {
      const key = dedupKey(el);
      if (!existingKeys.has(key)) {
        uiElements.push(el);
        existingKeys.add(key);
      }
    }

    // ─── Widget pattern detection ──────────────────────────────────────────
    // Scan the DOM for composite widgets (button+combobox, button+listbox,
    // CSS-class library widgets) that individual element detection misses.
    // Widgets REPLACE overlapping plain elements (better semantic info).
    const widgetElements = await this.parseWidgetPatterns(counter);
    if (widgetElements.length > 0) {
      const wKeys = new Map(uiElements.map((e, i) => [dedupKey(e), i]));
      for (const el of widgetElements) {
        const key = dedupKey(el);
        const existingIdx = wKeys.get(key);
        if (existingIdx !== undefined) {
          uiElements[existingIdx] = el;
        } else {
          uiElements.push(el);
          wKeys.set(key, uiElements.length - 1);
        }
      }
    }

    // ─── DOM Enrichment + Spatial regions (single evaluate) ────────────────
    // Enrich generic names AND assign regions in one browser round-trip.
    await this.enrichAndDetectRegions(uiElements);

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
        'a, button, input, select, textarea, [role], [data-testid], [title], [aria-label], [onclick], [contenteditable="true"], [contenteditable=""], [tabindex]',
        document
      );

      const MAX_ELEMENTS = 200;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      // Convert viewport-relative getBoundingClientRect to document-space
      const sx = window.scrollX;
      const sy = window.scrollY;

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
          htmlEl.getAttribute('data-placeholder') ||
          htmlEl.getAttribute('aria-placeholder') ||
          htmlEl.textContent?.trim().slice(0, 80) ||
          '';

        if (!rawName) continue;

        // Apply contextual naming: prefix with parent context for generic names
        const name = getContextualName(el, rawName);

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          tag: htmlEl.tagName.toLowerCase(),
          role: htmlEl.getAttribute('role') || htmlEl.tagName.toLowerCase(),
          name,
          x: rect.x + sx,
          y: rect.y + sy,
          width: rect.width,
          height: rect.height,
        });
      }

      // Phase 2: Heuristic detection for custom React/Vue/Angular components
      // that have no ARIA attributes but ARE interactive (cursor: pointer)
      if (results.length < MAX_ELEMENTS) {
        const interactiveEls = queryShadowAll('div[class], span[class]', document);
        for (const el of interactiveEls) {
          if (results.length >= MAX_ELEMENTS) break;
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          if (rect.top < 0 || rect.left < 0) continue;
          if (rect.left >= viewportWidth || rect.top >= viewportHeight) continue;
          const style = window.getComputedStyle(htmlEl);
          if (style.cursor !== 'pointer') continue;
          // Skip wrappers that contain real interactive children
          if (htmlEl.querySelector('a, button, input, select, textarea')) continue;

          const rawName =
            htmlEl.getAttribute('aria-label') ||
            htmlEl.getAttribute('title') ||
            htmlEl.getAttribute('data-testid') ||
            htmlEl.textContent?.trim().slice(0, 80) ||
            '';
          if (!rawName) continue;

          const name = getContextualName(el, rawName);
          const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            tag: htmlEl.tagName.toLowerCase(),
            role: 'button', // interactive div with cursor:pointer behaves as button
            name,
            x: rect.x + sx, y: rect.y + sy,
            width: rect.width, height: rect.height,
          });
        }
      }

      return results;
    }, { genericNames: genericNamesArray });

    return rawElements.map((el: any) => ({
      id: counter.n++,
      role: el.role,
      name: el.name,
      ...(el.value ? { value: el.value } : {}),
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
        'select, textarea, [role="radio"], [role="checkbox"], [role="option"],' +
        '[contenteditable="true"], [contenteditable=""]',
        document
      );

      const sx = window.scrollX;
      const sy = window.scrollY;

      for (const el of candidates) {
        const htmlEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const rect = htmlEl.getBoundingClientRect();
        // Allow small elements (hidden radios can be 1×1) but skip truly zero-size
        if (rect.width === 0 && rect.height === 0) continue;

        const name =
          htmlEl.getAttribute('aria-label') ||
          htmlEl.getAttribute('placeholder') ||
          htmlEl.getAttribute('data-placeholder') ||
          htmlEl.getAttribute('name') ||
          htmlEl.getAttribute('id') ||
          (htmlEl.labels && htmlEl.labels[0]?.textContent?.trim()) ||
          '';

        if (!name) continue;
        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Normalise type → semantic role
        const inputType = (htmlEl as HTMLInputElement).type ?? '';
        const roleAttr = htmlEl.getAttribute('role') ?? '';
        let role =
          roleAttr ||
          (inputType === 'radio' ? 'radio' :
           inputType === 'checkbox' ? 'checkbox' :
           inputType === 'range' ? 'slider' :
           inputType === 'file' ? 'file' :
           inputType === 'email' || inputType === 'text' || inputType === 'password' || inputType === 'tel' ? 'textbox' :
           inputType === 'number' ? 'spinbutton' :
           inputType === 'search' ? 'searchbox' :
           htmlEl.tagName.toLowerCase() === 'select' ? 'combobox' :
           htmlEl.tagName.toLowerCase() === 'textarea' ? 'textbox' :
           'textbox');

        // Track current input value
        const value = (htmlEl as HTMLInputElement).value ?? '';

        results.push({
          role,
          name,
          value: value || undefined,
          x: rect.x + sx,
          y: rect.y + sy,
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
      ...(el.value ? { value: el.value } : {}),
      boundingClientRect: { x: el.x, y: el.y, width: el.width, height: el.height },
    }));
  }

  // ─── Private: contenteditable element detection ──────────────────────────

  /**
   * Queries for contenteditable elements that the AOM may have missed.
   * Runs unconditionally — modern web apps almost always use contenteditable
   * for rich text input (chat messages, email compose, document editing).
   */
  private async parseContentEditableElements(counter: { n: number }): Promise<UIElement[]> {
    const rawElements = await this.page.evaluate(() => {
      const results: any[] = [];
      const seen = new Set<string>();

      function queryShadowAll(selector: string, root: any): any[] {
        const found: any[] = Array.from(root.querySelectorAll(selector));
        for (const el of Array.from(root.querySelectorAll('*')) as any[]) {
          if (el.shadowRoot) found.push(...queryShadowAll(selector, el.shadowRoot));
        }
        return found;
      }

      const candidates = queryShadowAll(
        '[contenteditable="true"], [contenteditable=""]',
        document
      );

      const sx = window.scrollX;
      const sy = window.scrollY;

      for (const el of candidates) {
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const name =
          htmlEl.getAttribute('aria-label') ||
          htmlEl.getAttribute('aria-placeholder') ||
          htmlEl.getAttribute('data-placeholder') ||
          htmlEl.getAttribute('placeholder') ||
          htmlEl.getAttribute('title') ||
          htmlEl.getAttribute('id') ||
          'editor';

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: 'textbox',
          name,
          x: rect.x + sx,
          y: rect.y + sy,
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
      ...(el.value ? { value: el.value } : {}),
      boundingClientRect: { x: el.x, y: el.y, width: el.width, height: el.height },
    }));
  }

  // ─── Private: iframe element collection ──────────────────────────────────

  /**
   * Enumerates all non-main, same-origin frames and collects their interactive
   * elements. Coordinates are offset by the iframe's bounding rect so they map
   * to the main-page coordinate space. Cross-origin frames are skipped silently.
   */
  // ─── Private: widget pattern detection ───────────────────────────────

  /**
   * Scans the visible DOM for composite widget patterns that individual
   * element queries miss. Custom dropdown/select/autocomplete components
   * typically consist of a trigger button + hidden combobox input + listbox.
   * This method detects these patterns and returns one UIElement per widget.
   *
   * Patterns detected:
   *  - button + input[role="combobox"]  → dropdown with search
   *  - button + [role="listbox"]        → select dropdown
   *  - [aria-haspopup] buttons          → menu/dropdown triggers
   *  - label + associated hidden input  → labeled form field
   */
  private async parseWidgetPatterns(counter: { n: number }): Promise<UIElement[]> {
    const rawWidgets = await this.page.evaluate(() => {
      const results: any[] = [];
      const seen = new Set<string>();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Convert viewport-relative coords to document-space
      const sx = window.scrollX;
      const sy = window.scrollY;

      // Shadow DOM: pierce all shadow roots recursively so widgets rendered
      // inside Web Components (Lit, Polymer, Stencil) are discovered too.
      function queryShadowAll(selector: string, root: Document | ShadowRoot | Element): Element[] {
        const found: Element[] = [];
        // Only Document/Element have querySelectorAll on the root itself; all three have descendant query.
        found.push(...Array.from((root as Element).querySelectorAll?.(selector) ?? []));
        for (const el of Array.from((root as Element).querySelectorAll?.('*') ?? []) as Element[]) {
          const sr = (el as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot;
          if (sr) found.push(...queryShadowAll(selector, sr));
        }
        return found;
      }
      // label[for=ID] lookups must stay within the element's own tree scope —
      // IDs are shadow-root-scoped, so a document-level lookup returns nothing
      // (or the wrong label) for shadow-hosted inputs.
      function findLabelFor(el: Element): HTMLElement | null {
        const id = (el as HTMLElement).id;
        if (!id) return null;
        const root = el.getRootNode() as Document | ShadowRoot;
        return (root.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null) ?? null;
      }

      // Pattern 1: Container with button + combobox/listbox (custom dropdowns)
      // Look for containers that have both a trigger button and a combobox input
      const comboboxInputs = queryShadowAll('input[role="combobox"], [role="listbox"]', document);
      for (const input of Array.from(comboboxInputs)) {
        const container = input.parentElement?.closest('div') ?? input.parentElement;
        if (!container) continue;

        // Find the trigger button in the same container
        const trigger = container.querySelector('button, [role="button"]') as HTMLElement | null;
        if (!trigger) continue;

        // Use trigger button's rect for precise click targeting
        const triggerRect = trigger.getBoundingClientRect();
        const rect = triggerRect.width >= 10 && triggerRect.height >= 10
          ? triggerRect
          : container.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        if (rect.top > vh || rect.left > vw) continue;

        // Get the widget name from multiple sources
        const name =
          // 1. Label element associated via aria-labelledby
          (() => {
            const labelId = input.getAttribute('aria-labelledby');
            if (labelId) {
              const label = document.getElementById(labelId.split(' ')[0]!);
              if (label) return label.textContent?.trim();
            }
            return null;
          })() ||
          // 2. Preceding label element
          (() => {
            const prev = container.previousElementSibling;
            if (prev?.tagName === 'LABEL') return prev.textContent?.trim();
            // Label as first child of parent
            const parentLabel = container.parentElement?.querySelector('label');
            if (parentLabel) return parentLabel.textContent?.trim();
            return null;
          })() ||
          // 3. Button text (the current selection or placeholder)
          trigger.textContent?.trim().slice(0, 80) ||
          // 4. Placeholder from the input
          input.getAttribute('placeholder') ||
          // 5. ID-based name
          input.getAttribute('id')?.replace(/-/g, ' ').replace(/\./g, ' ') ||
          '';

        if (!name) continue;

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Current value: from input.value or the trigger's selected text
        const currentValue = (input as HTMLInputElement).value ||
          trigger.querySelector('.selectedText, [class*="selected"]')?.textContent?.trim() ||
          '';

        results.push({
          role: input.getAttribute('role') === 'listbox' ? 'listbox' : 'combobox',
          name,
          value: currentValue || undefined,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }

      // Pattern 2: Buttons with aria-haspopup (menu/dropdown triggers)
      const popupTriggers = queryShadowAll('button[aria-haspopup], [role="button"][aria-haspopup]', document);
      for (const trigger of Array.from(popupTriggers)) {
        const htmlEl = trigger as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        if (rect.top > vh || rect.left > vw) continue;

        const name = htmlEl.getAttribute('aria-label') ||
          htmlEl.textContent?.trim().slice(0, 80) || '';
        if (!name) continue;

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: 'button',
          name,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }

      // Pattern 3: Labels with associated but hidden/custom inputs
      const labels = queryShadowAll('label[for]', document);
      for (const label of Array.from(labels)) {
        const forId = label.getAttribute('for');
        if (!forId) continue;
        const input = document.getElementById(forId);
        if (!input) continue;

        // Skip if input is already visible and would be found by normal parsing
        const inputRect = input.getBoundingClientRect();
        if (inputRect.width > 5 && inputRect.height > 5) continue;

        // Input is hidden — look for a visible custom widget near the label
        const labelRect = (label as HTMLElement).getBoundingClientRect();
        if (labelRect.width < 5 || labelRect.height < 5) continue;
        if (labelRect.top > vh || labelRect.left > vw) continue;

        // Check the label's parent for a visible interactive element
        const parent = label.parentElement;
        if (!parent) continue;
        const customWidget = parent.querySelector('button, [role="button"], [role="combobox"]') as HTMLElement | null;
        if (!customWidget) continue;

        const widgetRect = customWidget.getBoundingClientRect();
        if (widgetRect.width < 5 || widgetRect.height < 5) continue;

        const name = label.textContent?.trim() || '';
        if (!name) continue;

        const key = `${name}|${Math.round(widgetRect.x + sx)}|${Math.round(widgetRect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: customWidget.getAttribute('role') || 'button',
          name,
          x: widgetRect.x + sx,
          y: widgetRect.y + sy,
          width: widgetRect.width,
          height: widgetRect.height,
        });
      }

      // Pattern 4: input + datalist (native autocomplete)
      const datalistInputs = queryShadowAll('input[list]', document);
      for (const input of Array.from(datalistInputs)) {
        const listId = input.getAttribute('list');
        if (!listId) continue;
        const datalist = document.getElementById(listId);
        if (!datalist || datalist.tagName !== 'DATALIST') continue;

        const htmlEl = input as HTMLInputElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        if (rect.top > vh || rect.left > vw) continue;

        const name =
          htmlEl.getAttribute('aria-label') ||
          htmlEl.getAttribute('placeholder') ||
          (htmlEl.labels?.[0] as HTMLElement)?.textContent?.trim() ||
          htmlEl.getAttribute('name') || '';
        if (!name) continue;

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: 'combobox',
          name,
          value: htmlEl.value || undefined,
          x: rect.x + sx, y: rect.y + sy,
          width: rect.width, height: rect.height,
        });
      }

      // Pattern 5: [role="tablist"] (tab navigation as composite widget)
      const tablists = queryShadowAll('[role="tablist"]', document);
      for (const tablist of Array.from(tablists)) {
        const htmlEl = tablist as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        if (rect.top > vh || rect.left > vw) continue;

        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
        if (tabs.length === 0) continue;
        const activeTab = tabs.find(t => t.getAttribute('aria-selected') === 'true');
        const tabNames = tabs.map(t => (t as HTMLElement).textContent?.trim()).filter(Boolean);

        const name = htmlEl.getAttribute('aria-label') ||
          tabNames.join(' | ').slice(0, 80) || 'tabs';

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: 'tablist',
          name,
          value: activeTab ? (activeTab as HTMLElement).textContent?.trim() : undefined,
          x: rect.x + sx, y: rect.y + sy,
          width: rect.width, height: rect.height,
        });
      }

      // Pattern 6: Date/time picker inputs
      const dateInputs = queryShadowAll(
        'input[type="date"], input[type="time"], input[type="datetime-local"], ' +
        'input[type="month"], input[type="week"]',
        document
      );
      for (const input of Array.from(dateInputs)) {
        const htmlEl = input as HTMLInputElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        if (rect.top > vh || rect.left > vw) continue;

        const name =
          htmlEl.getAttribute('aria-label') ||
          (htmlEl.labels?.[0] as HTMLElement)?.textContent?.trim() ||
          htmlEl.getAttribute('placeholder') ||
          htmlEl.getAttribute('name') || '';
        if (!name) continue;

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: htmlEl.type === 'time' ? 'timepicker' : 'datepicker',
          name,
          value: htmlEl.value || undefined,
          x: rect.x + sx, y: rect.y + sy,
          width: rect.width, height: rect.height,
        });
      }

      // Pattern 7: CSS-class based component library detection
      // Detects custom select/dropdown widgets from popular libraries
      // that may lack proper ARIA roles
      try {
        const librarySelector = [
          '[class*="react-select"][class*="container"]',
          '.ant-select',
          '.ant-picker',
          '.ant-cascader-picker',
          '[class*="MuiSelect-root"]',
          '[class*="MuiAutocomplete-root"]',
          '.ng-select',
          '.select2-container',
          '.chosen-container',
          '.vs__dropdown-toggle',
        ].join(',');

        const libraryWidgets = queryShadowAll(librarySelector, document);
        for (const widget of Array.from(libraryWidgets)) {
          const htmlEl = widget as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          if (rect.top > vh || rect.left > vw) continue;

          // Skip if already has ARIA combobox/listbox (handled by Pattern 1)
          if (htmlEl.querySelector('[role="combobox"], [role="listbox"]')) continue;

          // Resolve name from multiple sources
          const name = (() => {
            // 1. Label via input id
            const inputEl = htmlEl.querySelector('input');
            if (inputEl?.id) {
              const label = findLabelFor(inputEl);
              if (label) return label.textContent?.trim();
            }
            // 2. aria-label on container or input
            const ariaLabel = htmlEl.getAttribute('aria-label') ||
              inputEl?.getAttribute('aria-label');
            if (ariaLabel) return ariaLabel;
            // 3. Preceding label element
            const prev = htmlEl.previousElementSibling;
            if (prev?.tagName === 'LABEL') return (prev as HTMLElement).textContent?.trim();
            // 4. Label in parent (not inside this widget)
            const parentLabel = htmlEl.parentElement?.querySelector('label');
            if (parentLabel && !htmlEl.contains(parentLabel))
              return (parentLabel as HTMLElement).textContent?.trim();
            // 5. Placeholder text (class-based)
            const placeholder = htmlEl.querySelector(
              '[class*="placeholder"], [class*="Placeholder"]'
            );
            if (placeholder) return (placeholder as HTMLElement).textContent?.trim();
            // 6. Input placeholder attribute
            if (inputEl?.placeholder) return inputEl.placeholder;
            return '';
          })() || '';

          if (!name) continue;

          const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Current selected value
          const value = (() => {
            const selected = htmlEl.querySelector(
              '[class*="single-value"], [class*="singleValue"], ' +
              '[class*="selected-value"], [class*="selectedValue"], ' +
              '[class*="selection-item"], [class*="selectionItem"], ' +
              '.ant-select-selection-item, ' +
              '.select2-selection__rendered, ' +
              '.chosen-single span, ' +
              '.ng-value-label'
            );
            if (selected) return (selected as HTMLElement).textContent?.trim();
            const inputEl = htmlEl.querySelector('input') as HTMLInputElement | null;
            return inputEl?.value || '';
          })();

          results.push({
            role: 'combobox',
            name,
            value: value || undefined,
            x: rect.x + sx, y: rect.y + sy,
            width: rect.width, height: rect.height,
          });
        }
      } catch {
        // Complex selectors may throw in edge cases — skip gracefully
      }

      // Pattern 8: Hidden <select> with visible custom trigger
      // Many UI frameworks hide the native <select> and render a custom widget
      const allSelects = queryShadowAll('select', document) as HTMLSelectElement[];
      for (const select of Array.from(allSelects)) {
        const htmlEl = select as HTMLSelectElement;
        const rect = htmlEl.getBoundingClientRect();
        // Only care about HIDDEN selects (visible ones are already detected)
        if (rect.width > 5 && rect.height > 5) continue;

        const container = htmlEl.parentElement;
        if (!container) continue;
        const containerRect = container.getBoundingClientRect();
        if (containerRect.width < 10 || containerRect.height < 10) continue;
        if (containerRect.top > vh || containerRect.left > vw) continue;

        // Must have a visible trigger element
        const trigger = container.querySelector(
          'button, [role="button"], div[tabindex], span[tabindex]'
        ) as HTMLElement | null;
        if (!trigger) continue;
        const triggerRect = trigger.getBoundingClientRect();
        if (triggerRect.width < 5 || triggerRect.height < 5) continue;

        const name =
          htmlEl.getAttribute('aria-label') ||
          (htmlEl.labels?.[0] as HTMLElement)?.textContent?.trim() ||
          htmlEl.getAttribute('name') || '';
        if (!name) continue;

        const key = `${name}|${Math.round(containerRect.x + sx)}|${Math.round(containerRect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const selectedOption = htmlEl.options[htmlEl.selectedIndex];
        results.push({
          role: 'combobox',
          name,
          value: selectedOption?.text || undefined,
          x: containerRect.x + sx, y: containerRect.y + sy,
          width: containerRect.width, height: containerRect.height,
        });
      }

      // Pattern 9: Custom datepicker widgets (CSS-class based)
      // Detects calendar/date picker widgets from popular libraries
      try {
        const datePickerSelector = [
          '.ant-picker',
          '[class*="DatePicker"]',
          '[class*="datepicker"]',
          '[class*="date-picker"]',
          '[class*="MuiDatePicker"]',
          '[class*="react-datepicker"]',
          '[class*="flatpickr"]',
          '[data-testid*="date"]',
          'input[data-date]',
        ].join(',');

        const datePickers = queryShadowAll(datePickerSelector, document);
        for (const picker of Array.from(datePickers)) {
          const htmlEl = picker as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue;
          if (rect.top > vh || rect.left > vw) continue;

          const name = (() => {
            const inputEl = htmlEl.querySelector('input');
            if (inputEl?.id) {
              const label = findLabelFor(inputEl);
              if (label) return label.textContent?.trim();
            }
            return htmlEl.getAttribute('aria-label') ||
              htmlEl.querySelector('input')?.getAttribute('placeholder') ||
              htmlEl.querySelector('input')?.getAttribute('aria-label') ||
              '';
          })() || '';

          if (!name) continue;

          const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const value = (htmlEl.querySelector('input') as HTMLInputElement)?.value || '';

          results.push({
            role: 'datepicker',
            name,
            value: value || undefined,
            x: rect.x + sx, y: rect.y + sy,
            width: rect.width, height: rect.height,
          });
        }
      } catch {
        // datepicker selector may fail on some pages
      }

      return results;
    }).catch(() => []);

    return rawWidgets.map((el: any) => ({
      id: counter.n++,
      role: el.role,
      name: el.name,
      ...(el.value ? { value: el.value } : {}),
      boundingClientRect: { x: el.x, y: el.y, width: el.width, height: el.height },
    }));
  }

  private async parseFrameElements(counter: { n: number }): Promise<UIElement[]> {
    const mainFrame = this.page.mainFrame();
    const result: UIElement[] = [];
    // Fresh registry per parse — stale Frame handles would risk routing
    // actions into detached contexts after navigation.
    this.frameRegistry.clear();
    let frameIndex = 0;

    for (const frame of this.page.frames()) {
      if (frame === mainFrame) continue;

      // Pre-evaluation checks that silently skip in normal cases (detached
      // frame, zero-size iframe) are kept outside the try/catch so they
      // don't trigger the cross-origin warning.
      let iframeEl, iframeRect, frameUrl = '(unknown)';
      try {
        iframeEl = await frame.frameElement();
        if (!iframeEl) continue;
        iframeRect = await iframeEl.boundingBox();
        if (!iframeRect || iframeRect.width < 1 || iframeRect.height < 1) continue;
        frameUrl = frame.url();
      } catch {
        // frameElement() / boundingBox() failed — frame is likely detached
        // mid-parse. Silent skip (normal lifecycle event).
        continue;
      }

      const frameId = `frame-${frameIndex++}`;
      this.frameRegistry.set(frameId, frame);

      try {
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
            frameId,
            frameUrl,
          });
        }
      } catch (err: any) {
        // frame.evaluate() threw — almost always a cross-origin security
        // error (Stripe Checkout iframe, OAuth provider, reCAPTCHA widget,
        // tracking pixels). The frame is registered but empty — users can
        // still interact via executeInFrame if they know the role+name
        // ahead of time, but widget discovery is blocked by same-origin
        // policy. Surface this so debugging "missing Stripe form" is easy.
        if (!/cross-?origin|blocked a frame|same-?origin/i.test(String(err?.message ?? ''))) {
          // Not a cross-origin error — swallow silently (detached, navigation)
          continue;
        }
        console.warn(
          `[StateParser] Cross-origin iframe skipped: ${frameUrl}\n` +
          `  → Elements inside are invisible to widget discovery (same-origin policy).\n` +
          `  → If you need to interact with it, target elements by role+name directly ` +
          `(frame context is auto-detected when the element's accessible name is known).`
        );
      }
    }

    return result;
  }

  // ─── Private: combined enrichment + region detection ─────────────────────

  /**
   * Single browser round-trip that both:
   *  1. Enriches generic element names with DOM context (headings, data-attrs)
   *  2. Assigns spatial region tags (header/nav/sidebar/main/footer/modal/popup)
   *
   * Merging these saves one full page.evaluate() call per parse (~100–200ms).
   */
  private async enrichAndDetectRegions(elements: UIElement[]): Promise<void> {
    if (elements.length === 0) return;

    const genericNamesArray = [...GENERIC_NAMES];
    const genericIds = new Set(
      elements.filter(e => isGenericName(e.name)).map(e => e.id)
    );

    const items = elements.map(e => ({
      id: e.id,
      x: e.boundingClientRect.x + e.boundingClientRect.width / 2,
      y: e.boundingClientRect.y + e.boundingClientRect.height / 2,
      needsContext: genericIds.has(e.id),
    }));

    const results: { id: number; context: string; region: string; error: string }[] = await this.page.evaluate(
      ({ items, genericNames }: {
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
            if (role === 'menu' || role === 'listbox' || role === 'tooltip' ||
                role === 'popup' || node.classList?.contains('popup') ||
                node.classList?.contains('dropdown') || node.classList?.contains('popover')) return 'popup';
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
                  alt.length > 1 && alt.length < 60 &&
                  !isGeneric(alt) &&
                  !/[/\\]|icon|logo|check|image|photo|pic|banner|avatar/i.test(alt)
                ) return alt;
              }
              return '';
            })();

            const heading = Array.from(
              container.querySelectorAll('h1, h2, h3, h4, strong, b')
            ).find(h => (h as HTMLElement).offsetParent !== null) ?? null;
            const headingText = heading?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

            const extraParts: string[] = [];
            for (const p of Array.from(container.querySelectorAll('p'))) {
              if ((p as HTMLElement).offsetParent === null) continue;
              const t = p.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (t.length > 2 && t.length < 60 && !isGeneric(t) &&
                  t !== headingText && !headingText.includes(t)) {
                extraParts.push(t);
                if (extraParts.length >= 2) break;
              }
            }

            for (const node of Array.from(container.querySelectorAll('span, div'))) {
              if (node.children.length > 0) continue;
              if ((node as HTMLElement).offsetParent === null) continue;
              const t = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (t.length > 2 && t.length < 35 && !isGeneric(t) &&
                  t !== headingText && !headingText.includes(t) &&
                  !extraParts.includes(t)) {
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
              const errId = node.getAttribute('aria-errormessage') ?? node.getAttribute('aria-describedby');
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
    ).catch(() => [] as { id: number; context: string; region: string; error: string }[]);

    const resultMap = new Map(results.map(r => [r.id, r]));
    for (const el of elements) {
      const data = resultMap.get(el.id);
      if (!data) continue;
      if (data.context) el.name = `${data.context}: ${el.name}`;
      if (data.region) el.region = data.region as PageRegion;
      if (data.error) el.error = data.error;
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
    let value: string | undefined;
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === 'disabled') state.disabled = prop.value.value;
        if (prop.name === 'hidden')   state.hidden   = prop.value.value;
        if (prop.name === 'focused')  state.focused  = prop.value.value;
        if (prop.name === 'checked')  state.checked  = prop.value.value;
      }
    }
    // Track input values for form fields
    if (VALUE_ROLES.has(role) && node.value?.value) {
      value = String(node.value.value);
    }

    return {
      id: counter.n++,
      role,
      name: effectiveName,
      description: description || (name ? subtextContext : ''),
      ...(value !== undefined ? { value } : {}),
      boundingClientRect: { x: 0, y: 0, width: 0, height: 0 },
      state,
    };
  }
}
