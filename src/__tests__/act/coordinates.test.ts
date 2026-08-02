import { jest, describe, it, expect } from '@jest/globals';
import type { Page } from 'playwright';
import {
  documentCentroid,
  hasImpossibleCoordinates,
  isCoordinateMismatch,
  resolveViewportPoint,
  readLabelAtPoint,
} from '../../api/act/coordinates.js';
import type { UIElement } from '../../core/state-parser.js';

function element(x: number, y: number, width = 100, height = 40, name = 'Submit'): UIElement {
  return {
    id: 1,
    role: 'button',
    name,
    boundingClientRect: { x, y, width, height },
  } as UIElement;
}

/**
 * Page stub whose `evaluate` is driven by a queue of return values, so a test
 * can describe "the first scroll read says 0, the second says 500".
 */
function makePage(evaluateResults: unknown[], viewport = { width: 1000, height: 800 }) {
  const calls: unknown[] = [];
  const page = {
    evaluate: jest.fn(async (_fn: unknown, args?: unknown) => {
      calls.push(args);
      return evaluateResults.length > 0 ? evaluateResults.shift() : undefined;
    }),
    viewportSize: jest.fn(() => viewport),
    waitForTimeout: jest.fn(async () => {}),
  } as unknown as Page;
  return { page, calls };
}

describe('documentCentroid', () => {
  it('returns the middle of the bounding box', () => {
    expect(documentCentroid(element(10, 20, 100, 40))).toEqual({ x: 60, y: 40 });
  });
});

describe('hasImpossibleCoordinates', () => {
  it('accepts ordinary on-page coordinates', () => {
    expect(hasImpossibleCoordinates({ x: 60, y: 40 })).toBe(false);
  });

  it('accepts slightly negative coordinates (element just above the fold)', () => {
    expect(hasImpossibleCoordinates({ x: 60, y: -120 })).toBe(false);
  });

  it('rejects coordinates no scroll could reach', () => {
    // Booking.com's autocomplete reports y = -3184 for a re-parented element.
    expect(hasImpossibleCoordinates({ x: 60, y: -3184 })).toBe(true);
    expect(hasImpossibleCoordinates({ x: -2000, y: 40 })).toBe(true);
  });
});

describe('resolveViewportPoint', () => {
  it('subtracts the scroll offset', async () => {
    const { page } = makePage([{ x: 0, y: 300 }]);
    await expect(resolveViewportPoint(page, element(10, 420, 100, 40))).resolves.toEqual({
      x: 60,
      y: 140,
    });
  });

  it('scrolls the element into view when it starts outside the viewport', async () => {
    // 1st read: at origin (element at y=2000 is off-screen)
    // 2nd read: after scrollTo, offset lands the element in view
    const { page } = makePage([{ x: 0, y: 0 }, undefined, { x: 0, y: 1700 }]);
    const point = await resolveViewportPoint(page, element(10, 2000, 100, 40));
    expect(point).toEqual({ x: 60, y: 320 });
    expect(page.waitForTimeout).toHaveBeenCalled();
  });

  it('throws when the element stays unreachable after both scroll attempts', async () => {
    const { page } = makePage([
      { x: 0, y: 0 },
      undefined,
      { x: 0, y: 0 },
      undefined,
      { x: 0, y: 0 },
    ]);
    await expect(resolveViewportPoint(page, element(10, 90000, 100, 40))).rejects.toThrow(
      /outside viewport/
    );
  });

  it('treats a missing scroll offset as the origin rather than producing NaN', async () => {
    // A page whose evaluate returns something unexpected (a mock, an injected
    // stub, a page mid-navigation) must not yield NaN coordinates — those pass
    // every bounds comparison and then click nowhere.
    const { page } = makePage([[]]);
    const point = await resolveViewportPoint(page, element(10, 20, 100, 40));
    expect(point).toEqual({ x: 60, y: 40 });
    expect(Number.isNaN(point.x)).toBe(false);
    expect(Number.isNaN(point.y)).toBe(false);
  });

  it('treats a rejected scroll read as the origin', async () => {
    const page = {
      evaluate: jest.fn(async () => {
        throw new Error('execution context destroyed');
      }),
      viewportSize: jest.fn(() => ({ width: 1000, height: 800 })),
      waitForTimeout: jest.fn(async () => {}),
    } as unknown as Page;
    await expect(resolveViewportPoint(page, element(10, 20))).resolves.toEqual({ x: 60, y: 40 });
  });

  it('falls back to a default viewport when Playwright reports none', async () => {
    const { page } = makePage(
      [{ x: 0, y: 0 }],
      null as unknown as { width: number; height: number }
    );
    await expect(resolveViewportPoint(page, element(10, 20))).resolves.toEqual({ x: 60, y: 40 });
  });
});

describe('readLabelAtPoint', () => {
  it('returns an empty string when the evaluate rejects', async () => {
    const page = {
      evaluate: jest.fn(async () => {
        throw new Error('detached');
      }),
    } as unknown as Page;
    await expect(readLabelAtPoint(page, { x: 1, y: 1 })).resolves.toBe('');
  });
});

describe('isCoordinateMismatch', () => {
  it('is false when the names match exactly', () => {
    expect(isCoordinateMismatch('submit', 'Submit')).toBe(false);
  });

  it('is false when one name contains the other', () => {
    // Accessible names get truncated and decorated constantly.
    expect(isCoordinateMismatch('submit order', 'Submit')).toBe(false);
    expect(isCoordinateMismatch('submit', 'Submit order now')).toBe(false);
  });

  it('is true for genuinely different labels', () => {
    expect(isCoordinateMismatch('treibstoff', 'Motorleistung')).toBe(true);
  });

  it('is false for a technical container id', () => {
    // A radiogroup wrapper legitimately sits at a radio's coordinates.
    expect(isCoordinateMismatch('auto.fahrzeug.erstbesitzv-radiogroup', 'Ja')).toBe(false);
  });

  it('is false when either name is missing or too short', () => {
    expect(isCoordinateMismatch('', 'Submit')).toBe(false);
    expect(isCoordinateMismatch('ok', 'Submit')).toBe(false);
    expect(isCoordinateMismatch('submit', '')).toBe(false);
  });
});
