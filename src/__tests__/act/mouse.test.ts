import { jest, describe, it, expect } from '@jest/globals';
import { moveMouse } from '../../api/act/mouse.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPage() {
  const moves: Array<{ x: number; y: number }> = [];
  const delays: number[] = [];
  const page = {
    mouse: {
      move: jest.fn(async (x: number, y: number) => {
        moves.push({ x, y });
      }),
    },
    waitForTimeout: jest.fn(async (ms: number) => {
      delays.push(ms);
    }),
  };
  return { page, moves, delays };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('moveMouse', () => {
  it('always lands exactly on the target coordinate', async () => {
    // The curve is randomised, but the endpoint must be deterministic —
    // a click issued after the move happens at wherever the cursor stopped.
    const { page, moves } = makeMockPage();
    await moveMouse(page as any, 10, 20, 400, 300);

    const last = moves.at(-1)!;
    expect(last.x).toBeCloseTo(400, 6);
    expect(last.y).toBeCloseTo(300, 6);
  });

  it('scales step count with distance, clamped to [8, 40]', async () => {
    const short = makeMockPage();
    await moveMouse(short.page as any, 0, 0, 5, 0); // 5px → below the floor
    expect(short.moves).toHaveLength(8);

    const medium = makeMockPage();
    await moveMouse(medium.page as any, 0, 0, 300, 0); // 300/15 = 20
    expect(medium.moves).toHaveLength(20);

    const long = makeMockPage();
    await moveMouse(long.page as any, 0, 0, 5000, 0); // way past the ceiling
    expect(long.moves).toHaveLength(40);
  });

  it('emits one delay per move, all within the documented envelope', async () => {
    const { page, moves, delays } = makeMockPage();
    await moveMouse(page as any, 0, 0, 200, 200);

    expect(delays).toHaveLength(moves.length);
    // delay = 4 + round(8 * sin(pi * t)) → 4 at the ends, up to 12 mid-path.
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(4);
      expect(d).toBeLessThanOrEqual(12);
    }
  });

  it('handles a zero-length move without producing NaN coordinates', async () => {
    // dist === 0 makes the perpendicular vector 0/0; the `|| 0` guards must
    // keep every emitted coordinate finite rather than NaN, which Playwright
    // would reject at the CDP boundary.
    const { page, moves } = makeMockPage();
    await moveMouse(page as any, 50, 50, 50, 50);

    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) {
      expect(Number.isFinite(m.x)).toBe(true);
      expect(Number.isFinite(m.y)).toBe(true);
    }
    expect(moves.at(-1)).toEqual({ x: 50, y: 50 });
  });

  it('produces a curved path, not a straight line', async () => {
    // The whole point of the Bézier is that the midpoint is displaced off the
    // straight line. Sample several runs so a single unlucky random draw
    // (control offsets can nearly cancel) does not flake the assertion.
    const deviations: number[] = [];
    for (let run = 0; run < 20; run++) {
      const { page, moves } = makeMockPage();
      await moveMouse(page as any, 0, 0, 400, 0);
      const mid = moves[Math.floor(moves.length / 2)]!;
      deviations.push(Math.abs(mid.y));
    }
    expect(Math.max(...deviations)).toBeGreaterThan(1);
  });

  it('moves monotonically toward the target without wild overshoot', async () => {
    const { page, moves } = makeMockPage();
    const target = { x: 300, y: 200 };
    await moveMouse(page as any, 0, 0, target.x, target.y);

    // A cubic Bézier with control points inside the span never strays further
    // from the target than the original distance.
    const startDistance = dist({ x: 0, y: 0 }, target);
    for (const m of moves) {
      expect(dist(m, target)).toBeLessThanOrEqual(startDistance * 1.5);
    }
  });
});
