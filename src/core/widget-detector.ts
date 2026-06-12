import type { Page } from 'playwright';
import type { UIElement } from './state-parser.js';

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
export async function parseWidgetPatterns(page: Page, counter: { n: number }): Promise<UIElement[]> {
  const rawWidgets = await page
    .evaluate(() => {
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
        const rect =
          triggerRect.width >= 10 && triggerRect.height >= 10 ? triggerRect : container.getBoundingClientRect();
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
        const currentValue =
          (input as HTMLInputElement).value ||
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

        const name = htmlEl.getAttribute('aria-label') || htmlEl.textContent?.trim().slice(0, 80) || '';
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
          htmlEl.getAttribute('name') ||
          '';
        if (!name) continue;

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: 'combobox',
          name,
          value: htmlEl.value || undefined,
          x: rect.x + sx,
          y: rect.y + sy,
          width: rect.width,
          height: rect.height,
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

        const name = htmlEl.getAttribute('aria-label') || tabNames.join(' | ').slice(0, 80) || 'tabs';

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: 'tablist',
          name,
          value: activeTab ? (activeTab as HTMLElement).textContent?.trim() : undefined,
          x: rect.x + sx,
          y: rect.y + sy,
          width: rect.width,
          height: rect.height,
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
          htmlEl.getAttribute('name') ||
          '';
        if (!name) continue;

        const key = `${name}|${Math.round(rect.x + sx)}|${Math.round(rect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          role: htmlEl.type === 'time' ? 'timepicker' : 'datepicker',
          name,
          value: htmlEl.value || undefined,
          x: rect.x + sx,
          y: rect.y + sy,
          width: rect.width,
          height: rect.height,
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
          const name =
            (() => {
              // 1. Label via input id
              const inputEl = htmlEl.querySelector('input');
              if (inputEl?.id) {
                const label = findLabelFor(inputEl);
                if (label) return label.textContent?.trim();
              }
              // 2. aria-label on container or input
              const ariaLabel = htmlEl.getAttribute('aria-label') || inputEl?.getAttribute('aria-label');
              if (ariaLabel) return ariaLabel;
              // 3. Preceding label element
              const prev = htmlEl.previousElementSibling;
              if (prev?.tagName === 'LABEL') return (prev as HTMLElement).textContent?.trim();
              // 4. Label in parent (not inside this widget)
              const parentLabel = htmlEl.parentElement?.querySelector('label');
              if (parentLabel && !htmlEl.contains(parentLabel)) return (parentLabel as HTMLElement).textContent?.trim();
              // 5. Placeholder text (class-based)
              const placeholder = htmlEl.querySelector('[class*="placeholder"], [class*="Placeholder"]');
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
            x: rect.x + sx,
            y: rect.y + sy,
            width: rect.width,
            height: rect.height,
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
          htmlEl.getAttribute('name') ||
          '';
        if (!name) continue;

        const key = `${name}|${Math.round(containerRect.x + sx)}|${Math.round(containerRect.y + sy)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const selectedOption = htmlEl.options[htmlEl.selectedIndex];
        results.push({
          role: 'combobox',
          name,
          value: selectedOption?.text || undefined,
          x: containerRect.x + sx,
          y: containerRect.y + sy,
          width: containerRect.width,
          height: containerRect.height,
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

          const name =
            (() => {
              const inputEl = htmlEl.querySelector('input');
              if (inputEl?.id) {
                const label = findLabelFor(inputEl);
                if (label) return label.textContent?.trim();
              }
              return (
                htmlEl.getAttribute('aria-label') ||
                htmlEl.querySelector('input')?.getAttribute('placeholder') ||
                htmlEl.querySelector('input')?.getAttribute('aria-label') ||
                ''
              );
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
            x: rect.x + sx,
            y: rect.y + sy,
            width: rect.width,
            height: rect.height,
          });
        }
      } catch {
        // datepicker selector may fail on some pages
      }

      return results;
    })
    .catch(() => []);

  return rawWidgets.map((el: any) => ({
    id: counter.n++,
    role: el.role,
    name: el.name,
    ...(el.value ? { value: el.value } : {}),
    boundingClientRect: { x: el.x, y: el.y, width: el.width, height: el.height },
  }));
}
