import type { Page } from 'playwright';

export interface DateParts {
  year: number;   // 0 = unset (time-only values)
  month: number;  // 1-12, 0 = unset
  day: number;    // 1-31, 0 = unset
  hour?: number;
  minute?: number;
}

/**
 * Parses a human-entered date/time string into its numeric parts. Supports:
 *  - ISO 8601: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`
 *  - European dot-notation: `DD.MM.YYYY`
 *  - Slash notation: `DD/MM/YYYY` (if day > 12) or `MM/DD/YYYY` (otherwise)
 *  - Time-only: `HH:mm`
 *  - Any format accepted by `Date.parse` as final fallback
 *    (e.g. `October 15, 2026`, `15 Oct 2026`)
 */
export function parseDateValue(value: string): DateParts | null {
  const s = value.trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s);
  if (iso) {
    const year = +iso[1]!, month = +iso[2]!, day = +iso[3]!;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const result: DateParts = { year, month, day };
      if (iso[4] !== undefined) result.hour = +iso[4];
      if (iso[5] !== undefined) result.minute = +iso[5];
      return result;
    }
  }

  const eu = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (eu) {
    const day = +eu[1]!, month = +eu[2]!, year = +eu[3]!;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }

  const sl = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (sl) {
    const a = +sl[1]!, b = +sl[2]!, year = +sl[3]!;
    // If first segment > 12, must be DD/MM; otherwise assume US MM/DD
    if (a > 12 && b <= 12) return { year, month: b, day: a };
    if (a <= 12 && b <= 31) return { year, month: a, day: b };
  }

  const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (timeOnly) {
    const hour = +timeOnly[1]!, minute = +timeOnly[2]!;
    if (hour <= 23 && minute <= 59) return { year: 0, month: 0, day: 0, hour, minute };
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return {
      year: parsed.getFullYear(),
      month: parsed.getMonth() + 1,
      day: parsed.getDate(),
      hour: parsed.getHours(),
      minute: parsed.getMinutes(),
    };
  }

  return null;
}

