import { jest, describe, it, expect } from '@jest/globals';
import { pickDateFromPopup } from '../../api/act/datepicker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// pickDateFromPopup runs three distinct page.evaluate probes per attempt —
// click-the-day, decide-direction, click-the-nav-button — inside a bounded
// 36-iteration loop. These tests drive that loop by scripting the probe results,
// which is where the termination guarantees live: an unbounded or non-advancing
// loop here would hang an agent run on any calendar it cannot navigate.

type ProbeKind = 'click' | 'direction' | 'navigate';

/**
 * Builds a page whose `evaluate` returns scripted values, cycling
 * click → direction → navigate for each loop iteration.
 */
function makeScriptedPage(script: {
  click: Array<boolean>;
  direction?: Array<number>;
  navigate?: Array<boolean>;
}) {
  const order: ProbeKind[] = [];
  let clickIdx = 0;
  let dirIdx = 0;
  let navIdx = 0;
  let phase: ProbeKind = 'click';

  const page = {
    evaluate: jest.fn(async (_fn?: unknown, _arg?: unknown) => {
      order.push(phase);
      if (phase === 'click') {
        const v = script.click[clickIdx++] ?? false;
        phase = v ? 'click' : 'direction';
        return v;
      }
      if (phase === 'direction') {
        const v = script.direction?.[dirIdx++] ?? 0;
        phase = 'navigate';
        return v;
      }
      const v = script.navigate?.[navIdx++] ?? false;
      phase = 'click';
      return v;
    }),
    waitForTimeout: jest.fn(async () => {}),
  };

  return { page, order, counts: () => ({ click: clickIdx, dir: dirIdx, nav: navIdx }) };
}

const parts = { year: 2026, month: 9, day: 15 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pickDateFromPopup', () => {
  it('returns true and stops immediately when the day cell is clicked on the first pass', async () => {
    const { page } = makeScriptedPage({ click: [true] });

    await expect(pickDateFromPopup(page as any, parts)).resolves.toBe(true);
    // Exactly one probe: no direction check, no navigation, no settle wait.
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('gives up when the calendar is already on the target month but has no matching cell', async () => {
    // direction === 0 means "we are on the right month" — clicking navigation
    // would just oscillate, so the loop must bail rather than burn 36 rounds.
    const { page, counts } = makeScriptedPage({ click: [false], direction: [0] });

    await expect(pickDateFromPopup(page as any, parts)).resolves.toBe(false);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(counts().nav).toBe(0);
  });

  it('gives up when no navigation button could be clicked', async () => {
    const { page } = makeScriptedPage({ click: [false], direction: [1], navigate: [false] });

    await expect(pickDateFromPopup(page as any, parts)).resolves.toBe(false);
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('navigates forward across months until the day cell appears', async () => {
    // Three months of navigation, then the cell is found on the fourth pass.
    const { page, order } = makeScriptedPage({
      click: [false, false, false, true],
      direction: [1, 1, 1],
      navigate: [true, true, true],
    });

    await expect(pickDateFromPopup(page as any, parts)).resolves.toBe(true);
    expect(order).toEqual([
      'click', 'direction', 'navigate',
      'click', 'direction', 'navigate',
      'click', 'direction', 'navigate',
      'click',
    ]);
    // One settle wait per successful navigation, none after the final click.
    expect(page.waitForTimeout).toHaveBeenCalledTimes(3);
  });

  it('navigates backward when the calendar is ahead of the target', async () => {
    const { page } = makeScriptedPage({
      click: [false, true],
      direction: [-1],
      navigate: [true],
    });

    await expect(pickDateFromPopup(page as any, parts)).resolves.toBe(true);
    // The direction value is what the nav probe receives; -1 must reach it.
    const navCall = page.evaluate.mock.calls[2];
    expect(navCall?.[1]).toEqual({ dir: -1 });
  });

  it('stops after 36 attempts when navigation always succeeds but never lands', async () => {
    // Worst case: a calendar that accepts every next-click but never renders the
    // target. Without the bound this is an infinite loop.
    const { page, counts } = makeScriptedPage({
      click: Array(50).fill(false),
      direction: Array(50).fill(1),
      navigate: Array(50).fill(true),
    });

    await expect(pickDateFromPopup(page as any, parts)).resolves.toBe(false);
    expect(counts().click).toBe(36);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(36);
  });

  it('passes the requested date through to the day-cell probe', async () => {
    const { page } = makeScriptedPage({ click: [true] });
    await pickDateFromPopup(page as any, parts);

    expect(page.evaluate.mock.calls[0]?.[1]).toEqual({ year: 2026, month: 9, day: 15 });
  });

  it('treats a rejected probe as "not found" rather than propagating', async () => {
    // Popups get torn down mid-probe; that must degrade to a false result, not
    // an exception escaping into the action engine.
    const page = {
      evaluate: jest.fn(async (_fn?: unknown, _arg?: unknown) => {
        throw new Error('Execution context was destroyed');
      }),
      waitForTimeout: jest.fn(async () => {}),
    };

    await expect(pickDateFromPopup(page as any, parts)).resolves.toBe(false);
  });
});