/** Formats DateParts into the ISO-like string expected by native typed inputs. */
export function formatNativeInputValue(type: string, parts: DateParts): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (type) {
    case 'date':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    case 'time':
      return `${pad(parts.hour ?? 0)}:${pad(parts.minute ?? 0)}`;
    case 'datetime-local':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour ?? 0)}:${pad(parts.minute ?? 0)}`;
    case 'month':
      return `${parts.year}-${pad(parts.month)}`;
    case 'week': {
      // ISO 8601 week number calculation (Thursday-of-week rule)
      const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `${d.getUTCFullYear()}-W${pad(weekNum)}`;
    }
    default:
      return '';
  }
}

/**
 * Strategy 3 helper: navigates an open calendar popup to the target month/year
 * and clicks the day cell. Locale-aware via `Intl.DateTimeFormat` on the page's
 * own declared locale (`<html lang>` / `navigator.language`) — no hardcoded
 * language tables. Navigation buttons are matched by multi-lingual aria-label
 * keywords first, then by header-row position (leftmost=prev, rightmost=next).
 *
 * Returns `true` if a day cell was clicked, `false` if navigation/clicking
 * failed after the bounded retry budget.
 */
export async function pickDateFromPopup(page: Page, parts: DateParts): Promise<boolean> {
  for (let attempt = 0; attempt < 36; attempt++) {
    const clicked = await page.evaluate(
      ({ year, month, day }: { year: number; month: number; day: number }) => {
        const locale = document.documentElement.lang || navigator.language || 'en-US';
        const target = new Date(year, month - 1, day);
        const candidates = new Set<string>();
        const safeFormat = (opts: Intl.DateTimeFormatOptions) => {
          try { return new Intl.DateTimeFormat(locale, opts).format(target); } catch { return ''; }
        };
        candidates.add(safeFormat({ year: 'numeric', month: 'long', day: 'numeric' }));
        candidates.add(safeFormat({ year: 'numeric', month: 'short', day: 'numeric' }));
        candidates.add(safeFormat({ year: 'numeric', month: '2-digit', day: '2-digit' }));
        candidates.add(safeFormat({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
        candidates.add(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        candidates.delete('');

        const roots = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"]:not([aria-hidden="true"]), [role="grid"]:not([aria-hidden="true"])'
        )).filter(el => el.offsetParent !== null);
        if (roots.length === 0) return false;
        const root = roots[roots.length - 1]!;

        const cells = Array.from(root.querySelectorAll<HTMLElement>(
          '[role="gridcell"], [role="button"], button, td[role], [data-day]'
        )).filter(c =>
          c.offsetParent !== null &&
          c.getAttribute('aria-disabled') !== 'true' &&
          !(c as HTMLButtonElement).disabled
        );

        // Pass 1: aria-label / title contains any locale-formatted candidate
        for (const cell of cells) {
          const label = cell.getAttribute('aria-label') || cell.getAttribute('title') || '';
          for (const cand of candidates) {
            if (cand && label.includes(cand)) { cell.click(); return true; }
          }
        }

        // Pass 2: text content == day number AND cell not in outside-month state
        const dayStr = String(day);
        for (const cell of cells) {
          const txt = cell.textContent?.trim();
          if (txt !== dayStr) continue;
          const cls = cell.className || '';
          if (/outside|other-?month|adjacent|different-?month/i.test(String(cls))) continue;
          if (cell.getAttribute('aria-selected') === 'false' &&
              cell.getAttribute('tabindex') === '-1' &&
              /disabled|muted/i.test(String(cls))) continue;
          cell.click();
          return true;
        }

        return false;
      },
      { year: parts.year, month: parts.month, day: parts.day }
    ).catch(() => false);

    if (clicked) return true;

    // Determine navigation direction by reading popup header
    const direction = await page.evaluate(
      ({ year, month }: { year: number; month: number }) => {
        const locale = document.documentElement.lang || navigator.language || 'en-US';
        const roots = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"]:not([aria-hidden="true"]), [role="grid"]:not([aria-hidden="true"])'
        )).filter(el => el.offsetParent !== null);
        if (roots.length === 0) return 0;
        const root = roots[roots.length - 1]!;
        const scope = root.parentElement || root;

        const headerEls = Array.from(scope.querySelectorAll<HTMLElement>(
          '[role="heading"], [aria-live], [class*="header"], [class*="caption"], [class*="title"], [class*="label"]'
        ));
        const headerText = (headerEls.map(e => e.textContent || '').join(' ') || scope.textContent || '').toLowerCase();

        let detectedMonth = 0;
        for (let m = 1; m <= 12; m++) {
          for (const style of ['long', 'short'] as const) {
            try {
              const name = new Intl.DateTimeFormat(locale, { month: style })
                .format(new Date(2000, m - 1, 1)).toLowerCase();
              if (name && name.length >= 3 && headerText.includes(name)) { detectedMonth = m; break; }
            } catch { /* locale unavailable */ }
          }
          if (detectedMonth) break;
        }
        const ym = /\b(19|20)\d{2}\b/.exec(headerText);
        const detectedYear = ym ? +ym[0] : 0;
        if (!detectedMonth || !detectedYear) return 0;

        const diff = (year - detectedYear) * 12 + (month - detectedMonth);
        if (diff > 0) return 1;
        if (diff < 0) return -1;
        return 0;
      },
      { year: parts.year, month: parts.month }
    ).catch(() => 0);

    if (direction === 0) return false;

    const navigated = await page.evaluate(
      ({ dir }: { dir: number }) => {
        const roots = Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"]:not([aria-hidden="true"]), [role="grid"]:not([aria-hidden="true"])'
        )).filter(el => el.offsetParent !== null);
        if (roots.length === 0) return false;
        const root = roots[roots.length - 1]!;
        const scope = root.parentElement || root;

        const btns = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]'))
          .filter(b => b.offsetParent !== null && !(b as HTMLButtonElement).disabled);
        if (btns.length === 0) return false;

        // Multi-lingual aria-label matching (best effort — covers common European languages)
        const prevPatterns = /prev|back|zur[uü]ck|vorig|vorherig|précédent|precedent|anterior|precedente|vorige|poprzedni|предыдущ/i;
        const nextPatterns = /next|nach|weiter|n[aä]chst|suivant|siguiente|successivo|proch|pr[oó]xim|volgende|nast[eę]pn|следующ/i;

        for (const btn of btns) {
          const label = btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '';
          if (dir > 0 && nextPatterns.test(label)) { btn.click(); return true; }
          if (dir < 0 && prevPatterns.test(label)) { btn.click(); return true; }
        }

        // Fallback: position-based. Header-row buttons (near top of popup):
        // leftmost = prev, rightmost = next.
        const topY = Math.min(...btns.map(b => b.getBoundingClientRect().top));
        const headerBtns = btns.filter(b => {
          const r = b.getBoundingClientRect();
          return r.top - topY < 40; // same header row
        });
        if (headerBtns.length >= 2) {
          headerBtns.sort((a, b) =>
            a.getBoundingClientRect().left - b.getBoundingClientRect().left
          );
          const picked = dir > 0 ? headerBtns[headerBtns.length - 1]! : headerBtns[0]!;
          picked.click();
          return true;
        }
        return false;
      },
      { dir: direction }
    ).catch(() => false);

    if (!navigated) return false;
    await page.waitForTimeout(200);
  }

  return false;
}
